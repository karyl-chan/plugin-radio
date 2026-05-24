import { unlink, readdir, rename, stat, writeFile } from "fs/promises";
import { join } from "path";
import { randomUUID, createHash } from "crypto";
import {
  canonicalSourceUrl,
  ensureMusicDir,
  getMusicDir,
} from "./downloader.js";
import { deleteCoverFor } from "./covers.js";
import { activeGuildIds, purgeTrackIdFromGuild } from "./queue.js";
import { withGuildLock } from "./guild-lock.js";
import { getDb } from "./db.js";

export interface LibraryTrack {
  id: string;
  filename: string;
  title: string;
  /** Editable metadata — optional, absent on tracks added before this feature. */
  album?: string;
  author?: string;
  /** Cover image URL (any http(s) image). */
  coverUrl?: string;
  sourceUrl: string;
  duration: number | null;
  addedBy: string;
  addedAt: number;
  sizeBytes: number | null;
}

/** Fields an admin may edit via the WebUI. */
export interface TrackMetadataPatch {
  title?: string;
  album?: string;
  author?: string;
  coverUrl?: string;
}

interface TrackRow {
  id: string;
  filename: string;
  title: string;
  album: string | null;
  author: string | null;
  cover_url: string | null;
  source_url: string;
  duration: number | null;
  added_by: string;
  added_at: number;
  size_bytes: number | null;
}

function rowToTrack(r: TrackRow): LibraryTrack {
  const t: LibraryTrack = {
    id: r.id,
    filename: r.filename,
    title: r.title,
    sourceUrl: r.source_url,
    duration: r.duration,
    addedBy: r.added_by,
    addedAt: r.added_at,
    sizeBytes: r.size_bytes,
  };
  if (r.album) t.album = r.album;
  if (r.author) t.author = r.author;
  if (r.cover_url) t.coverUrl = r.cover_url;
  return t;
}

export async function listTracks(): Promise<LibraryTrack[]> {
  const rows = getDb()
    .prepare("SELECT * FROM tracks ORDER BY added_at")
    .all() as TrackRow[];
  return rows.map(rowToTrack);
}

/**
 * Low-level insert — does NOT de-duplicate by source URL. Most call sites
 * should go through `uploadAndStore` (manager-uploaded private files);
 * this is left exported for tests / migrations / direct ingest.
 */
export async function addTrack(
  entry: Omit<LibraryTrack, "id">,
): Promise<LibraryTrack> {
  const id = randomUUID();
  getDb()
    .prepare(
      `INSERT INTO tracks (id, filename, title, album, author, cover_url,
                           source_url, duration, added_by, added_at, size_bytes)
       VALUES (@id, @filename, @title, @album, @author, @cover_url,
               @source_url, @duration, @added_by, @added_at, @size_bytes)`,
    )
    .run({
      id,
      filename: entry.filename,
      title: entry.title,
      album: entry.album ?? null,
      author: entry.author ?? null,
      cover_url: entry.coverUrl ?? null,
      source_url: entry.sourceUrl,
      duration: entry.duration,
      added_by: entry.addedBy,
      added_at: entry.addedAt,
      size_bytes: entry.sizeBytes,
    });
  return { id, ...entry };
}

export async function removeTrack(id: string): Promise<boolean> {
  const row = getDb()
    .prepare("SELECT filename FROM tracks WHERE id = ?")
    .get(id) as { filename: string } | undefined;
  if (!row) return false;
  // Unlink before the DB delete so a crash in between leaves the row
  // pointing at a missing file (which `syncWithDisk` reaps on next
  // boot) rather than orphaning the file with no row to find it.
  try {
    await unlink(join(getMusicDir(), row.filename));
  } catch {
    // file already gone
  }
  await deleteCoverFor(id);
  getDb().prepare("DELETE FROM tracks WHERE id = ?").run(id);
  // Drop any ghost references from playback queues so a now-missing
  // file doesn't sit un-playable in someone's queue. Goes through
  // each guild's `withGuildLock` so it can't race with the advance
  // loop's `peekNext → await voice.play → commitCursor` sequence —
  // an in-flight `commitCursor(idx)` from before the purge would
  // otherwise land on whatever shifted into that slot.
  await Promise.all(
    activeGuildIds().map((gid) =>
      withGuildLock(gid, async () => {
        purgeTrackIdFromGuild(gid, id);
      }),
    ),
  );
  return true;
}

export async function getTrack(id: string): Promise<LibraryTrack | null> {
  const row = getDb()
    .prepare("SELECT * FROM tracks WHERE id = ?")
    .get(id) as TrackRow | undefined;
  return row ? rowToTrack(row) : null;
}

/**
 * Case-insensitive substring search over title / album / author /
 * sourceUrl / filename. Empty query returns everything.
 */
export async function searchTracks(query: string): Promise<LibraryTrack[]> {
  const q = (query ?? "").trim();
  if (!q) return listTracks();
  const like = "%" + q.replace(/[\\%_]/g, (c) => "\\" + c) + "%";
  const rows = getDb()
    .prepare(
      `SELECT * FROM tracks
       WHERE title       LIKE ? ESCAPE '\\'
          OR album       LIKE ? ESCAPE '\\'
          OR author      LIKE ? ESCAPE '\\'
          OR source_url  LIKE ? ESCAPE '\\'
          OR filename    LIKE ? ESCAPE '\\'
       ORDER BY added_at`,
    )
    .all(like, like, like, like, like) as TrackRow[];
  return rows.map(rowToTrack);
}

/** Reject characters that break out of an HTML attribute when rendered. */
const URL_UNSAFE_CHARS = /["'<>\s\\]/;

function isSafeImageUrl(s: string): boolean {
  if (URL_UNSAFE_CHARS.test(s)) return false;
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return u.protocol === "http:" || u.protocol === "https:";
}

/**
 * Update editable metadata on a track. Unknown / empty patch fields are
 * ignored; an empty string clears that field. Returns the updated track
 * or null if the id is unknown. Throws on invalid input (caller maps to 400).
 */
export async function updateTrack(
  id: string,
  patch: TrackMetadataPatch,
): Promise<LibraryTrack | null> {
  const current = await getTrack(id);
  if (!current) return null;
  const next: LibraryTrack = { ...current };
  const setStr = (
    key: "title" | "album" | "author" | "coverUrl",
    max: number,
  ): void => {
    const v = patch[key];
    if (v === undefined) return;
    if (typeof v !== "string") throw new Error(`${key} must be a string`);
    const trimmed = v.trim();
    if (trimmed.length > max) throw new Error(`${key} too long (max ${max})`);
    if (key === "coverUrl" && trimmed && !isSafeImageUrl(trimmed)) {
      throw new Error("coverUrl must be a plain http(s) URL");
    }
    if (key === "title") {
      // Title can't be blanked — fall back to keeping the old one.
      if (trimmed) next.title = trimmed;
      return;
    }
    if (trimmed) next[key] = trimmed;
    else delete next[key];
  };
  setStr("title", 200);
  setStr("album", 200);
  setStr("author", 200);
  setStr("coverUrl", 500);
  getDb()
    .prepare(
      `UPDATE tracks
         SET title = @title, album = @album, author = @author, cover_url = @cover_url
       WHERE id = @id`,
    )
    .run({
      id,
      title: next.title,
      album: next.album ?? null,
      author: next.author ?? null,
      cover_url: next.coverUrl ?? null,
    });
  return next;
}

export async function findByFilename(
  filename: string,
): Promise<LibraryTrack | null> {
  const row = getDb()
    .prepare("SELECT * FROM tracks WHERE filename = ?")
    .get(filename) as TrackRow | undefined;
  return row ? rowToTrack(row) : null;
}

/**
 * Find a track that was downloaded from `url`. Comparison is on the
 * canonical form, so e.g. `https://youtu.be/X`, `…/watch?v=X&t=5` and
 * `…/watch?v=X` all match the same library entry — including entries
 * stored before URL canonicalization existed (their `sourceUrl` was
 * always a full `https://…` URL, so it canonicalizes the same way).
 */
export async function findBySourceUrl(
  url: string,
): Promise<LibraryTrack | null> {
  const target = canonicalSourceUrl(url);
  // Fast path: exact match (tracks added since canonicalization).
  const exact = getDb()
    .prepare("SELECT * FROM tracks WHERE source_url = ?")
    .get(target) as TrackRow | undefined;
  if (exact) return rowToTrack(exact);
  // Fallback: pre-canonical rows — canonicalize each candidate. This is
  // O(n) but only hits when the index missed.
  const rows = getDb().prepare("SELECT * FROM tracks").all() as TrackRow[];
  const match = rows.find((r) => canonicalSourceUrl(r.source_url) === target);
  return match ? rowToTrack(match) : null;
}

/**
 * Acceptable audio MIME types for manager uploads, mapped to the
 * extension we save under. The WebUI restricts the file picker to the
 * same set; the server re-validates so a hand-crafted upload can't
 * sneak past with a different extension.
 */
const UPLOAD_EXT_FOR_MIME: Record<string, string> = {
  "audio/ogg": "ogg",
  "audio/opus": "opus",
  "audio/mpeg": "mp3",
  "audio/mp3": "mp3",
  "audio/mp4": "m4a",
  "audio/x-m4a": "m4a",
  "audio/aac": "aac",
  "audio/flac": "flac",
  "audio/x-flac": "flac",
  "audio/wav": "wav",
  "audio/x-wav": "wav",
  "audio/webm": "webm",
};

export function extForAudioMime(mime: string): string | null {
  return UPLOAD_EXT_FOR_MIME[mime.toLowerCase()] ?? null;
}

/**
 * Save a manager-uploaded audio file into the library. The on-disk name
 * is a content hash so re-uploading the same bytes is idempotent (the
 * second call returns the existing row with `alreadyExisted: true`),
 * with no relevance to whatever name the browser sent.
 *
 * The cover URL is left empty — uploads have no thumbnail to inherit;
 * the manager can set one through the Edit modal afterwards.
 */
export async function uploadAndStore(opts: {
  data: Buffer;
  mime: string;
  title: string;
  album?: string;
  author?: string;
  addedBy: string;
}): Promise<{ track: LibraryTrack; alreadyExisted: boolean }> {
  const ext = extForAudioMime(opts.mime);
  if (!ext) {
    throw new Error(
      `Unsupported audio type "${opts.mime}" — accepts ogg/opus/mp3/m4a/aac/flac/wav/webm`,
    );
  }
  if (opts.data.length === 0) throw new Error("Empty file");
  const title = opts.title.trim();
  if (!title) throw new Error("Title required");

  await ensureMusicDir();
  const hash = createHash("sha256").update(opts.data).digest("hex").slice(0, 32);
  const filename = `upload-${hash}.${ext}`;
  // sourceUrl uses a stable `upload://<hash>` form so re-uploads dedupe
  // through the existing findBySourceUrl path (no separate by-hash index).
  const sourceUrl = `upload://${hash}`;
  const existing = await findBySourceUrl(sourceUrl);
  if (existing) return { track: existing, alreadyExisted: true };

  const finalPath = join(getMusicDir(), filename);
  // Two-step write: write to a tmp file then atomic-rename, so a crash
  // mid-write doesn't leave a half-file masquerading as a real upload
  // (which `syncWithDisk` would happily keep).
  const tmp = `${finalPath}.tmp`;
  await writeFile(tmp, opts.data);
  await rename(tmp, finalPath);

  const track = await addTrack({
    filename,
    title,
    ...(opts.album ? { album: opts.album } : {}),
    ...(opts.author ? { author: opts.author } : {}),
    sourceUrl,
    duration: null,
    addedBy: opts.addedBy,
    addedAt: Date.now(),
    sizeBytes: opts.data.length,
  });
  return { track, alreadyExisted: false };
}

/**
 * Reconcile the tracks table with what's on disk: drop rows whose audio
 * file has vanished, and refresh `size_bytes` for the survivors. Run
 * once on web-route registration so a manual file deletion doesn't leave
 * a ghost row that 404s on stream.
 */
export async function syncWithDisk(): Promise<void> {
  const dir = getMusicDir();
  const files = new Set(
    (await readdir(dir).catch(() => [] as string[])).filter(
      (f) => !f.endsWith(".tmp") && !f.endsWith(".migrated"),
    ),
  );
  const rows = getDb()
    .prepare("SELECT id, filename FROM tracks")
    .all() as Array<{ id: string; filename: string }>;
  const del = getDb().prepare("DELETE FROM tracks WHERE id = ?");
  const updateSize = getDb().prepare(
    "UPDATE tracks SET size_bytes = ? WHERE id = ?",
  );
  const survivors: Array<{ id: string; filename: string }> = [];
  const tx = getDb().transaction(() => {
    for (const r of rows) {
      if (!files.has(r.filename)) del.run(r.id);
      else survivors.push(r);
    }
  });
  tx();
  for (const r of survivors) {
    try {
      const s = await stat(join(dir, r.filename));
      updateSize.run(s.size, r.id);
    } catch {
      updateSize.run(null, r.id);
    }
  }
}
