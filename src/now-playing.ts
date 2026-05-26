/**
 * The public "now playing" message.
 *
 * While a guild has an active playback session the plugin keeps one
 * public embed in the bot's voice-channel text chat: it shows the current
 * track, queue size and loop/pause state, and carries control buttons
 * (⏮ / ⏯ / ⏭ / ⏹ / 🔁) plus a "🎛 WebUI" link. It's edited in place on
 * every state change and deleted when the session ends (the bot leaves
 * voice, `/radio stop`, or the queue runs dry — the auto-advance loop's
 * idle/disconnect branches call `teardown` here).
 *
 * One message per guild. `sync()` is hash-gated so the 5 s advance-loop
 * tick only hits Discord's REST when the rendered content actually
 * changes (so a long radio stream causes no edits). The WebUI link
 * carries a 7-day `kind:"session"` token — long enough to outlast any
 * sane session; re-minted lazily if it ever gets close to expiry (which
 * also bumps the render hash, so the message picks up the fresh token).
 *
 * The `/radio np` reply reuses the same embed + buttons template, but
 * isn't tracked here — it's a standalone ephemeral message that only its
 * own buttons edit.
 */
import { createHash } from "node:crypto";
import type { APIEmbed, MessageActionRow } from "@karyl-chan/plugin-sdk";
import { PLUGIN_KEY } from "./constants.js";
import { runtime } from "./runtime.js";
import { nowPlayingComponents, renderNowPlayingEmbed } from "./format.js";

/** WebUI-link session token lifetime + how early to re-mint it. */
const TOKEN_TTL_MS = 7 * 24 * 60 * 60 * 1000;
const TOKEN_REFRESH_MARGIN_MS = 60 * 60 * 1000;

// Browser-reachable base URL for the WebUI link button. Wired from
// plugin.ts at module init (it imports `effectiveBase` from web-routes.ts)
// — done this way rather than importing web-routes.ts here, which would
// create a now-playing ↔ web-routes import cycle.
let _effectiveBase: () => string = () => "http://localhost:903";
/** Wire the browser-reachable base-URL getter (called once from plugin.ts). */
export function setEffectiveBaseGetter(fn: () => string): void {
  _effectiveBase = fn;
}

/** Voice-status fields `sync` needs (subset of the bot's voice.status). */
export interface VoiceStatusLike {
  connected?: boolean;
  channelId?: string | null;
  paused?: boolean;
}

interface MsgState {
  channelId: string;
  messageId: string;
  /** sha1 of the last-rendered { embed, components } — skip the edit when unchanged. */
  renderHash: string;
}
interface TokenState {
  token: string;
  expiresAt: number;
}

const messages = new Map<string, MsgState>();
const tokens = new Map<string, TokenState>();

/** Mint (or reuse) the guild's WebUI-link session token. */
async function getSessionToken(guildId: string): Promise<string | null> {
  const cached = tokens.get(guildId);
  if (cached && cached.expiresAt - Date.now() > TOKEN_REFRESH_MARGIN_MS) {
    return cached.token;
  }
  // auth.session has no typed wrapper in the SDK's `discord` / `voice`
  // facades yet — fall back to the raw botRpc surface.
  const res = (await runtime().botRpc("/api/plugin/auth.session", {
    // `kind:"session"` tokens ship no capabilities and are authorised
    // purely by the embedded guild_id, so the user_id is informational —
    // there's no real "owner" of the public message.
    user_id: `radio-np:${guildId}`,
    kind: "session",
    guild_id: guildId,
    ttl_ms: TOKEN_TTL_MS,
  }).catch(() => null)) as { token?: string; expiresAt?: number } | null;
  if (!res || typeof res.token !== "string") return null;
  tokens.set(guildId, {
    token: res.token,
    expiresAt:
      typeof res.expiresAt === "number"
        ? res.expiresAt
        : Date.now() + TOKEN_TTL_MS,
  });
  return res.token;
}

/** Render the embed + components + a content hash for change detection. */
function render(
  guildId: string,
  status: VoiceStatusLike,
  token: string | null,
): { embeds: APIEmbed[]; components: MessageActionRow[]; hash: string } {
  const embeds = [
    renderNowPlayingEmbed(guildId, {
      channelId: status.channelId ?? null,
      paused: !!status.paused,
    }),
  ];
  const webuiUrl = token ? `${_effectiveBase()}/?token=${token}` : null;
  const components = nowPlayingComponents(
    PLUGIN_KEY,
    guildId,
    { paused: !!status.paused },
    webuiUrl,
  );
  const hash = createHash("sha1")
    .update(JSON.stringify({ embeds, components }))
    .digest("hex");
  return { embeds, components, hash };
}

/**
 * Send-or-edit the guild's now-playing message to match current state.
 * Returns the rendered `{ embeds, components }` so a component handler
 * can hand it straight back for the bot to PATCH `@original` — or null
 * when there's no session to show a message for.
 *
 * `opts.status` — a pre-fetched voice.status, to avoid an extra RPC.
 * `opts.skipMessageId` — when a button click is being handled, the id of
 *   the message the click was on; if that's *our* message, we skip the
 *   `messages.edit` (the caller will PATCH it via the interaction token)
 *   but still update the cached hash.
 */
export async function sync(
  guildId: string,
  opts?: { status?: VoiceStatusLike; skipMessageId?: string },
): Promise<{ embeds: APIEmbed[]; components: MessageActionRow[] } | null> {
  let status = opts?.status ?? null;
  if (!status) {
    status = (await runtime()
      .voice.status(guildId)
      .catch(() => null)) as VoiceStatusLike | null;
  }
  if (!status || !status.connected || !status.channelId) {
    // Not in voice — there's no session to show; clean up any message.
    await teardown(guildId);
    return null;
  }
  const channelId = status.channelId;
  const token = await getSessionToken(guildId);
  const { embeds, components, hash } = render(guildId, status, token);
  const cur = messages.get(guildId);
  const discord = runtime().discord;

  // No message yet — send one.
  if (!cur) {
    const res = await discord.messages
      .send({ channelId, embeds, components })
      .catch(() => null);
    if (res?.id) messages.set(guildId, { channelId, messageId: res.id, renderHash: hash });
    return { embeds, components };
  }

  // Bot moved to a different channel — drop the old message, send fresh.
  if (cur.channelId !== channelId) {
    await discord.messages
      .delete({ channelId: cur.channelId, messageId: cur.messageId })
      .catch(() => null);
    const res = await discord.messages
      .send({ channelId, embeds, components })
      .catch(() => null);
    if (res?.id) messages.set(guildId, { channelId, messageId: res.id, renderHash: hash });
    else messages.delete(guildId);
    return { embeds, components };
  }

  // Same channel — edit if the content changed (and it isn't the message
  // the caller is about to PATCH itself).
  if (hash !== cur.renderHash) {
    if (cur.messageId === opts?.skipMessageId) {
      cur.renderHash = hash;
    } else {
      const res = await discord.messages
        .edit({ channelId, messageId: cur.messageId, embeds, components })
        .catch(() => null);
      if (res?.id) cur.renderHash = hash;
      else messages.delete(guildId); // edit failed (deleted?) — re-send next time
    }
  }
  return { embeds, components };
}

/** Delete the guild's now-playing message (if any) and forget its state. */
export async function teardown(guildId: string): Promise<void> {
  const cur = messages.get(guildId);
  messages.delete(guildId);
  tokens.delete(guildId);
  if (cur) {
    await runtime()
      .discord.messages.delete({ channelId: cur.channelId, messageId: cur.messageId })
      .catch(() => null);
  }
}

/** The guild's now-playing message location, if one is tracked. */
export function getMessage(
  guildId: string,
): { channelId: string; messageId: string } | null {
  const cur = messages.get(guildId);
  return cur ? { channelId: cur.channelId, messageId: cur.messageId } : null;
}
