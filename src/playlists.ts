import { randomUUID } from "crypto";
import { activeGuildIds, purgePlaylistIdFromGuild } from "./queue.js";
import { withGuildLock } from "./guild-lock.js";
import { getDb } from "./db.js";

/**
 * User-curated playlists — an admin names a list and pastes / picks a
 * sequence of "source" strings (anything `/radio play` accepts: a
 * library track id, an external URL, a station key, …). At play time
 * each entry is resolved through the same dispatch as the slash
 * command, and the resulting Tracks are bulk-enqueued.
 *
 * Backed by the shared SQLite DB next to the audio files. `playlists`
 * holds metadata, `playlist_entries` holds ordered source strings.
 */

export interface Playlist {
  id: string;
  /** Trimmed display name. Case-insensitive unique across the store. */
  name: string;
  description?: string;
  /**
   * Ordered free-form source strings. Each is fed through
   * `resolveAnyTrack` at play time — entries that fail to resolve are
   * skipped, so a deleted library track or a dead URL doesn't break
   * the whole playlist.
   */
  entries: string[];
  /** Discord user id who created it. */
  createdBy: string;
  createdAt: number;
  updatedAt: number;
}

export interface PlaylistPatch {
  name?: string;
  description?: string;
  entries?: string[];
}

const MAX_NAME = 80;
const MAX_DESC = 500;
const MAX_ENTRY = 500;
const MAX_ENTRIES = 500;

interface PlaylistRow {
  id: string;
  name: string;
  description: string | null;
  created_by: string;
  created_at: number;
  updated_at: number;
}

function hydrate(row: PlaylistRow): Playlist {
  const entries = (
    getDb()
      .prepare(
        "SELECT value FROM playlist_entries WHERE playlist_id = ? ORDER BY position",
      )
      .all(row.id) as Array<{ value: string }>
  ).map((r) => r.value);
  const p: Playlist = {
    id: row.id,
    name: row.name,
    entries,
    createdBy: row.created_by,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.description) p.description = row.description;
  return p;
}

function normaliseName(s: string): string {
  return s.trim().toLowerCase();
}

function validateEntries(entries: unknown): string[] {
  if (!Array.isArray(entries)) throw new Error("entries must be an array");
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`Too many entries (max ${MAX_ENTRIES})`);
  }
  const out: string[] = [];
  for (const e of entries) {
    if (typeof e !== "string") throw new Error("Each entry must be a string");
    const trimmed = e.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_ENTRY) {
      throw new Error(`Entry too long (max ${MAX_ENTRY} chars)`);
    }
    out.push(trimmed);
  }
  return out;
}

function validateName(name: unknown, excludeId?: string): string {
  if (typeof name !== "string") throw new Error("name must be a string");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name is required");
  if (trimmed.length > MAX_NAME) {
    throw new Error(`name too long (max ${MAX_NAME})`);
  }
  const key = normaliseName(trimmed);
  const clash = getDb()
    .prepare(
      "SELECT name FROM playlists WHERE lower(name) = ? AND id IS NOT ? LIMIT 1",
    )
    .get(key, excludeId ?? null) as { name: string } | undefined;
  if (clash) throw new Error(`A playlist named "${clash.name}" already exists`);
  return trimmed;
}

function validateDescription(desc: unknown): string | undefined {
  if (desc === undefined) return undefined;
  if (typeof desc !== "string") throw new Error("description must be a string");
  const trimmed = desc.trim();
  if (!trimmed) return undefined;
  if (trimmed.length > MAX_DESC) {
    throw new Error(`description too long (max ${MAX_DESC})`);
  }
  return trimmed;
}

export async function listPlaylists(): Promise<Playlist[]> {
  const rows = getDb()
    .prepare("SELECT * FROM playlists ORDER BY created_at")
    .all() as PlaylistRow[];
  return rows.map(hydrate);
}

export async function getPlaylist(id: string): Promise<Playlist | null> {
  const row = getDb()
    .prepare("SELECT * FROM playlists WHERE id = ?")
    .get(id) as PlaylistRow | undefined;
  return row ? hydrate(row) : null;
}

/** Case-insensitive name lookup — the slash-command entry point. */
export async function findPlaylistByName(
  name: string,
): Promise<Playlist | null> {
  const key = normaliseName(name);
  if (!key) return null;
  const row = getDb()
    .prepare("SELECT * FROM playlists WHERE lower(name) = ? LIMIT 1")
    .get(key) as PlaylistRow | undefined;
  return row ? hydrate(row) : null;
}

function writeEntries(playlistId: string, entries: string[]): void {
  const db = getDb();
  db.prepare("DELETE FROM playlist_entries WHERE playlist_id = ?").run(
    playlistId,
  );
  const insert = db.prepare(
    "INSERT INTO playlist_entries (playlist_id, position, value) VALUES (?, ?, ?)",
  );
  for (let i = 0; i < entries.length; i++) insert.run(playlistId, i, entries[i]);
}

export async function addPlaylist(input: {
  name: string;
  description?: string;
  entries?: string[];
  createdBy: string;
}): Promise<Playlist> {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  const tx = db.transaction(() => {
    const name = validateName(input.name);
    const description = validateDescription(input.description);
    const entries = validateEntries(input.entries ?? []);
    db.prepare(
      `INSERT INTO playlists (id, name, description, created_by, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, name, description ?? null, input.createdBy, now, now);
    writeEntries(id, entries);
  });
  tx();
  return (await getPlaylist(id))!;
}

export async function updatePlaylist(
  id: string,
  patch: PlaylistPatch,
): Promise<Playlist | null> {
  const db = getDb();
  const exists = db
    .prepare("SELECT 1 AS x FROM playlists WHERE id = ?")
    .get(id);
  if (!exists) return null;
  const tx = db.transaction(() => {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      vals.push(validateName(patch.name, id));
    }
    if (patch.description !== undefined) {
      sets.push("description = ?");
      vals.push(validateDescription(patch.description) ?? null);
    }
    if (patch.entries !== undefined) {
      writeEntries(id, validateEntries(patch.entries));
    }
    sets.push("updated_at = ?");
    vals.push(Date.now());
    vals.push(id);
    db.prepare(`UPDATE playlists SET ${sets.join(", ")} WHERE id = ?`).run(
      ...vals,
    );
  });
  tx();
  return getPlaylist(id);
}

export async function removePlaylist(id: string): Promise<boolean> {
  // ON DELETE CASCADE on playlist_entries drops the rows; no manual cleanup.
  const info = getDb().prepare("DELETE FROM playlists WHERE id = ?").run(id);
  if (info.changes === 0) return false;
  // Drop any queue entries this playlist had pushed onto live sessions
  // so the deleted id doesn't sit there as dangling provenance. Run
  // through each guild's `withGuildLock` so we don't splice the
  // tracks array while the advance loop's mid-await `commitCursor`
  // still holds a stale index.
  await Promise.all(
    activeGuildIds().map((gid) =>
      withGuildLock(gid, async () => {
        purgePlaylistIdFromGuild(gid, id);
      }),
    ),
  );
  return true;
}
