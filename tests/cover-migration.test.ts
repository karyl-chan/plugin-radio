/**
 * Regression test for the v6 cover-URL migration (db.ts).
 *
 * Old builds stored uploaded covers as ABSOLUTE URLs — `${effectiveBase()}/
 * cover/<file>` — freezing the host at upload time. When the plugin's public
 * URL/proxy later changed (or effectiveBase() fell back to localhost), the
 * browser could no longer reach the baked host (ERR_CONNECTION_REFUSED). The
 * migration rewrites those to host-independent root-relative `/cover/<file>`
 * paths, while leaving external thumbnails and already-relative values alone.
 *
 * MUSIC_DIR is set (and a v5 DB pre-seeded) BEFORE importing db.js because it
 * captures the music dir at import time and migrates on first open.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";
import Database from "better-sqlite3";

const dir = mkdtempSync(join(tmpdir(), "radio-covermig-"));
process.env.MUSIC_DIR = dir;

// Pre-seed a v5 DB with the three cover-bearing tables (schemas match db.ts so
// the migrate() index/table statements apply cleanly) and a mix of rows.
{
  const raw = new Database(join(dir, "radio.db"));
  raw.pragma("user_version = 5");
  raw.exec(`
    CREATE TABLE tracks (
      id TEXT PRIMARY KEY, filename TEXT NOT NULL, title TEXT NOT NULL,
      album TEXT, author TEXT, cover_url TEXT, source_url TEXT NOT NULL,
      duration INTEGER, added_by TEXT NOT NULL, added_at INTEGER NOT NULL,
      size_bytes INTEGER
    );
    CREATE TABLE user_favorites (
      id TEXT PRIMARY KEY, owner_id TEXT NOT NULL, source TEXT NOT NULL,
      label TEXT NOT NULL, cover_url TEXT, added_at INTEGER NOT NULL
    );
    CREATE TABLE user_playlist_entries (
      playlist_id TEXT NOT NULL, position INTEGER NOT NULL, value TEXT NOT NULL,
      label TEXT, cover_url TEXT, PRIMARY KEY (playlist_id, position)
    );
  `);
  const tr = raw.prepare(
    "INSERT INTO tracks (id, filename, title, source_url, added_by, added_at, cover_url) VALUES (?, ?, ?, ?, ?, ?, ?)",
  );
  const mk = (id: string, cover: string): void => {
    tr.run(id, `${id}.mp3`, id, `https://src/${id}`, "u", 0, cover);
  };
  mk("t1", "http://localhost:903/cover/abc.jpg?v=123"); // localhost fallback
  mk("t2", "https://internal:8080/plugin/karyl-radio/cover/def.png"); // internal + path prefix
  mk("t3", "https://i.ytimg.com/vi/XYZ/hqdefault.jpg"); // external thumbnail
  mk("t4", "/cover/ghi.webp?v=9"); // already relative
  mk("t5", "http://host/cover/notimage.txt"); // /cover/ but not an image
  raw
    .prepare(
      "INSERT INTO user_favorites (id, owner_id, source, label, cover_url, added_at) VALUES (?, ?, ?, ?, ?, ?)",
    )
    .run("f1", "o", "s", "l", "http://localhost:903/cover/fav.gif", 0);
  raw
    .prepare(
      "INSERT INTO user_playlist_entries (playlist_id, position, value, cover_url) VALUES (?, ?, ?, ?)",
    )
    .run("p1", 0, "v", "http://localhost:903/cover/ent.jpeg?v=1");
  raw.close();
}

const { getDb } = await import("../src/db.js");

describe("cover-url v6 migration", () => {
  const db = getDb(); // opening triggers migrate()
  const covers = (table: string): Record<string, string | null> =>
    Object.fromEntries(
      (
        db
          .prepare(
            `SELECT ${table === "user_playlist_entries" ? "playlist_id" : "id"} AS k, cover_url AS v FROM ${table}`,
          )
          .all() as { k: string; v: string | null }[]
      ).map((r) => [r.k, r.v]),
    );

  it("bumps the schema version to 6", () => {
    expect(db.pragma("user_version", { simple: true })).toBe(6);
  });

  it("strips the baked host from our own /cover/ URLs (localhost fallback)", () => {
    expect(covers("tracks").t1).toBe("/cover/abc.jpg?v=123");
    expect(covers("user_favorites").f1).toBe("/cover/fav.gif");
    expect(covers("user_playlist_entries").p1).toBe("/cover/ent.jpeg?v=1");
  });

  it("strips an internal host AND its path prefix down to /cover/<file>", () => {
    expect(covers("tracks").t2).toBe("/cover/def.png");
  });

  it("leaves external thumbnails and already-relative covers untouched", () => {
    expect(covers("tracks").t3).toBe("https://i.ytimg.com/vi/XYZ/hqdefault.jpg");
    expect(covers("tracks").t4).toBe("/cover/ghi.webp?v=9");
  });

  it("does not rewrite a /cover/ URL whose tail isn't an image", () => {
    expect(covers("tracks").t5).toBe("http://host/cover/notimage.txt");
  });
});
