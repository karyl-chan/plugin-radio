import {
  type APIEmbed,
  type CommandContext,
  type CommandReply,
  type ComponentContext,
  type ComponentReply,
  type MessageActionRow,
  definePlugin,
  definePluginCapability,
  definePluginCommand,
  definePluginComponent,
  defineGuildFeature,
} from "@karyl-chan/plugin-sdk";
import {
  type LoopMode,
  type Track,
  DEFAULT_AUTOPLAY_FETCH_COUNT,
  MAX_AUTOPLAY_FETCH_COUNT,
  clearQueue,
  commitCursor,
  enqueue,
  getState,
  peekNext,
  removeTrackAt,
  setAutoplay,
  setAutoplayFetchCount,
  setLoop,
} from "./queue.js";
import { withGuildLock } from "./guild-lock.js";
import {
  EMBED_COLOR,
  formatQueueList,
  formatStationList,
  loopBadge,
  nowPlayingComponents,
  renderNowPlayingEmbed,
} from "./format.js";
import {
  cycleLoopMode,
  doNext,
  doPause,
  doPrev,
  doStop,
} from "./playback-actions.js";
import * as nowPlaying from "./now-playing.js";
import { PLUGIN_KEY } from "./constants.js";
import {
  isYouTubePlaylistUrl,
  isYouTubeUrlWithList,
} from "./downloader.js";
import {
  effectiveBase,
  registerWebRoutes,
  setPublicUrlEnvFallback,
  setRadioBotRpc,
  setRadioPublicBaseUrl,
  setRadioSessionVerifyKey,
} from "./web-routes.js";
import {
  type PlayOutcome,
  playTrack,
  resolveAnyTrack,
  resolvePlaylist,
  resolveStoredPlaylist,
} from "./resolver.js";

/** Guilds the auto-advance loop ticks over. The SAME Set instance is
 *  threaded into `startAdvanceLoop` (via index.ts) and `registerWebRoutes`
 *  — re-creating it elsewhere would silently break auto-advance. The
 *  `/radio` command handler and the WebUI session routes both `.add()`
 *  here; `processGuild` `.delete()`s when a guild's session goes idle. */
export const seenGuilds = new Set<string>();

/** `/radio` subcommands that don't mutate playback state — they skip the
 *  per-guild lock (so a read-only `/radio np` isn't held up behind a slow
 *  `/radio play`). */
const LOCK_FREE_SUBS = new Set([
  "stations",
  "manage",
  "np",
  "queuelist",
]);

/** Env-var fallback for the browser-reachable base URL. Only used when the
 *  bot hasn't yet returned a publicBaseUrl (pre-register or no WEB_BASE_URL). */
const RADIO_PUBLIC_URL_ENV = process.env.RADIO_PUBLIC_URL
  ? process.env.RADIO_PUBLIC_URL.replace(/\/+$/, "")
  : undefined;

// Propagate env fallback into web-routes.ts at module init time so
// effectiveBase() can use it before any SDK wiring happens, and hand the
// now-playing message manager the same base-URL getter (importing it there
// directly would create a now-playing ↔ web-routes cycle).
setPublicUrlEnvFallback(RADIO_PUBLIC_URL_ENV);
nowPlaying.setEffectiveBaseGetter(effectiveBase);

type BotRpcFn = (path: string, body?: unknown) => Promise<unknown | null>;

// ── Session WebUI link ────────────────────────────────────────────────────
// Each play/queue/etc response (and /radio np) carries a Link button to
// the session WebUI. The URL embeds a 6h bot-signed JWT scoped to this
// guild's playback session; we cache it per guild and re-mint when <30 min
// remain. (The public now-playing message uses its own longer-lived token
// — see now-playing.ts — so its button outlasts the whole session.)
interface CachedToken {
  token: string;
  expiresAt: number;
}
const SESSION_TOKEN_REFRESH_MARGIN_MS = 30 * 60_000;
const sessionTokens = new Map<string, CachedToken>();

async function getSessionToken(
  botRpc: BotRpcFn,
  userId: string,
  guildId: string,
): Promise<string | null> {
  const cached = sessionTokens.get(guildId);
  if (
    cached &&
    cached.expiresAt - Date.now() > SESSION_TOKEN_REFRESH_MARGIN_MS
  ) {
    return cached.token;
  }
  const res = (await botRpc("/api/plugin/auth.session", {
    user_id: userId,
    kind: "session",
    guild_id: guildId,
  })) as { token?: string; expiresAt?: number } | null;
  if (!res || typeof res.token !== "string") return null;
  sessionTokens.set(guildId, {
    token: res.token,
    expiresAt: typeof res.expiresAt === "number" ? res.expiresAt : Date.now(),
  });
  return res.token;
}

/** WebUI session URL for a guild, or null if a token couldn't be minted. */
async function webuiUrlFor(
  botRpc: BotRpcFn,
  userId: string,
  guildId: string,
): Promise<string | null> {
  const token = await getSessionToken(botRpc, userId, guildId);
  return token ? `${effectiveBase()}/?token=${token}` : null;
}

/** Discord component-v1 action row with a single Link button. */
function linkButtonRow(label: string, url: string): MessageActionRow {
  return {
    type: 1,
    components: [{ type: 2, style: 5, label, url }],
  } as MessageActionRow;
}

/**
 * Refresh the public now-playing message after a state change — best
 * effort; never let a Discord hiccup break the command/loop that called
 * it. `opts.skipMessageId` lets a button handler tell `sync` "I'll PATCH
 * that message myself via the interaction token" so it isn't edited
 * twice.
 */
function syncNowPlaying(
  guildId: string,
  botRpc: BotRpcFn,
  opts?: { status?: nowPlaying.VoiceStatusLike; skipMessageId?: string },
): Promise<{ embeds: APIEmbed[]; components: MessageActionRow[] } | null> {
  return nowPlaying.sync(guildId, botRpc, opts).catch(() => null);
}

/**
 * Build a playback-command reply: an embed + a "🎛 Open WebUI" link
 * button to the session page. Falls back to a plain embed (no button)
 * if a session token couldn't be minted.
 */
async function playbackReply(
  ctx: CommandContext,
  guildId: string,
  embed: Record<string, unknown>,
): Promise<CommandReply> {
  const url = await webuiUrlFor(ctx.botRpc, ctx.userId, guildId);
  const components = url ? [linkButtonRow("🎛 Open WebUI", url)] : undefined;
  // Ephemeral: plugin command replies are deferred ephemeral by the bot,
  // and the button embeds a session token — keep it visible only to the
  // ManageGuild member who invoked it.
  return {
    embeds: [{ color: EMBED_COLOR, ...embed }],
    ...(components ? { components } : {}),
    ephemeral: true,
  };
}

/** Resolve (if lazy) + play `track` on the bot. Caller `setCurrent`s on ok. */
function startTrack(
  ctx: CommandContext,
  guildId: string,
  track: Track,
): Promise<PlayOutcome> {
  // Lockdown L-2: typed voice facade. The internal `playTrack` helper
  // still takes a "play(url) → Promise" closure so the rest of the
  // radio call graph (advance-loop, playback-actions) stays unchanged
  // — we just bridge it to ctx.voice.play at this top edge.
  return playTrack(track, (url) =>
    ctx.voice.play({ guildId, url }),
  );
}

/**
 * `/radio play` shared tail for any multi-track source (YouTube
 * playlist URL, stored playlist, …): clearQueue, bulk-enqueue, then try
 * to start the first resolvable track in a 5-attempt loop. Returns the
 * track that actually started, or null if nothing did (caller decides
 * how to phrase the reply).
 *
 * Callers have already done `joinFirst()` and stamped \`queuedByName\` on
 * each track; everything here is "what /radio play does once we have
 * the expanded Track[] and a voice connection".
 */
async function playBulk(
  ctx: CommandContext,
  guildId: string,
  tracks: Track[],
): Promise<Track | null> {
  clearQueue(guildId);
  for (const t of tracks) enqueue(guildId, t);
  let started: Track | null = null;
  for (let i = 0; i < 5 && !started; i++) {
    const candidate = peekNext(guildId);
    if (!candidate) break;
    const o = await startTrack(ctx, guildId, candidate.track);
    if (o.ok) {
      commitCursor(guildId, candidate.idx);
      started = o.track;
    } else if (o.reason === "play-failed") {
      break; // cursor unchanged; advance loop will retry
    } else {
      removeTrackAt(guildId, candidate.idx);
    }
  }
  return started;
}

function parseSource(ctx: CommandContext): string {
  return typeof ctx.options.source === "string" ? ctx.options.source : "";
}

/**
 * Resolve a `/radio play|queue` source to a Track, or return an error
 * string the handler should reply with. (Wraps web-routes' resolveAnyTrack
 * — which can throw for failed YouTube extraction.)
 */
async function resolveSourceOrError(
  source: string,
  userId: string,
): Promise<Track | string> {
  let track: Track | null;
  try {
    track = await resolveAnyTrack(source, userId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "extraction failed";
    return `⚠ Couldn't load that source — ${msg.slice(0, 180)}`;
  }
  if (!track) return `⚠ Unknown station / library track / URL: \`${source}\``;
  return track;
}

// ── Now-playing message control buttons ───────────────────────────────────
// The ⏮ / ⏯ / ⏭ / ⏹ / 🔁 buttons on the public now-playing message (and
// on /radio np) all flow through here. Only members currently in the
// bot's voice channel may use them — others get an ephemeral nudge. After
// the action we PATCH the message the button was on (by returning the
// re-rendered embed) and `sync` the public message if it's a different one.

type ControlAction = "prev" | "pause" | "next" | "stop" | "loop" | "autoplay";

function controlHandler(
  action: ControlAction,
): (ctx: ComponentContext) => Promise<ComponentReply> {
  return async (ctx): Promise<ComponentReply> => {
    const guildId = ctx.guildId;
    if (!guildId) return; // buttons only live on guild messages
    const nudge = (content: string): Promise<unknown | null> =>
      ctx.discord.interactions
        .followup({
          interactionToken: ctx.interactionToken,
          content,
          ephemeral: true,
        })
        .catch(() => null);

    const status = await ctx.voice.status(guildId).catch(() => null);
    if (!status || !status.connected || !status.channelId) {
      await nudge("⚠ 我已經不在語音頻道了，這個面板已失效。");
      return;
    }
    if (ctx.voiceChannelId !== status.channelId) {
      await nudge(`⚠ 你要先加入 <#${status.channelId}> 才能控制播放。`);
      return;
    }

    // Serialize with the advance loop / `/radio` commands (see guild-lock.ts).
    return withGuildLock(guildId, async (): Promise<ComponentReply> => {
      seenGuilds.add(guildId);

      if (action === "stop") {
        await doStop(guildId, ctx.botRpc);
        sessionTokens.delete(guildId);
        const onPublicMessage =
          nowPlaying.getMessage(guildId)?.messageId === ctx.messageId;
        await nowPlaying.teardown(guildId, ctx.botRpc).catch(() => {});
        // The public message is now deleted — if the click was on it there's
        // nothing left to PATCH; if it was on a /radio np message, leave a notice.
        return onPublicMessage
          ? undefined
          : {
              embeds: [
                { color: EMBED_COLOR, description: "⏹ 已停止播放並離開語音頻道。" },
              ],
              components: [],
            };
      }

      let paused = status.paused === true;
      if (action === "next") {
        const r = await doNext(guildId, ctx.botRpc);
        if (r.kind === "queue-empty") {
          // Queue drained — playback stopped. Tear the panel down rather
          // than leave a "nothing playing" card with live buttons. (Check
          // whether this click was on that very message *before* teardown
          // forgets it.)
          const onPublicMessage =
            nowPlaying.getMessage(guildId)?.messageId === ctx.messageId;
          await nowPlaying.teardown(guildId, ctx.botRpc).catch(() => {});
          return onPublicMessage
            ? undefined
            : {
                embeds: [
                  {
                    color: EMBED_COLOR,
                    description: "⏹ 佇列播完了，已停止播放。",
                  },
                ],
                components: [],
              };
        }
        paused = false; // a fresh voice.play isn't paused
      } else if (action === "prev") {
        await doPrev(guildId, ctx.botRpc);
        paused = false;
      } else if (action === "pause") {
        ({ paused } = await doPause(guildId, ctx.botRpc));
      } else if (action === "loop") {
        const cur: LoopMode = getState(guildId)?.loop ?? "off";
        setLoop(guildId, cycleLoopMode(cur));
      } else if (action === "autoplay") {
        setAutoplay(guildId, !(getState(guildId)?.autoplay ?? false));
      }

      const reply = await syncNowPlaying(guildId, ctx.botRpc, {
        status: { connected: true, channelId: status.channelId, paused },
        skipMessageId: ctx.messageId,
      });
      return reply ?? undefined;
    });
  };
}

export default function buildPlugin() {
  return definePlugin({
    key: PLUGIN_KEY,
    name: "Karyl Radio",
    version: "0.7.1",
    description:
      "Internet radio + YouTube audio library with WebUI management & playback control.",
    rpcMethodsUsed: [
      "voice.join",
      "voice.leave",
      "voice.play",
      "voice.pause",
      "voice.stop",
      "voice.status",
      "messages.send",
      "messages.edit",
      "messages.delete",
      "interactions.respond",
      "interactions.followup",
      "auth.session",
    ],
    storage: { guildKv: false },
    components: [
      definePluginComponent({ id: "prev", handler: controlHandler("prev") }),
      definePluginComponent({ id: "pause", handler: controlHandler("pause") }),
      definePluginComponent({ id: "next", handler: controlHandler("next") }),
      definePluginComponent({ id: "stop", handler: controlHandler("stop") }),
      definePluginComponent({ id: "loop", handler: controlHandler("loop") }),
      definePluginComponent({
        id: "autoplay",
        handler: controlHandler("autoplay"),
      }),
    ],
    capabilities: [
      definePluginCapability({
        key: "manage",
        description:
          "Access the radio admin WebUI — manage / edit / delete library tracks, and upload private audio files for the library.",
      }),
    ],
    guildFeatures: [
      defineGuildFeature({
        key: "radio",
        name: "Karyl Radio",
        description:
          "Internet radio + a YouTube/HTTP audio library: /radio gives voice playback, a queue, the library and a management WebUI. Off by default — enable it per-guild.",
        enabledByDefault: false,
        commands: [
          definePluginCommand({
            name: "radio",
            description: "Internet radio & audio library",
            scope: "guild",
            integrationTypes: ["guild_install"],
            contexts: ["Guild"],
            // Anyone who can join voice can use it; the admin-ish bits
            // are gated separately (manage → plugin:karyl-radio:manage,
            // which also covers uploading private audio files via the WebUI).
            defaultMemberPermissions: "Connect",
            options: [
              {
                type: "sub_command",
                name: "play",
                description:
                  "Play a station, library track, or URL (replaces current)",
                options: [
                  {
                    type: "string",
                    name: "source",
                    description:
                      "Playlist name, station key, library track title/ID, or http(s) URL",
                    required: true,
                  },
                ],
              },
              {
                type: "sub_command",
                name: "queue",
                description: "Add a track to the queue",
                options: [
                  {
                    type: "string",
                    name: "source",
                    description:
                      "Playlist name, station key, library track title/ID, or http(s) URL",
                    required: true,
                  },
                ],
              },
              {
                type: "sub_command",
                name: "skip",
                description: "Skip the current track and play next in queue",
              },
              {
                type: "sub_command",
                name: "back",
                description: "Go back to the previously played track",
              },
              {
                type: "sub_command",
                name: "loop",
                description: "Set loop mode (off / track / queue)",
                options: [
                  {
                    type: "string",
                    name: "mode",
                    description: "Loop mode",
                    required: true,
                    choices: [
                      { name: "off — no looping", value: "off" },
                      { name: "track — repeat current", value: "track" },
                      { name: "queue — cycle the queue", value: "queue" },
                    ],
                  },
                ],
              },
              {
                type: "sub_command",
                name: "autoplay",
                description:
                  "Auto-queue YouTube recommendations when the queue runs out",
                options: [
                  {
                    type: "string",
                    name: "mode",
                    description: "Turn autoplay on or off",
                    required: true,
                    choices: [
                      {
                        name: "on — keep playing related YouTube songs",
                        value: "on",
                      },
                      { name: "off — stop when the queue ends", value: "off" },
                    ],
                  },
                ],
              },
              {
                type: "sub_command",
                name: "autoplay-count",
                description:
                  "How many YouTube recommendations autoplay queues per refill (1–25)",
                options: [
                  {
                    type: "integer",
                    name: "count",
                    description:
                      "Recommendations per refill (1–25) — omit to show the current value",
                    required: false,
                  },
                ],
              },
              {
                type: "sub_command",
                name: "stop",
                description: "Stop playback, clear queue and leave voice",
              },
              {
                type: "sub_command",
                name: "np",
                description: "Show what's currently playing (+ WebUI link)",
              },
              {
                type: "sub_command",
                name: "queuelist",
                description: "Show the current queue",
              },
              {
                type: "sub_command",
                name: "stations",
                description: "List available radio stations",
              },
              {
                type: "sub_command",
                name: "manage",
                description:
                  "Get a private link to the radio admin WebUI (requires permission)",
              },
            ],
            handler: async (ctx): Promise<CommandReply> => {
              const guildId = ctx.guildId;
              if (!guildId)
                return "⚠ This command must be used inside a guild.";
              seenGuilds.add(guildId);

              const userId = ctx.userId;
              const sub = ctx.subCommandName;

              // Playback-state mutators serialize per guild — against each
              // other and the 1 s auto-advance loop — so a state-changing
              // `/radio` command can't interleave with the loop's
              // advance() / autoplay refill and corrupt the queue. Read-only
              // subs (and `download`, which can run for minutes) skip it.
              const dispatch = async (): Promise<CommandReply> => {
                switch (sub) {
                  case "stations":
                    return formatStationList();

                  case "manage": {
                    // 15-min bot JWT — only used to bootstrap a plugin-side
                    // manage session (access + refresh) on first load; after
                    // that the SPA refreshes itself for up to 1 day per tab.
                    const res = (await ctx.botRpc("/api/plugin/auth.session", {
                      user_id: userId,
                      kind: "manage",
                    })) as { allowed?: boolean; token?: string } | null;
                    // botRpc returns null on a non-2xx (e.g. the bot hasn't
                    // approved this plugin's `auth.session` RPC scope yet), and a
                    // truthy { allowed:false } when the *user* lacks the capability.
                    if (res === null) {
                      return {
                        content:
                          "⚠ Couldn't mint a login link — the bot rejected the request " +
                          `(plugin \`${PLUGIN_KEY}\` may need its \`auth.session\` RPC scope approved, or the bot is unavailable).`,
                        ephemeral: true,
                      };
                    }
                    if (res.allowed !== true || typeof res.token !== "string") {
                      return {
                        content:
                          `⚠ You're not allowed to manage Karyl Radio. Need the \`plugin:${PLUGIN_KEY}:manage\` capability ` +
                          "(bot owners and admins are exempt). Ask an admin to grant it to your role.",
                        ephemeral: true,
                      };
                    }
                    return {
                      content:
                        "🔧 **Karyl Radio — admin WebUI**\nManage downloaded tracks: search, edit metadata, delete. Open within 15 min; your tab session then refreshes itself for up to 1 day.",
                      components: [
                        linkButtonRow(
                          "🔧 Open admin WebUI",
                          `${effectiveBase()}/?token=${res.token}`,
                        ),
                      ],
                      ephemeral: true,
                    };
                  }

                  case "np": {
                    // Same embed + control buttons as the public now-playing
                    // message, but ephemeral and not auto-updated — only its
                    // own buttons edit it.
                    const status = await ctx.voice
                      .status(guildId)
                      .catch(() => null);
                    const webuiUrl = await webuiUrlFor(
                      ctx.botRpc,
                      userId,
                      guildId,
                    );
                    return {
                      embeds: [
                        renderNowPlayingEmbed(guildId, {
                          channelId: status?.channelId ?? null,
                          paused: !!status?.paused,
                        }),
                      ],
                      components: nowPlayingComponents(
                        PLUGIN_KEY,
                        guildId,
                        { paused: !!status?.paused },
                        webuiUrl,
                      ),
                      ephemeral: true,
                    };
                  }

                  case "queuelist":
                    return playbackReply(ctx, guildId, {
                      title: "📜 Queue",
                      description: formatQueueList(guildId),
                    });

                  case "loop": {
                    const mode =
                      typeof ctx.options.mode === "string"
                        ? ctx.options.mode
                        : "off";
                    if (mode !== "off" && mode !== "track" && mode !== "queue") {
                      return "⚠ mode must be one of: off / track / queue";
                    }
                    setLoop(guildId, mode);
                    await syncNowPlaying(guildId, ctx.botRpc);
                    return playbackReply(ctx, guildId, {
                      description: `${loopBadge(mode)} Loop mode set to **${mode}**.`,
                    });
                  }

                  case "autoplay": {
                    const mode =
                      typeof ctx.options.mode === "string"
                        ? ctx.options.mode
                        : "";
                    if (mode !== "on" && mode !== "off") {
                      return "⚠ mode must be `on` or `off`.";
                    }
                    setAutoplay(guildId, mode === "on");
                    const apCount =
                      getState(guildId)?.autoplayFetchCount ??
                      DEFAULT_AUTOPLAY_FETCH_COUNT;
                    await syncNowPlaying(guildId, ctx.botRpc);
                    return playbackReply(ctx, guildId, {
                      description:
                        mode === "on"
                          ? `♾️ Autoplay **on** — when the queue runs out I'll queue **${apCount}** YouTube recommendation${apCount === 1 ? "" : "s"} (change with \`/radio autoplay-count\`) seeded from the last YouTube track.`
                          : "Autoplay **off** — playback stops when the queue ends.",
                    });
                  }

                  case "autoplay-count": {
                    const cur =
                      getState(guildId)?.autoplayFetchCount ??
                      DEFAULT_AUTOPLAY_FETCH_COUNT;
                    const raw = ctx.options.count;
                    if (raw === undefined || raw === null) {
                      return playbackReply(ctx, guildId, {
                        description: `♾️ Autoplay queues **${cur}** recommendation${cur === 1 ? "" : "s"} per refill. Pass \`count:\` (1–${MAX_AUTOPLAY_FETCH_COUNT}) to change it.`,
                      });
                    }
                    const n = Number(raw);
                    if (!Number.isFinite(n)) {
                      return "⚠ count must be a whole number.";
                    }
                    const set = setAutoplayFetchCount(guildId, n);
                    await syncNowPlaying(guildId, ctx.botRpc);
                    const clampedNote =
                      set !== Math.floor(n)
                        ? ` (clamped to the 1–${MAX_AUTOPLAY_FETCH_COUNT} range)`
                        : "";
                    return playbackReply(ctx, guildId, {
                      description: `♾️ Autoplay will now queue **${set}** recommendation${set === 1 ? "" : "s"} per refill${clampedNote}. Takes effect at the next refill; tracks already queued stay.`,
                    });
                  }

                  case "stop": {
                    await doStop(guildId, ctx.botRpc);
                    sessionTokens.delete(guildId);
                    await nowPlaying.teardown(guildId, ctx.botRpc).catch(() => {});
                    return "✓ Stopped, queue cleared, and left voice.";
                  }

                  case "skip": {
                    const r = await doNext(guildId, ctx.botRpc);
                    if (r.kind === "queue-empty") {
                      await nowPlaying
                        .teardown(guildId, ctx.botRpc)
                        .catch(() => {});
                      return "Queue empty — stopped playback.";
                    }
                    await syncNowPlaying(guildId, ctx.botRpc);
                    if (r.kind === "playing")
                      return playbackReply(ctx, guildId, {
                        description: `⏭ Skipped. Now playing **${r.track.label}**.`,
                        ...(r.track.coverUrl
                          ? { thumbnail: { url: r.track.coverUrl } }
                          : {}),
                      });
                    if (r.kind === "play-failed")
                      return playbackReply(ctx, guildId, {
                        description: `⚠ Couldn't start **${r.track.label}** — re-queued, try again.`,
                      });
                    // r.kind === "exhausted"
                    return playbackReply(ctx, guildId, {
                      description:
                        "⚠ Skipped several unplayable tracks — try again.",
                    });
                  }

                  case "back": {
                    const r = await doPrev(guildId, ctx.botRpc);
                    if (r.kind === "no-history")
                      return "↩ Nothing in the play history to go back to.";
                    await syncNowPlaying(guildId, ctx.botRpc);
                    return playbackReply(ctx, guildId, {
                      description:
                        r.kind === "playing"
                          ? `⏮ Back to **${r.track.label}**.`
                          : `⚠ Failed to start **${r.track.label}**.`,
                      ...(r.kind === "playing" && r.track.coverUrl
                        ? { thumbnail: { url: r.track.coverUrl } }
                        : {}),
                    });
                  }

                  case "queue": {
                    const source = parseSource(ctx);
                    if (isYouTubePlaylistUrl(source)) {
                      let tracks: Track[];
                      try {
                        tracks = await resolvePlaylist(source, userId);
                      } catch (err) {
                        return `⚠ Couldn't expand that playlist — ${(err instanceof Error ? err.message : "error").slice(0, 180)}`;
                      }
                      if (tracks.length === 0)
                        return "⚠ That playlist is empty or unavailable.";
                      for (const t of tracks) {
                        t.queuedByName = ctx.userDisplayName;
                        enqueue(guildId, t);
                      }
                      await syncNowPlaying(guildId, ctx.botRpc);
                      return playbackReply(ctx, guildId, {
                        description: `➕ Queued **${tracks.length}** track${tracks.length === 1 ? "" : "s"} from the playlist.`,
                      });
                    }
                    const stored = await resolveStoredPlaylist(source, userId);
                    if (stored) {
                      if (stored.tracks.length === 0) {
                        return `⚠ Playlist **${stored.playlist.name}** has no playable entries${stored.skipped.length ? ` (${stored.skipped.length} couldn't be resolved)` : ""}.`;
                      }
                      for (const t of stored.tracks) {
                        t.queuedByName = ctx.userDisplayName;
                        enqueue(guildId, t);
                      }
                      await syncNowPlaying(guildId, ctx.botRpc);
                      const skipNote = stored.skipped.length
                        ? ` (${stored.skipped.length} entr${stored.skipped.length === 1 ? "y" : "ies"} skipped)`
                        : "";
                      return playbackReply(ctx, guildId, {
                        description: `➕ Queued **${stored.tracks.length}** track${stored.tracks.length === 1 ? "" : "s"} from playlist **${stored.playlist.name}**${skipNote}.`,
                      });
                    }
                    const resolved = await resolveSourceOrError(source, userId);
                    if (typeof resolved === "string") return resolved;
                    resolved.queuedByName = ctx.userDisplayName;
                    const position = enqueue(guildId, resolved);
                    await syncNowPlaying(guildId, ctx.botRpc);
                    return playbackReply(ctx, guildId, {
                      description: `➕ Queued **${resolved.label}** (position ${position}).`,
                      ...(resolved.coverUrl
                        ? { thumbnail: { url: resolved.coverUrl } }
                        : {}),
                    });
                  }

                  case "play": {
                    const source = parseSource(ctx);
                    // A YouTube link carrying `list=` (a Mix/radio share or a
                    // /playlist URL) implies "keep this going" → switch autoplay
                    // on; any other source turns it off (a fresh play resets it).
                    const autoOn = isYouTubeUrlWithList(source);
                    setAutoplay(guildId, autoOn);
                    const autoNote = autoOn
                      ? "\n♾️ Autoplay on — I'll keep going with YouTube recommendations when the queue runs out."
                      : "";
                    const joinFirst = async (): Promise<string | null> => {
                      try {
                        await ctx.voice.join({ guildId, userId });
                        return null;
                      } catch {
                        return "⚠ Could not join voice — make sure you're in a voice channel and the bot has permission.";
                      }
                    };

                    if (isYouTubePlaylistUrl(source)) {
                      let tracks: Track[];
                      try {
                        tracks = await resolvePlaylist(source, userId);
                      } catch (err) {
                        return `⚠ Couldn't expand that playlist — ${(err instanceof Error ? err.message : "error").slice(0, 180)}`;
                      }
                      if (tracks.length === 0)
                        return "⚠ That playlist is empty or unavailable.";
                      const joinErr = await joinFirst();
                      if (joinErr) return joinErr;
                      for (const t of tracks) t.queuedByName = ctx.userDisplayName;
                      // `play` is a fresh start — drop whatever was queued
                      // before loading this playlist (use `queue` to append).
                      const started = await playBulk(ctx, guildId, tracks);
                      await syncNowPlaying(guildId, ctx.botRpc);
                      return playbackReply(ctx, guildId, {
                        title: started
                          ? "▶️ Playing playlist"
                          : "▶️ Playlist queued",
                        description:
                          (started
                            ? `**${started.label}** — ${tracks.length} track${tracks.length === 1 ? "" : "s"} queued.`
                            : `Queued ${tracks.length} track${tracks.length === 1 ? "" : "s"}, but couldn't start the first one.`) +
                          autoNote,
                        ...(started?.coverUrl
                          ? { thumbnail: { url: started.coverUrl } }
                          : {}),
                      });
                    }

                    // Stored (admin-curated) playlist — same fresh-start shape
                    // as the YouTube-list branch above, just sourced from
                    // playlists.json. autoplay was already cleared at the top
                    // of /play (`autoOn` is only true for YouTube list URLs).
                    const stored = await resolveStoredPlaylist(source, userId);
                    if (stored) {
                      if (stored.tracks.length === 0) {
                        return `⚠ Playlist **${stored.playlist.name}** has no playable entries${stored.skipped.length ? ` (${stored.skipped.length} couldn't be resolved)` : ""}.`;
                      }
                      const joinErr = await joinFirst();
                      if (joinErr) return joinErr;
                      for (const t of stored.tracks) t.queuedByName = ctx.userDisplayName;
                      const started = await playBulk(ctx, guildId, stored.tracks);
                      await syncNowPlaying(guildId, ctx.botRpc);
                      const skipNote = stored.skipped.length
                        ? ` (${stored.skipped.length} skipped)`
                        : "";
                      return playbackReply(ctx, guildId, {
                        title: started
                          ? `▶️ Playing playlist: ${stored.playlist.name}`
                          : `▶️ Playlist queued: ${stored.playlist.name}`,
                        description:
                          (started
                            ? `**${started.label}** — ${stored.tracks.length} track${stored.tracks.length === 1 ? "" : "s"} queued${skipNote}.`
                            : `Queued ${stored.tracks.length} track${stored.tracks.length === 1 ? "" : "s"}${skipNote}, but couldn't start the first one.`) +
                          autoNote,
                        ...(started?.coverUrl
                          ? { thumbnail: { url: started.coverUrl } }
                          : {}),
                      });
                    }

                    const resolved = await resolveSourceOrError(source, userId);
                    if (typeof resolved === "string") return resolved;
                    resolved.queuedByName = ctx.userDisplayName;
                    const joinErr = await joinFirst();
                    if (joinErr) return joinErr;
                    // `play` is a fresh start — discard whatever was queued
                    // before (use `/radio queue` to keep & append instead).
                    clearQueue(guildId);
                    enqueue(guildId, resolved);
                    const candidate = peekNext(guildId);
                    // candidate is guaranteed (we just enqueued); the `!`
                    // satisfies the compiler about that invariant.
                    const o = await startTrack(ctx, guildId, candidate!.track);
                    if (o.ok) commitCursor(guildId, candidate!.idx);
                    await syncNowPlaying(guildId, ctx.botRpc);
                    return playbackReply(ctx, guildId, {
                      title: o.ok ? "▶️ Now playing" : "⚠ Playback failed",
                      description:
                        (o.ok
                          ? `**${o.track.label}**`
                          : `Joined voice but failed to start **${resolved.label}**.`) +
                        autoNote,
                      ...(o.ok && o.track.coverUrl
                        ? { thumbnail: { url: o.track.coverUrl } }
                        : {}),
                    });
                  }

                  default:
                    return `⚠ Unknown subcommand \`${sub ?? "(none)"}\``;
                }
              };
              return sub && !LOCK_FREE_SUBS.has(sub)
                ? withGuildLock(guildId, dispatch)
                : dispatch();
            },
          }),
        ],
      }),
    ],
    onReady: async (server) => {
      await registerWebRoutes(server, PLUGIN_KEY, effectiveBase, seenGuilds);
    },
  });
}

// Re-export so index.ts can wire deferred dependencies (bot RPC client,
// the bot's plugin-session JWT verify key, and the publicBaseUrl getter)
// into the WebUI routes once start() resolves (onReady runs before the
// lifecycle client exists).
export { setRadioBotRpc, setRadioPublicBaseUrl, setRadioSessionVerifyKey };
