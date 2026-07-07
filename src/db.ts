import Database, { type Database as DB } from "better-sqlite3";
import { existsSync, readFileSync, renameSync } from "fs";
import { join } from "path";
import { getMusicDir, ensureMusicDirSync } from "./downloader.js";

/**
 * SQLite store for library tracks and playlists.
 *
 * One DB file lives next to the audio files (so it shares the
 * `radio-music` volume and the same backup boundary). Opened lazily on
 * first use, then reused for the rest of the process.
 *
 * better-sqlite3 is synchronous and serialises writes internally; with
 * WAL we also get concurrent readers — that's why the JSON-era
 * `serialized()` promise-chain write lock is gone in the call sites.
 */

const DB_FILE = "radio.db";
const SCHEMA_VERSION = 6;

let db: DB | null = null;

export function getDb(): DB {
  if (db) return db;
  ensureMusicDirSync();
  const path = join(getMusicDir(), DB_FILE);
  const conn = new Database(path);
  conn.pragma("journal_mode = WAL");
  conn.pragma("foreign_keys = ON");
  conn.pragma("synchronous = NORMAL");
  conn.pragma("busy_timeout = 3000");
  migrate(conn);
  importLegacyJson(conn);
  db = conn;
  return conn;
}

function migrate(conn: DB): void {
  const current = (conn.pragma("user_version", { simple: true }) as number) || 0;
  if (current >= SCHEMA_VERSION) return;
  conn.exec(`
    CREATE TABLE IF NOT EXISTS tracks (
      id          TEXT PRIMARY KEY,
      filename    TEXT NOT NULL,
      title       TEXT NOT NULL,
      album       TEXT,
      author      TEXT,
      cover_url   TEXT,
      source_url  TEXT NOT NULL,
      duration    INTEGER,
      added_by    TEXT NOT NULL,
      added_at    INTEGER NOT NULL,
      size_bytes  INTEGER
    );
    CREATE INDEX IF NOT EXISTS tracks_source_url_idx ON tracks(source_url);
    CREATE INDEX IF NOT EXISTS tracks_filename_idx   ON tracks(filename);

    CREATE TABLE IF NOT EXISTS playlists (
      id          TEXT PRIMARY KEY,
      name        TEXT NOT NULL,
      description TEXT,
      created_by  TEXT NOT NULL,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS playlists_name_lower_idx
      ON playlists(lower(name));

    CREATE TABLE IF NOT EXISTS playlist_entries (
      playlist_id TEXT NOT NULL REFERENCES playlists(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL,
      value       TEXT NOT NULL,
      PRIMARY KEY (playlist_id, position)
    );

    -- v2: API keys for the external control channel (/api/ext/*). Each key
    -- is bound to a single Discord user (the security anchor — a key only
    -- ever lets the bot join *that* user's voice channel); the guild is
    -- resolved per-request (explicit guildId or voice.locate), never stored
    -- here. Only the sha256 of the plaintext is persisted.
    CREATE TABLE IF NOT EXISTS api_keys (
      id           TEXT PRIMARY KEY,
      key_hash     TEXT NOT NULL UNIQUE,
      user_id      TEXT NOT NULL,
      scopes       TEXT NOT NULL DEFAULT 'control',
      label        TEXT,
      created_at   INTEGER NOT NULL,
      last_used_at INTEGER,
      revoked      INTEGER NOT NULL DEFAULT 0
    );
    CREATE INDEX IF NOT EXISTS api_keys_user_idx ON api_keys(user_id);

    -- v3: per-user personal playlists. Structurally the same as the
    -- global \`playlists\` tables, but every row is owned by a single
    -- Discord user (\`owner_id\`) and the name uniqueness is per-owner
    -- (two users may both have a "favourites"), so the WebUI personal
    -- page (/me) can let ordinary members curate their own lists without
    -- the \`manage\` capability. Kept as a separate table so the shared,
    -- manager-owned \`playlists\` above are untouched.
    CREATE TABLE IF NOT EXISTS user_playlists (
      id          TEXT PRIMARY KEY,
      owner_id    TEXT NOT NULL,
      name        TEXT NOT NULL,
      description TEXT,
      created_at  INTEGER NOT NULL,
      updated_at  INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS user_playlists_owner_name_idx
      ON user_playlists(owner_id, lower(name));
    CREATE INDEX IF NOT EXISTS user_playlists_owner_idx
      ON user_playlists(owner_id);

    -- v5 adds \`label\` / \`cover_url\`: per-entry display metadata (title +
    -- cover) captured when the entry was added from a queue track that had
    -- it resolved, so re-queuing / previewing a stored playlist shows the
    -- real title + cover immediately instead of a bare page URL (URL
    -- entries otherwise resolve lazily and read as the raw link until
    -- played). Nullable — manually-pasted entries carry no cached meta.
    CREATE TABLE IF NOT EXISTS user_playlist_entries (
      playlist_id TEXT NOT NULL REFERENCES user_playlists(id) ON DELETE CASCADE,
      position    INTEGER NOT NULL,
      value       TEXT NOT NULL,
      label       TEXT,
      cover_url   TEXT,
      PRIMARY KEY (playlist_id, position)
    );

    -- v4: per-user favorites — a flat SET of "source" strings a member
    -- starred (a library track id, an http(s) URL, or a station key), each
    -- with a display label/cover captured at star time. Powers the ☆
    -- toggle on the player queue, the add-to-queue autocomplete, and the
    -- /me favorites tab. Owner-scoped like the playlists above; unordered
    -- (a set), so no side table.
    CREATE TABLE IF NOT EXISTS user_favorites (
      id         TEXT PRIMARY KEY,
      owner_id   TEXT NOT NULL,
      source     TEXT NOT NULL,
      label      TEXT NOT NULL,
      cover_url  TEXT,
      added_at   INTEGER NOT NULL
    );
    CREATE UNIQUE INDEX IF NOT EXISTS user_favorites_owner_source_idx
      ON user_favorites(owner_id, source);
    CREATE INDEX IF NOT EXISTS user_favorites_owner_idx
      ON user_favorites(owner_id);
  `);
  // v5: back-fill the per-entry meta columns onto an existing
  // \`user_playlist_entries\` (the CREATE IF NOT EXISTS above is a no-op when
  // the table already exists). Idempotent: a fresh DB already has them, so
  // the ADD COLUMN throws "duplicate column" — caught and ignored.
  if (current < 5) {
    for (const col of ["label TEXT", "cover_url TEXT"]) {
      try {
        conn.exec(`ALTER TABLE user_playlist_entries ADD COLUMN ${col}`);
      } catch {
        /* column already present (fresh DB) */
      }
    }
  }
  // v6 (data): earlier builds stored each uploaded cover as an ABSOLUTE URL —
  // `${effectiveBase()}/cover/<file>` — freezing the host at upload time. When
  // the plugin's public URL/proxy later changed (or effectiveBase() fell back
  // to `http://localhost:903`), the browser could no longer reach those baked
  // hosts (ERR_CONNECTION_REFUSED). Covers are now host-independent, root-
  // relative `/cover/<file>` paths; rewrite legacy absolute cover URLs to
  // match. Only touches our own `…/cover/<id>.<ext>` URLs — external thumbnails
  // (YouTube) and already-relative values don't match. Idempotent.
  if (current < 6) {
    const COVER_TAIL = /^[\w.-]+\.(?:jpe?g|png|webp|gif)(?:\?.*)?$/i;
    for (const table of [
      "tracks",
      "user_favorites",
      "user_playlist_entries",
    ]) {
      const rows = conn
        .prepare(
          `SELECT DISTINCT cover_url AS v FROM ${table} WHERE cover_url LIKE 'http%/cover/%'`,
        )
        .all() as { v: string }[];
      const upd = conn.prepare(
        `UPDATE ${table} SET cover_url = ? WHERE cover_url = ?`,
      );
      for (const { v } of rows) {
        const idx = v.lastIndexOf("/cover/");
        if (idx < 0) continue;
        const rel = v.slice(idx); // "/cover/<id>.<ext>?v=…"
        if (!COVER_TAIL.test(rel.slice("/cover/".length))) continue;
        upd.run(rel, v);
      }
    }
  }
  conn.pragma(`user_version = ${SCHEMA_VERSION}`);
}

/**
 * One-shot migration of the old library.json / playlists.json on first
 * boot after the SQLite switch. Each file is read, imported in a
 * transaction, then renamed `.migrated` so a re-run can't double-insert
 * and the original data is still on disk for safety.
 *
 * Only runs when the corresponding tables are still empty — once the DB
 * has data the JSON files (if any) are ignored on the assumption they
 * were left over from a previous version.
 */
function importLegacyJson(conn: DB): void {
  const dir = getMusicDir();
  // A malformed legacy file mustn't take the plugin down — log + skip
  // so the DB opens cleanly. The original JSON stays in place (no
  // rename) so the user can inspect and retry manually.
  try {
    importLegacyTracks(conn, join(dir, "library.json"));
  } catch (err) {
    console.error("[radio] library.json import failed; skipping:", err);
  }
  try {
    importLegacyPlaylists(conn, join(dir, "playlists.json"));
  } catch (err) {
    console.error("[radio] playlists.json import failed; skipping:", err);
  }
}

function importLegacyTracks(conn: DB, path: string): void {
  if (!existsSync(path)) return;
  const count = conn
    .prepare("SELECT COUNT(*) AS n FROM tracks")
    .get() as { n: number };
  if (count.n > 0) return;
  let parsed: { tracks?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return;
  }
  const tracks = Array.isArray(parsed.tracks) ? parsed.tracks : [];
  const insert = conn.prepare(`
    INSERT INTO tracks (id, filename, title, album, author, cover_url,
                        source_url, duration, added_by, added_at, size_bytes)
    VALUES (@id, @filename, @title, @album, @author, @cover_url,
            @source_url, @duration, @added_by, @added_at, @size_bytes)
  `);
  const tx = conn.transaction((rows: Array<Record<string, unknown>>) => {
    for (const r of rows) insert.run(r);
  });
  tx(
    tracks
      .filter((t): t is Record<string, unknown> => !!t && typeof t === "object")
      .map((t) => ({
        id: String(t.id),
        filename: String(t.filename),
        title: String(t.title),
        album: typeof t.album === "string" ? t.album : null,
        author: typeof t.author === "string" ? t.author : null,
        cover_url: typeof t.coverUrl === "string" ? t.coverUrl : null,
        source_url: String(t.sourceUrl),
        duration: typeof t.duration === "number" ? t.duration : null,
        added_by: String(t.addedBy),
        added_at: Number(t.addedAt) || Date.now(),
        size_bytes: typeof t.sizeBytes === "number" ? t.sizeBytes : null,
      })),
  );
  renameSync(path, path + ".migrated");
}

function importLegacyPlaylists(conn: DB, path: string): void {
  if (!existsSync(path)) return;
  const count = conn
    .prepare("SELECT COUNT(*) AS n FROM playlists")
    .get() as { n: number };
  if (count.n > 0) return;
  let parsed: { playlists?: unknown };
  try {
    parsed = JSON.parse(readFileSync(path, "utf-8"));
  } catch {
    return;
  }
  const playlists = Array.isArray(parsed.playlists) ? parsed.playlists : [];
  const insertPl = conn.prepare(`
    INSERT INTO playlists (id, name, description, created_by, created_at, updated_at)
    VALUES (@id, @name, @description, @created_by, @created_at, @updated_at)
  `);
  const insertEntry = conn.prepare(`
    INSERT INTO playlist_entries (playlist_id, position, value)
    VALUES (?, ?, ?)
  `);
  const tx = conn.transaction((rows: Array<Record<string, unknown>>) => {
    for (const r of rows) {
      insertPl.run({
        id: String(r.id),
        name: String(r.name),
        description: typeof r.description === "string" ? r.description : null,
        created_by: String(r.createdBy),
        created_at: Number(r.createdAt) || Date.now(),
        updated_at: Number(r.updatedAt) || Date.now(),
      });
      const entries = Array.isArray(r.entries) ? r.entries : [];
      for (let i = 0; i < entries.length; i++) {
        const v = entries[i];
        if (typeof v === "string") insertEntry.run(String(r.id), i, v);
      }
    }
  });
  tx(
    playlists.filter(
      (p): p is Record<string, unknown> => !!p && typeof p === "object",
    ),
  );
  renameSync(path, path + ".migrated");
}
