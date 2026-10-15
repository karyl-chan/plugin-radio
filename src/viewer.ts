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

/**
 * The bot's members.get / users.get append `&animated=true` to an animated
 * avatar URL so a caller can request the animated frame directly. Strip it
 * back to the still URL: `<UserAvatar animate="hover">` (the WebUI's chip)
 * expects a still `src` and re-adds the animated param itself only while
 * hovered. Leaving the bot's param on would make the avatar animate always.
 */
function stillAvatarUrl(url: string | null): string | null {
  if (!url) return null;
  return url
    .replace(/([?&])animated=true(?=&|$)/g, "$1")
    .replace(/\?&/, "?")
    .replace(/&&/g, "&")
    .replace(/[?&]$/, "");
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
    const member = await runtime()
      .discord.members.get({ guildId, userId: id })
      .catch(() => null);
    if (member) {
      return {
        id,
        displayName: member.displayName,
        avatarUrl: stillAvatarUrl(member.avatarUrl),
      };
    }
  }

  const user = await runtime()
    .discord.users.get({ userId: id })
    .catch(() => null);
  if (user) {
    return {
      id,
      displayName: user.displayName || user.username || id,
      avatarUrl: stillAvatarUrl(user.avatarUrl),
    };
  }
  return null;
}
