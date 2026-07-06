import { randomUUID } from "crypto";
import { getDb } from "./db.js";

/**
 * Per-user personal playlists — the private, self-service sibling of the
 * shared `playlists.ts` store. An ordinary Discord member (no `manage`
 * capability) curates their own named lists on the WebUI personal page
 * (`/me`); each list is a sequence of "source" strings, exactly as the
 * global playlists (anything `/radio play` accepts: a station key, an
 * external URL, a track title). At play time each entry is resolved
 * through the same dispatch as the slash command and bulk-enqueued.
 *
 * Every row is owned by a single Discord user (`owner_id`), and every
 * query is scoped to that owner — a user can only ever see or mutate
 * their own lists (the same ownership discipline `api-keys.ts` uses).
 * Name uniqueness is per-owner, not global: two users may each have a
 * playlist named "favourites".
 *
 * Backed by the `user_playlists` / `user_playlist_entries` tables (see
 * `db.ts`, schema v3), kept separate from the manager-owned `playlists`.
 */

/**
 * One playlist entry: a free-form `source` string (a station key, an
 * external URL, or a library track title/id — anything `resolveAnyTrack`
 * accepts) plus optional display metadata captured when the entry was
 * added from an already-resolved queue track. The cached `label`/`coverUrl`
 * let the WebUI show the real title + cover for a URL entry immediately —
 * without them a URL resolves lazily and reads as the raw link until it's
 * actually played (see `resolveEntriesToTracks`). Manually-pasted entries
 * carry no meta and fall back to that lazy resolution.
 */
export interface PlaylistEntry {
  source: string;
  label?: string;
  coverUrl?: string;
}

/** What the API accepts for an entry: a bare source, or one with cached meta. */
export type PlaylistEntryInput = string | PlaylistEntry;

export interface UserPlaylist {
  id: string;
  /** Discord user id who owns it — the access anchor for every query. */
  ownerId: string;
  /** Trimmed display name. Case-insensitive unique *per owner*. */
  name: string;
  description?: string;
  /**
   * Ordered entries. Each `source` is fed through `resolveAnyTrack` at
   * play time — entries that fail to resolve are skipped, so a dead URL
   * doesn't break the whole playlist.
   */
  entries: PlaylistEntry[];
  createdAt: number;
  updatedAt: number;
}

export interface UserPlaylistPatch {
  name?: string;
  description?: string;
  entries?: PlaylistEntryInput[];
}

const MAX_NAME = 80;
const MAX_DESC = 500;
const MAX_ENTRY = 500;
const MAX_ENTRIES = 500;
const MAX_LABEL = 300;
const MAX_COVER = 1000;

interface UserPlaylistRow {
  id: string;
  owner_id: string;
  name: string;
  description: string | null;
  created_at: number;
  updated_at: number;
}

function hydrate(row: UserPlaylistRow): UserPlaylist {
  const entries = (
    getDb()
      .prepare(
        "SELECT value, label, cover_url FROM user_playlist_entries WHERE playlist_id = ? ORDER BY position",
      )
      .all(row.id) as Array<{
      value: string;
      label: string | null;
      cover_url: string | null;
    }>
  ).map((r) => {
    const e: PlaylistEntry = { source: r.value };
    if (r.label) e.label = r.label;
    if (r.cover_url) e.coverUrl = r.cover_url;
    return e;
  });
  const p: UserPlaylist = {
    id: row.id,
    ownerId: row.owner_id,
    name: row.name,
    entries,
    createdAt: row.created_at,
    updatedAt: row.updated_at,
  };
  if (row.description) p.description = row.description;
  return p;
}

function normaliseName(s: string): string {
  return s.trim().toLowerCase();
}

/** Best-effort meta string: trim, drop empties, cap length (never throws —
 *  cached title/cover is decorative, so a too-long one is truncated, not
 *  rejected). Returns undefined when there's nothing usable. */
function cleanMeta(v: unknown, max: number): string | undefined {
  if (typeof v !== "string") return undefined;
  const trimmed = v.trim();
  if (!trimmed) return undefined;
  return trimmed.length > max ? trimmed.slice(0, max) : trimmed;
}

function validateEntries(entries: unknown): PlaylistEntry[] {
  if (!Array.isArray(entries)) throw new Error("entries must be an array");
  if (entries.length > MAX_ENTRIES) {
    throw new Error(`Too many entries (max ${MAX_ENTRIES})`);
  }
  const out: PlaylistEntry[] = [];
  for (const e of entries) {
    // Accept a bare source string or an object carrying cached display meta.
    const raw = typeof e === "string" ? { source: e } : e;
    if (!raw || typeof raw !== "object" || typeof raw.source !== "string") {
      throw new Error("Each entry must be a source string or { source } object");
    }
    const trimmed = raw.source.trim();
    if (!trimmed) continue;
    if (trimmed.length > MAX_ENTRY) {
      throw new Error(`Entry too long (max ${MAX_ENTRY} chars)`);
    }
    const entry: PlaylistEntry = { source: trimmed };
    const label = cleanMeta((raw as PlaylistEntry).label, MAX_LABEL);
    const coverUrl = cleanMeta((raw as PlaylistEntry).coverUrl, MAX_COVER);
    if (label) entry.label = label;
    if (coverUrl) entry.coverUrl = coverUrl;
    out.push(entry);
  }
  return out;
}

/** Per-owner name-uniqueness check (unlike global playlists' cross-user one). */
function validateName(
  ownerId: string,
  name: unknown,
  excludeId?: string,
): string {
  if (typeof name !== "string") throw new Error("name must be a string");
  const trimmed = name.trim();
  if (!trimmed) throw new Error("name is required");
  if (trimmed.length > MAX_NAME) {
    throw new Error(`name too long (max ${MAX_NAME})`);
  }
  const key = normaliseName(trimmed);
  const clash = getDb()
    .prepare(
      "SELECT name FROM user_playlists WHERE owner_id = ? AND lower(name) = ? AND id IS NOT ? LIMIT 1",
    )
    .get(ownerId, key, excludeId ?? null) as { name: string } | undefined;
  if (clash) {
    throw new Error(`You already have a playlist named "${clash.name}"`);
  }
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

export async function listUserPlaylists(
  ownerId: string,
): Promise<UserPlaylist[]> {
  const rows = getDb()
    .prepare("SELECT * FROM user_playlists WHERE owner_id = ? ORDER BY created_at")
    .all(ownerId) as UserPlaylistRow[];
  return rows.map(hydrate);
}

export async function getUserPlaylist(
  id: string,
  ownerId: string,
): Promise<UserPlaylist | null> {
  const row = getDb()
    .prepare("SELECT * FROM user_playlists WHERE id = ? AND owner_id = ?")
    .get(id, ownerId) as UserPlaylistRow | undefined;
  return row ? hydrate(row) : null;
}

function writeEntries(playlistId: string, entries: PlaylistEntry[]): void {
  const db = getDb();
  db.prepare("DELETE FROM user_playlist_entries WHERE playlist_id = ?").run(
    playlistId,
  );
  const insert = db.prepare(
    "INSERT INTO user_playlist_entries (playlist_id, position, value, label, cover_url) VALUES (?, ?, ?, ?, ?)",
  );
  for (let i = 0; i < entries.length; i++) {
    const e = entries[i];
    insert.run(playlistId, i, e.source, e.label ?? null, e.coverUrl ?? null);
  }
}

export async function addUserPlaylist(input: {
  ownerId: string;
  name: string;
  description?: string;
  entries?: PlaylistEntryInput[];
}): Promise<UserPlaylist> {
  const db = getDb();
  const id = randomUUID();
  const now = Date.now();
  const tx = db.transaction(() => {
    const name = validateName(input.ownerId, input.name);
    const description = validateDescription(input.description);
    const entries = validateEntries(input.entries ?? []);
    db.prepare(
      `INSERT INTO user_playlists (id, owner_id, name, description, created_at, updated_at)
       VALUES (?, ?, ?, ?, ?, ?)`,
    ).run(id, input.ownerId, name, description ?? null, now, now);
    writeEntries(id, entries);
  });
  tx();
  return (await getUserPlaylist(id, input.ownerId))!;
}

export async function updateUserPlaylist(
  id: string,
  ownerId: string,
  patch: UserPlaylistPatch,
): Promise<UserPlaylist | null> {
  const db = getDb();
  const exists = db
    .prepare("SELECT 1 AS x FROM user_playlists WHERE id = ? AND owner_id = ?")
    .get(id, ownerId);
  if (!exists) return null;
  const tx = db.transaction(() => {
    const sets: string[] = [];
    const vals: unknown[] = [];
    if (patch.name !== undefined) {
      sets.push("name = ?");
      vals.push(validateName(ownerId, patch.name, id));
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
    vals.push(ownerId);
    db.prepare(
      `UPDATE user_playlists SET ${sets.join(", ")} WHERE id = ? AND owner_id = ?`,
    ).run(...vals);
  });
  tx();
  return getUserPlaylist(id, ownerId);
}

export async function removeUserPlaylist(
  id: string,
  ownerId: string,
): Promise<boolean> {
  // ON DELETE CASCADE on user_playlist_entries drops the rows. No queue
  // purge (unlike global playlists): a personal Play copies resolved
  // Tracks into the guild queue and forgets the list, so a delete never
  // needs to reach into a live session.
  const info = getDb()
    .prepare("DELETE FROM user_playlists WHERE id = ? AND owner_id = ?")
    .run(id, ownerId);
  return info.changes > 0;
}
