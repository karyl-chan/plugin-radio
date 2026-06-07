/**
 * API keys for the external control channel (`/api/ext/*`).
 *
 * Unlike the manage tokens (in-memory HMAC, wiped on restart) and the
 * bot's session JWTs (short-lived), these are long-lived credentials a
 * third party (a browser extension, Stream Deck, a shortcut) stores and
 * presents to drive playback. So they persist in `radio.db` and survive
 * the frequent rebuild/redeploy cycle.
 *
 * A key is bound to exactly one Discord `user_id` — the security anchor.
 * The key authorises "make the bot join *this* user's voice channel and
 * control their session"; it deliberately does NOT let the caller name an
 * arbitrary user. The guild is never stored on the key: it's resolved per
 * request (an explicit guildId, or the bot's `voice.locate` reverse
 * lookup), so one key works across every server the user shares with the
 * bot.
 *
 * Only the sha256 of the plaintext is persisted. The plaintext
 * (`rk_<base64url(32 bytes)>`) is returned once at creation and never
 * recoverable — losing it means minting a new key.
 */

import { randomUUID, randomBytes, createHash } from "crypto";
import { getDb } from "./db.js";

/** Scopes a key can carry. `read` → status only; `control` → playback. */
export type ApiKeyScope = "read" | "control";
const VALID_SCOPES: readonly ApiKeyScope[] = ["read", "control"];

/** Plaintext key prefix — `r`adio `k`ey. Lets a leak be grep'd / revoked. */
const KEY_PREFIX = "rk_";

export interface ApiKeyRecord {
  id: string;
  userId: string;
  scopes: ApiKeyScope[];
  label: string | null;
  createdAt: number;
  lastUsedAt: number | null;
  revoked: boolean;
}

interface ApiKeyRow {
  id: string;
  key_hash: string;
  user_id: string;
  scopes: string;
  label: string | null;
  created_at: number;
  last_used_at: number | null;
  revoked: number;
}

function hashKey(plaintext: string): string {
  return createHash("sha256").update(plaintext).digest("hex");
}

/** Normalise + validate a requested scope list, defaulting to `control`. */
export function normalizeScopes(input: unknown): ApiKeyScope[] {
  if (input === undefined || input === null) return ["control"];
  const raw = Array.isArray(input) ? input : [input];
  const out: ApiKeyScope[] = [];
  for (const v of raw) {
    if (typeof v === "string" && VALID_SCOPES.includes(v as ApiKeyScope)) {
      if (!out.includes(v as ApiKeyScope)) out.push(v as ApiKeyScope);
    }
  }
  if (out.length === 0) return ["control"];
  return out;
}

function rowToRecord(row: ApiKeyRow): ApiKeyRecord {
  return {
    id: row.id,
    userId: row.user_id,
    scopes: row.scopes
      .split(",")
      .map((s) => s.trim())
      .filter((s): s is ApiKeyScope => VALID_SCOPES.includes(s as ApiKeyScope)),
    label: row.label,
    createdAt: row.created_at,
    lastUsedAt: row.last_used_at,
    revoked: row.revoked === 1,
  };
}

/**
 * Mint a fresh key for `userId`. Returns the record plus the one-time
 * plaintext — show it to the user once; only its hash is stored.
 */
export function issueKey(input: {
  userId: string;
  label?: string | null;
  scopes?: ApiKeyScope[];
}): { record: ApiKeyRecord; plaintext: string } {
  const scopes: ApiKeyScope[] =
    input.scopes && input.scopes.length ? input.scopes : ["control"];
  const id = randomUUID();
  const plaintext = KEY_PREFIX + randomBytes(32).toString("base64url");
  const now = Date.now();
  const label = input.label?.trim() || null;
  getDb()
    .prepare(
      `INSERT INTO api_keys (id, key_hash, user_id, scopes, label, created_at, last_used_at, revoked)
       VALUES (?, ?, ?, ?, ?, ?, NULL, 0)`,
    )
    .run(id, hashKey(plaintext), input.userId, scopes.join(","), label, now);
  return {
    record: {
      id,
      userId: input.userId,
      scopes,
      label,
      createdAt: now,
      lastUsedAt: null,
      revoked: false,
    },
    plaintext,
  };
}

/**
 * Verify a presented plaintext key. Returns the resolved identity +
 * scopes on success, or null (unknown / revoked / malformed). Bumps
 * `last_used_at` on a hit. Lookup is by hash, so there's no plaintext
 * comparison to time-attack.
 */
export function verifyKey(
  plaintext: unknown,
): { keyId: string; userId: string; scopes: ApiKeyScope[] } | null {
  if (typeof plaintext !== "string" || !plaintext.startsWith(KEY_PREFIX)) {
    return null;
  }
  const row = getDb()
    .prepare("SELECT * FROM api_keys WHERE key_hash = ? AND revoked = 0")
    .get(hashKey(plaintext)) as ApiKeyRow | undefined;
  if (!row) return null;
  getDb()
    .prepare("UPDATE api_keys SET last_used_at = ? WHERE id = ?")
    .run(Date.now(), row.id);
  const rec = rowToRecord(row);
  return { keyId: rec.id, userId: rec.userId, scopes: rec.scopes };
}

/** List a user's keys (newest first). Never exposes hashes/plaintext. */
export function listKeys(userId: string): ApiKeyRecord[] {
  const rows = getDb()
    .prepare(
      "SELECT * FROM api_keys WHERE user_id = ? AND revoked = 0 ORDER BY created_at DESC",
    )
    .all(userId) as ApiKeyRow[];
  return rows.map(rowToRecord);
}

/**
 * Revoke a key. Scoped to `userId` so a manager can only revoke their own
 * keys (the WebUI manage token's identity). Returns true if a row was
 * actually flipped.
 */
export function revokeKey(id: string, userId: string): boolean {
  const res = getDb()
    .prepare("UPDATE api_keys SET revoked = 1 WHERE id = ? AND user_id = ? AND revoked = 0")
    .run(id, userId);
  return res.changes > 0;
}
