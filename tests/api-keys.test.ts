/**
 * Unit tests for the external-control API key store. Exercises the
 * issue → verify round-trip, revocation, scope normalisation, and the
 * per-user revoke guard, against a throwaway sqlite file.
 *
 * MUSIC_DIR is set before the dynamic import because db.ts (via
 * downloader.ts) captures it into a module-level const at import time —
 * a static import would bind the default /app/data path first.
 */
import { describe, expect, it } from "vitest";
import { mkdtempSync } from "fs";
import { tmpdir } from "os";
import { join } from "path";

process.env.MUSIC_DIR = mkdtempSync(join(tmpdir(), "radio-apikeys-"));

const { issueKey, verifyKey, listKeys, revokeKey, normalizeScopes } =
  await import("../src/api-keys.js");

describe("api-keys", () => {
  it("issues a prefixed plaintext and verifies it back to the same user", () => {
    const { record, plaintext } = issueKey({ userId: "user-1", label: "ext" });
    expect(plaintext.startsWith("rk_")).toBe(true);
    expect(record.userId).toBe("user-1");
    expect(record.scopes).toEqual(["control"]);
    expect(record.revoked).toBe(false);

    const v = verifyKey(plaintext);
    expect(v).not.toBeNull();
    expect(v?.userId).toBe("user-1");
    expect(v?.keyId).toBe(record.id);
    expect(v?.scopes).toEqual(["control"]);
  });

  it("rejects an unknown / malformed plaintext", () => {
    expect(verifyKey("rk_totally-made-up")).toBeNull();
    expect(verifyKey("no-prefix")).toBeNull();
    expect(verifyKey(123 as unknown)).toBeNull();
  });

  it("stops verifying once revoked, and hides revoked keys from the list", () => {
    const { record, plaintext } = issueKey({ userId: "user-2" });
    expect(verifyKey(plaintext)).not.toBeNull();

    expect(revokeKey(record.id, "user-2")).toBe(true);
    expect(verifyKey(plaintext)).toBeNull();
    expect(listKeys("user-2").find((k) => k.id === record.id)).toBeUndefined();
  });

  it("won't let one user revoke another user's key", () => {
    const { record, plaintext } = issueKey({ userId: "owner" });
    expect(revokeKey(record.id, "attacker")).toBe(false);
    // Still valid for the real owner.
    expect(verifyKey(plaintext)).not.toBeNull();
  });

  it("records last_used_at only after a successful verify", () => {
    const { record, plaintext } = issueKey({ userId: "user-3" });
    expect(listKeys("user-3").find((k) => k.id === record.id)?.lastUsedAt).toBeNull();
    verifyKey(plaintext);
    expect(
      listKeys("user-3").find((k) => k.id === record.id)?.lastUsedAt,
    ).toBeTypeOf("number");
  });

  it("persists and round-trips a custom scope set", () => {
    const { plaintext } = issueKey({ userId: "user-4", scopes: ["read"] });
    expect(verifyKey(plaintext)?.scopes).toEqual(["read"]);
  });

  it("normalizeScopes defaults to control and drops unknowns/dupes", () => {
    expect(normalizeScopes(undefined)).toEqual(["control"]);
    expect(normalizeScopes([])).toEqual(["control"]);
    expect(normalizeScopes(["read", "read", "bogus"])).toEqual(["read"]);
    expect(normalizeScopes(["read", "control"])).toEqual(["read", "control"]);
  });
});
