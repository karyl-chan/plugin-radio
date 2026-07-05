/**
 * Shared voice-target resolution — "play wherever the caller is".
 *
 * Both the external control channel (`ext-routes.ts`, API-key auth) and
 * the WebUI personal page (`personal-routes.ts`, session-JWT auth) need
 * the same thing: a credential resolves to a single Discord user, but the
 * guild is not in the request path. It's resolved per request — an
 * explicit `guildId` in the body wins; otherwise the bot's `voice.locate`
 * reverse-lookup finds whichever voice channel the user is currently
 * sitting in. Extracted here so the two callers share one implementation
 * (and one set of 409 semantics) instead of duplicating it.
 */
import type { FastifyReply } from "fastify";
import { runtime } from "./runtime.js";

/** One voice.locate hit — where the user is currently sitting. */
export interface VoiceMatch {
  guildId: string;
  guildName?: string | null;
  channelId: string;
  channelName?: string | null;
}

/** Resolved playback target for a request. */
export interface Target {
  guildId: string;
  /** Set only when voice.locate pinned the exact channel. */
  channelId?: string;
}

/** Where is the user sitting right now? Returns the (possibly empty) list
 *  of voice channels across guilds the bot shares with them. Best-effort —
 *  a locate failure resolves to no matches. */
export async function locate(userId: string): Promise<VoiceMatch[]> {
  const res = (await runtime()
    .botRpc("/api/plugin/voice.locate", { user_id: userId })
    .catch(() => null)) as { matches?: VoiceMatch[] } | null;
  return Array.isArray(res?.matches)
    ? (res as { matches: VoiceMatch[] }).matches
    : [];
}

/**
 * Resolve which guild (and ideally channel) this request acts on.
 * Precedence: explicit body.guildId → the user's sole current VC.
 * Replies + returns null on failure so callers just `return`.
 */
export async function resolveTarget(
  userId: string,
  body: Record<string, unknown>,
  reply: FastifyReply,
): Promise<Target | null> {
  const explicit = typeof body.guildId === "string" ? body.guildId.trim() : "";
  if (explicit) return { guildId: explicit };
  const matches = await locate(userId);
  if (matches.length === 1) {
    return { guildId: matches[0].guildId, channelId: matches[0].channelId };
  }
  if (matches.length === 0) {
    reply.code(409).send({
      error: "You're not in a voice channel I can see — join one first.",
    });
    return null;
  }
  reply.code(409).send({
    error:
      "You're in voice channels on more than one server — pass `guildId` to pick one.",
    candidates: matches,
  });
  return null;
}

/** voice.join args: the locate-pinned channel if we have it, else let the
 *  bot resolve the user's current VC in this guild. */
export function joinArgs(target: Target, userId: string) {
  return target.channelId
    ? { guildId: target.guildId, channelId: target.channelId }
    : { guildId: target.guildId, userId };
}

/** Join voice; reply 409 + return false on failure. */
export async function joinOr409(
  target: Target,
  userId: string,
  reply: FastifyReply,
): Promise<boolean> {
  try {
    await runtime().voice.join(joinArgs(target, userId));
    return true;
  } catch {
    reply.code(409).send({ error: "Couldn't join your voice channel" });
    return false;
  }
}
