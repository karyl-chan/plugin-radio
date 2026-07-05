import { randomUUID } from "crypto";
import { getDb } from "./db.js";

/**
 * Per-user favorites — a flat SET of "source" strings a member starred
 * (the same free-form source `/radio play` accepts: a library track id, an
 * http(s) URL, or a station key), each with a display label + cover
 * captured at star time so the favorites list / autocomplete render
 * without re-resolving. Owner-scoped like `user-playlists.ts`; a set (no
 * ordering), so it's a single table with no entries side-table.
 *
 * The `source` is exactly the key the WebUI computes per queue item
 * (`track.trackId ?? track.sourceUrl`), so the ☆ filled/empty state is a
 * plain membership check and re-queuing a favorite feeds `source` straight
 * back through `resolveAnyTrack`.
 */

export interface UserFavorite {
  id: string;
  ownerId: string;
  source: string;
  label: string;
  coverUrl?: string;
  addedAt: number;
}

const MAX_SOURCE = 500;
const MAX_LABEL = 200;
const MAX_COVER = 500;

interface UserFavoriteRow {
  id: string;
  owner_id: string;
  source: string;
  label: string;
  cover_url: string | null;
  added_at: number;
}

function hydrate(row: UserFavoriteRow): UserFavorite {
  const f: UserFavorite = {
    id: row.id,
    ownerId: row.owner_id,
    source: row.source,
    label: row.label,
    addedAt: row.added_at,
  };
  if (row.cover_url) f.coverUrl = row.cover_url;
  return f;
}

function normSource(input: unknown): string {
  if (typeof input !== "string") throw new Error("source must be a string");
  const s = input.trim();
  if (!s) throw new Error("source is required");
  if (s.length > MAX_SOURCE) {
    throw new Error(`source too long (max ${MAX_SOURCE})`);
  }
  return s;
}

function normLabel(input: unknown, fallback: string): string {
  const s = typeof input === "string" ? input.trim() : "";
  return (s || fallback).slice(0, MAX_LABEL);
}

function normCover(input: unknown): string | null {
  if (typeof input !== "string") return null;
  const s = input.trim();
  return s ? s.slice(0, MAX_COVER) : null;
}

/** A user's favorites, newest first. */
export function listUserFavorites(ownerId: string): UserFavorite[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM user_favorites WHERE owner_id = ? ORDER BY added_at DESC",
    )
    .all(ownerId) as UserFavoriteRow[];
  return rows.map(hydrate);
}

export function getUserFavorite(
  id: string,
  ownerId: string,
): UserFavorite | null {
  const row = getDb()
    .prepare("SELECT * FROM user_favorites WHERE id = ? AND owner_id = ?")
    .get(id, ownerId) as UserFavoriteRow | undefined;
  return row ? hydrate(row) : null;
}

/**
 * Toggle a favorite: remove it if the (owner, source) already exists, else
 * add it. Returns the resulting starred state (and the new row when added).
 * The insert/delete pair runs in one transaction so a double-click can't
 * race into a duplicate or a half-toggle.
 */
export function toggleUserFavorite(input: {
  ownerId: string;
  source: string;
  label?: string;
  coverUrl?: string;
}): { starred: boolean; favorite?: UserFavorite } {
  const db = getDb();
  const source = normSource(input.source);
  const tx = db.transaction(
    (): { starred: boolean; favorite?: UserFavorite } => {
      const existing = db
        .prepare("SELECT id FROM user_favorites WHERE owner_id = ? AND source = ?")
        .get(input.ownerId, source) as { id: string } | undefined;
      if (existing) {
        db.prepare("DELETE FROM user_favorites WHERE id = ?").run(existing.id);
        return { starred: false };
      }
      const id = randomUUID();
      const now = Date.now();
      const label = normLabel(input.label, source);
      const coverUrl = normCover(input.coverUrl);
      db.prepare(
        `INSERT INTO user_favorites (id, owner_id, source, label, cover_url, added_at)
         VALUES (?, ?, ?, ?, ?, ?)`,
      ).run(id, input.ownerId, source, label, coverUrl, now);
      return {
        starred: true,
        favorite: hydrate({
          id,
          owner_id: input.ownerId,
          source,
          label,
          cover_url: coverUrl,
          added_at: now,
        }),
      };
    },
  );
  return tx();
}

/** Remove a favorite by id (scoped to owner). Returns true if a row went. */
export function removeUserFavorite(id: string, ownerId: string): boolean {
  const info = getDb()
    .prepare("DELETE FROM user_favorites WHERE id = ? AND owner_id = ?")
    .run(id, ownerId);
  return info.changes > 0;
}
