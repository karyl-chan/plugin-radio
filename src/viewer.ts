import { runtime } from "./runtime.js";

/**
 * "Logged-in as" identity for the WebUI.
 *
 * A WebUI link carries a bot-signed token whose `userId` tells us who is
 * looking:
 *   - A token from an EPHEMERAL surface (a `/radio np|play|queue` reply,
 *     or the `/radio me` link) carries the real Discord user id — that's
 *     an identified, "logged-in" viewer.
 *   - The token on the PUBLIC now-playing embed button carries a synthetic
 *     `radio-np:<guildId>` id (see now-playing.ts) — anyone in the channel
 *     can open it, so it's an anonymous public viewer with no identity.
 *
 * `resolveViewer` turns a real id into a display name + avatar for the
 * top-right indicator, and returns null for the anonymous case.
 */

export interface ViewerProfile {
  id: string;
  displayName: string;
  avatarUrl: string | null;
}

/** Synthetic userId prefix minted onto the public now-playing token
 *  (now-playing.ts). A token carrying it is an anonymous public viewer. */
export const NP_SYNTHETIC_PREFIX = "radio-np:";

/** True when a token's userId is absent or the synthetic public-embed id. */
export function isAnonymousViewer(userId: string | null | undefined): boolean {
  return !userId || userId.startsWith(NP_SYNTHETIC_PREFIX);
}

/**
 * Resolve a token's `userId` into a display profile, or null when the
 * viewer is anonymous (public now-playing token) or can't be resolved.
 * Prefers the guild member projection (nickname + per-guild avatar) when
 * a `guildId` is known, falling back to the global user (used by the
 * guildless `/me` page). Best-effort — any RPC failure resolves to null.
 */
export async function resolveViewer(
  userId: string | null | undefined,
  guildId: string | null,
): Promise<ViewerProfile | null> {
  if (isAnonymousViewer(userId)) return null;
  const id = userId as string;

  if (guildId) {
    const res = (await runtime()
      .botRpc("/api/plugin/members.get", { guild_id: guildId, user_ids: [id] })
      .catch(() => null)) as { members?: Array<Record<string, unknown>> } | null;
    const m = res?.members?.find((x) => x.userId === id);
    if (m && typeof m.displayName === "string") {
      return {
        id,
        displayName: m.displayName,
        avatarUrl: typeof m.avatarUrl === "string" ? m.avatarUrl : null,
      };
    }
  }

  const res = (await runtime()
    .botRpc("/api/plugin/users.get", { user_ids: [id] })
    .catch(() => null)) as { users?: Array<Record<string, unknown>> } | null;
  const u = res?.users?.find((x) => x.userId === id);
  if (u) {
    const displayName =
      typeof u.displayName === "string"
        ? u.displayName
        : typeof u.username === "string"
          ? u.username
          : id;
    return {
      id,
      displayName,
      avatarUrl: typeof u.avatarUrl === "string" ? u.avatarUrl : null,
    };
  }
  return null;
}
