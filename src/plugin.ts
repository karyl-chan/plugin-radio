import {
  type APIEmbed,
  type CommandContext,
  type CommandReply,
  type ComponentContext,
  type ComponentReply,
  type CommandOption,
  type MessageActionRow,
  definePlugin,
  definePluginCapability,
  definePluginCommand,
  definePluginComponent,
  defineGuildFeature,
  defineWebUI,
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
import { registerExtRoutes } from "./ext-routes.js";
import {
  type PlayOutcome,
  playTrack,
  resolveAnyTrack,
  resolvePlaylist,
  resolveStoredPlaylist,
} from "./resolver.js";
import {
  type Locale,
  type LocaleKey,
  describeEn,
  localizedDescriptions,
  resolveLocale,
  t,
} from "./i18n/index.js";

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
  opts?: { status?: nowPlaying.VoiceStatusLike; skipMessageId?: string },
): Promise<{ embeds: APIEmbed[]; components: MessageActionRow[] } | null> {
  return nowPlaying.sync(guildId, opts).catch(() => null);
}

/**
 * Build a playback-command reply: an embed + a "🎛 Open WebUI" link
 * button to the session page. Falls back to a plain embed (no button)
 * if a session token couldn't be minted.
 */
async function playbackReply(
  ctx: CommandContext,
  guildId: string,
  locale: Locale,
  embed: Record<string, unknown>,
): Promise<CommandReply> {
  const url = await webuiUrlFor(ctx.botRpc, ctx.userId, guildId);
  const components = url
    ? [linkButtonRow(t(locale, "btn.openWebui"), url)]
    : undefined;
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
  locale: Locale,
): Promise<Track | string> {
  let track: Track | null;
  try {
    track = await resolveAnyTrack(source, userId);
  } catch (err) {
    const msg = err instanceof Error ? err.message : "extraction failed";
    return t(locale, "error.resolve.failed", { reason: msg.slice(0, 180) });
  }
  if (!track) return t(locale, "error.resolve.unknownSource", { source });
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
    // Component contexts carry the clicking user's locale; fall back to
    // English when the SDK couldn't determine it.
    const locale = resolveLocale(ctx);
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
      await nudge(t(locale, "control.notInVoiceAnymore"));
      return;
    }
    if (ctx.voiceChannelId !== status.channelId) {
      await nudge(t(locale, "control.mustJoinVoice", { channelId: status.channelId }));
      return;
    }

    // Serialize with the advance loop / `/radio` commands (see guild-lock.ts).
    return withGuildLock(guildId, async (): Promise<ComponentReply> => {
      seenGuilds.add(guildId);

      if (action === "stop") {
        await doStop(guildId);
        sessionTokens.delete(guildId);
        const onPublicMessage =
          nowPlaying.getMessage(guildId)?.messageId === ctx.messageId;
        await nowPlaying.teardown(guildId).catch(() => {});
        // The public message is now deleted — if the click was on it there's
        // nothing left to PATCH; if it was on a /radio np message, leave a notice.
        return onPublicMessage
          ? undefined
          : {
              embeds: [
                {
                  color: EMBED_COLOR,
                  description: t(locale, "control.stopped"),
                },
              ],
              components: [],
            };
      }

      let paused = status.paused === true;
      if (action === "next") {
        const r = await doNext(guildId);
        if (r.kind === "queue-empty") {
          // Queue drained — playback stopped. Tear the panel down rather
          // than leave a "nothing playing" card with live buttons. (Check
          // whether this click was on that very message *before* teardown
          // forgets it.)
          const onPublicMessage =
            nowPlaying.getMessage(guildId)?.messageId === ctx.messageId;
          await nowPlaying.teardown(guildId).catch(() => {});
          return onPublicMessage
            ? undefined
            : {
                embeds: [
                  {
                    color: EMBED_COLOR,
                    description: t(locale, "control.queueExhausted"),
                  },
                ],
                components: [],
              };
        }
        paused = false; // a fresh voice.play isn't paused
      } else if (action === "prev") {
        await doPrev(guildId);
        paused = false;
      } else if (action === "pause") {
        ({ paused } = await doPause(guildId));
      } else if (action === "loop") {
        const cur: LoopMode = getState(guildId)?.loop ?? "off";
        setLoop(guildId, cycleLoopMode(cur));
      } else if (action === "autoplay") {
        setAutoplay(guildId, !(getState(guildId)?.autoplay ?? false));
      }

      const reply = await syncNowPlaying(guildId, {
        status: { connected: true, channelId: status.channelId, paused },
        skipMessageId: ctx.messageId,
      });
      return reply ?? undefined;
    });
  };
}

// ── Slash-command option helpers ─────────────────────────────────────────
//
// Discord supports `name_localizations` + `description_localizations` on
// every command / option / choice node. The bot's manifest reconciler
// doesn't yet propagate these to Discord (it strips the option shape to
// {type, name, description, required, options}), so the maps sit on the
// option objects ready for when the bot adopts them — see SDK_REVIEW /
// reconcile.service.ts in the bot for context. Attached today so a future
// bot upgrade lights translations up without touching plugin code.

/** Build a localised option whose `description` is the English variant
 *  resolved from `descriptionKey`, with the per-locale map attached. */
function localizedOption(
  base: Omit<CommandOption, "description">,
  descriptionKey: LocaleKey,
  vars?: Record<string, string | number>,
): CommandOption {
  return {
    ...base,
    description: describeEn(descriptionKey, vars),
    // `description_localizations` isn't on the SDK's CommandOption type
    // yet (the SDK is below the bot's reconciler version that consumes it).
    // The cast keeps the value on the object so it ships once both sides
    // catch up; today it's a no-op at the wire.
    description_localizations: localizedDescriptions(descriptionKey, vars),
  } as CommandOption & {
    description_localizations: ReturnType<typeof localizedDescriptions>;
  };
}

/** Build a localised choice for an option's `choices[]` array. */
function localizedChoice(
  value: string,
  nameKey: LocaleKey,
): { name: string; value: string; name_localizations: ReturnType<typeof localizedDescriptions> } {
  return {
    name: describeEn(nameKey),
    value,
    name_localizations: localizedDescriptions(nameKey),
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
      "voice.locate",
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
    // Manage WebUI is reached from the bot admin plugin page (which mints a
    // manage token for the logged-in admin), served at <base>/manage.
    webUI: defineWebUI(),
    guildFeatures: [
      defineGuildFeature({
        key: "radio",
        name: describeEn("feature.name"),
        description: describeEn("feature.description"),
        enabledByDefault: false,
        commands: [
          definePluginCommand({
            name: "radio",
            description: describeEn("cmd.radio.description"),
            scope: "guild",
            integrationTypes: ["guild_install"],
            contexts: ["Guild"],
            // Anyone who can join voice can use it; the admin-ish bits
            // are gated separately (manage → plugin:karyl-radio:manage,
            // which also covers uploading private audio files via the WebUI).
            defaultMemberPermissions: "Connect",
            // Top-level command localizations go on the manifest's plugin
            // command shape; expressed inline here via a cast so the
            // value travels with the definition once the bot reconciler
            // forwards them. See `localizedOption` comment for context.
            ...({
              description_localizations: localizedDescriptions(
                "cmd.radio.description",
              ),
            } as { description_localizations: ReturnType<typeof localizedDescriptions> }),
            options: [
              {
                ...localizedOption(
                  { type: "sub_command", name: "play" },
                  "cmd.play.description",
                ),
                options: [
                  localizedOption(
                    { type: "string", name: "source", required: true },
                    "cmd.play.source.description",
                  ),
                ],
              } as CommandOption,
              {
                ...localizedOption(
                  { type: "sub_command", name: "queue" },
                  "cmd.queue.description",
                ),
                options: [
                  localizedOption(
                    { type: "string", name: "source", required: true },
                    "cmd.queue.source.description",
                  ),
                ],
              } as CommandOption,
              localizedOption(
                { type: "sub_command", name: "skip" },
                "cmd.skip.description",
              ),
              localizedOption(
                { type: "sub_command", name: "back" },
                "cmd.back.description",
              ),
              {
                ...localizedOption(
                  { type: "sub_command", name: "loop" },
                  "cmd.loop.description",
                ),
                options: [
                  {
                    ...localizedOption(
                      { type: "string", name: "mode", required: true },
                      "cmd.loop.mode.description",
                    ),
                    choices: [
                      localizedChoice("off", "cmd.loop.mode.off"),
                      localizedChoice("track", "cmd.loop.mode.track"),
                      localizedChoice("queue", "cmd.loop.mode.queue"),
                    ],
                  } as CommandOption,
                ],
              } as CommandOption,
              {
                ...localizedOption(
                  { type: "sub_command", name: "autoplay" },
                  "cmd.autoplay.description",
                ),
                options: [
                  {
                    ...localizedOption(
                      { type: "string", name: "mode", required: true },
                      "cmd.autoplay.mode.description",
                    ),
                    choices: [
                      localizedChoice("on", "cmd.autoplay.mode.on"),
                      localizedChoice("off", "cmd.autoplay.mode.off"),
                    ],
                  } as CommandOption,
                ],
              } as CommandOption,
              {
                ...localizedOption(
                  { type: "sub_command", name: "autoplay-count" },
                  "cmd.autoplayCount.description",
                ),
                options: [
                  localizedOption(
                    { type: "integer", name: "count", required: false },
                    "cmd.autoplayCount.count.description",
                  ),
                ],
              } as CommandOption,
              localizedOption(
                { type: "sub_command", name: "stop" },
                "cmd.stop.description",
              ),
              localizedOption(
                { type: "sub_command", name: "np" },
                "cmd.np.description",
              ),
              localizedOption(
                { type: "sub_command", name: "queuelist" },
                "cmd.queuelist.description",
              ),
              localizedOption(
                { type: "sub_command", name: "stations" },
                "cmd.stations.description",
              ),
            ],
            handler: async (ctx): Promise<CommandReply> => {
              const guildId = ctx.guildId;
              const locale = resolveLocale(ctx);
              if (!guildId) return t(locale, "error.notInGuild");
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
                    return formatStationList(locale);

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
                        renderNowPlayingEmbed(
                          guildId,
                          {
                            channelId: status?.channelId ?? null,
                            paused: !!status?.paused,
                          },
                          locale,
                        ),
                      ],
                      components: nowPlayingComponents(
                        PLUGIN_KEY,
                        guildId,
                        { paused: !!status?.paused },
                        webuiUrl,
                        locale,
                      ),
                      ephemeral: true,
                    };
                  }

                  case "queuelist":
                    return playbackReply(ctx, guildId, locale, {
                      title: t(locale, "queuelist.title"),
                      description: formatQueueList(guildId, locale),
                    });

                  case "loop": {
                    const mode =
                      typeof ctx.options.mode === "string"
                        ? ctx.options.mode
                        : "off";
                    if (mode !== "off" && mode !== "track" && mode !== "queue") {
                      return t(locale, "error.loop.invalidMode");
                    }
                    setLoop(guildId, mode);
                    await syncNowPlaying(guildId);
                    return playbackReply(ctx, guildId, locale, {
                      description: t(locale, "loop.set", {
                        badge: loopBadge(mode),
                        mode,
                      }),
                    });
                  }

                  case "autoplay": {
                    const mode =
                      typeof ctx.options.mode === "string"
                        ? ctx.options.mode
                        : "";
                    if (mode !== "on" && mode !== "off") {
                      return t(locale, "error.autoplay.invalidMode");
                    }
                    setAutoplay(guildId, mode === "on");
                    const apCount =
                      getState(guildId)?.autoplayFetchCount ??
                      DEFAULT_AUTOPLAY_FETCH_COUNT;
                    await syncNowPlaying(guildId);
                    return playbackReply(ctx, guildId, locale, {
                      description:
                        mode === "on"
                          ? t(
                              locale,
                              apCount === 1
                                ? "autoplay.onSingular"
                                : "autoplay.onPlural",
                              { count: apCount },
                            )
                          : t(locale, "autoplay.off"),
                    });
                  }

                  case "autoplay-count": {
                    const cur =
                      getState(guildId)?.autoplayFetchCount ??
                      DEFAULT_AUTOPLAY_FETCH_COUNT;
                    const raw = ctx.options.count;
                    if (raw === undefined || raw === null) {
                      return playbackReply(ctx, guildId, locale, {
                        description: t(
                          locale,
                          cur === 1
                            ? "autoplayCount.showSingular"
                            : "autoplayCount.showPlural",
                          { count: cur, max: MAX_AUTOPLAY_FETCH_COUNT },
                        ),
                      });
                    }
                    const n = Number(raw);
                    if (!Number.isFinite(n)) {
                      return t(locale, "error.autoplayCount.notNumber");
                    }
                    const set = setAutoplayFetchCount(guildId, n);
                    await syncNowPlaying(guildId);
                    const clampNote =
                      set !== Math.floor(n)
                        ? t(locale, "autoplayCount.clampNote", {
                            max: MAX_AUTOPLAY_FETCH_COUNT,
                          })
                        : "";
                    return playbackReply(ctx, guildId, locale, {
                      description: t(
                        locale,
                        set === 1
                          ? "autoplayCount.setSingular"
                          : "autoplayCount.setPlural",
                        { count: set, clampNote },
                      ),
                    });
                  }

                  case "stop": {
                    await doStop(guildId);
                    sessionTokens.delete(guildId);
                    await nowPlaying.teardown(guildId).catch(() => {});
                    return t(locale, "stop.done");
                  }

                  case "skip": {
                    const r = await doNext(guildId);
                    if (r.kind === "queue-empty") {
                      await nowPlaying
                        .teardown(guildId)
                        .catch(() => {});
                      return t(locale, "skip.queueEmpty");
                    }
                    await syncNowPlaying(guildId);
                    if (r.kind === "playing")
                      return playbackReply(ctx, guildId, locale, {
                        description: t(locale, "skip.nowPlaying", {
                          label: r.track.label,
                        }),
                        ...(r.track.coverUrl
                          ? { thumbnail: { url: r.track.coverUrl } }
                          : {}),
                      });
                    if (r.kind === "play-failed")
                      return playbackReply(ctx, guildId, locale, {
                        description: t(locale, "skip.startFailed", {
                          label: r.track.label,
                        }),
                      });
                    // r.kind === "exhausted"
                    return playbackReply(ctx, guildId, locale, {
                      description: t(locale, "skip.exhausted"),
                    });
                  }

                  case "back": {
                    const r = await doPrev(guildId);
                    if (r.kind === "no-history")
                      return t(locale, "back.noHistory");
                    await syncNowPlaying(guildId);
                    return playbackReply(ctx, guildId, locale, {
                      description:
                        r.kind === "playing"
                          ? t(locale, "back.nowPlaying", { label: r.track.label })
                          : t(locale, "back.startFailed", { label: r.track.label }),
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
                        return t(locale, "error.playlist.expandFailed", {
                          reason: (err instanceof Error ? err.message : "error").slice(0, 180),
                        });
                      }
                      if (tracks.length === 0)
                        return t(locale, "error.playlist.empty");
                      for (const tr of tracks) {
                        tr.queuedByName = ctx.userDisplayName;
                        enqueue(guildId, tr);
                      }
                      await syncNowPlaying(guildId);
                      return playbackReply(ctx, guildId, locale, {
                        description: t(
                          locale,
                          tracks.length === 1
                            ? "queue.youtubePlaylistAddedSingular"
                            : "queue.youtubePlaylistAddedPlural",
                          { count: tracks.length },
                        ),
                      });
                    }
                    const stored = await resolveStoredPlaylist(source, userId);
                    if (stored) {
                      if (stored.tracks.length === 0) {
                        const skipped =
                          stored.skipped.length > 0
                            ? t(locale, "error.storedPlaylist.skippedCount", {
                                n: stored.skipped.length,
                              })
                            : "";
                        return t(locale, "error.storedPlaylist.empty", {
                          name: stored.playlist.name,
                          skipped,
                        });
                      }
                      for (const tr of stored.tracks) {
                        tr.queuedByName = ctx.userDisplayName;
                        enqueue(guildId, tr);
                      }
                      await syncNowPlaying(guildId);
                      const skipNote =
                        stored.skipped.length > 0
                          ? t(
                              locale,
                              stored.skipped.length === 1
                                ? "queue.skippedSuffixSingular"
                                : "queue.skippedSuffixPlural",
                              { n: stored.skipped.length },
                            )
                          : "";
                      return playbackReply(ctx, guildId, locale, {
                        description: t(
                          locale,
                          stored.tracks.length === 1
                            ? "queue.storedPlaylistAddedSingular"
                            : "queue.storedPlaylistAddedPlural",
                          {
                            count: stored.tracks.length,
                            name: stored.playlist.name,
                            skipNote,
                          },
                        ),
                      });
                    }
                    const resolved = await resolveSourceOrError(
                      source,
                      userId,
                      locale,
                    );
                    if (typeof resolved === "string") return resolved;
                    resolved.queuedByName = ctx.userDisplayName;
                    const position = enqueue(guildId, resolved);
                    await syncNowPlaying(guildId);
                    return playbackReply(ctx, guildId, locale, {
                      description: t(locale, "queue.addedAtPositionSingular", {
                        label: resolved.label,
                        position,
                      }),
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
                    const autoNote = autoOn ? t(locale, "autoplay.notice.on") : "";
                    const joinFirst = async (): Promise<string | null> => {
                      try {
                        await ctx.voice.join({ guildId, userId });
                        return null;
                      } catch {
                        return t(locale, "error.voice.joinFailed");
                      }
                    };

                    if (isYouTubePlaylistUrl(source)) {
                      let tracks: Track[];
                      try {
                        tracks = await resolvePlaylist(source, userId);
                      } catch (err) {
                        return t(locale, "error.playlist.expandFailed", {
                          reason: (err instanceof Error ? err.message : "error").slice(0, 180),
                        });
                      }
                      if (tracks.length === 0)
                        return t(locale, "error.playlist.empty");
                      const joinErr = await joinFirst();
                      if (joinErr) return joinErr;
                      for (const tr of tracks) tr.queuedByName = ctx.userDisplayName;
                      // `play` is a fresh start — drop whatever was queued
                      // before loading this playlist (use `queue` to append).
                      const started = await playBulk(ctx, guildId, tracks);
                      await syncNowPlaying(guildId);
                      const single = tracks.length === 1;
                      const description = started
                        ? t(
                            locale,
                            single
                              ? "play.playlist.startedSingular"
                              : "play.playlist.startedPlural",
                            { label: started.label, count: tracks.length },
                          )
                        : t(
                            locale,
                            single
                              ? "play.playlist.couldNotStartSingular"
                              : "play.playlist.couldNotStartPlural",
                            { count: tracks.length },
                          );
                      return playbackReply(ctx, guildId, locale, {
                        title: started
                          ? t(locale, "play.playlist.titlePlaying")
                          : t(locale, "play.playlist.titleQueued"),
                        description: description + autoNote,
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
                        const skipped =
                          stored.skipped.length > 0
                            ? t(locale, "error.storedPlaylist.skippedCount", {
                                n: stored.skipped.length,
                              })
                            : "";
                        return t(locale, "error.storedPlaylist.empty", {
                          name: stored.playlist.name,
                          skipped,
                        });
                      }
                      const joinErr = await joinFirst();
                      if (joinErr) return joinErr;
                      for (const tr of stored.tracks)
                        tr.queuedByName = ctx.userDisplayName;
                      const started = await playBulk(ctx, guildId, stored.tracks);
                      await syncNowPlaying(guildId);
                      const skipNote =
                        stored.skipped.length > 0
                          ? t(locale, "play.storedPlaylist.skipNote", {
                              n: stored.skipped.length,
                            })
                          : "";
                      const single = stored.tracks.length === 1;
                      const description = started
                        ? t(
                            locale,
                            single
                              ? "play.storedPlaylist.startedSingular"
                              : "play.storedPlaylist.startedPlural",
                            {
                              label: started.label,
                              count: stored.tracks.length,
                              skipNote,
                            },
                          )
                        : t(
                            locale,
                            single
                              ? "play.storedPlaylist.couldNotStartSingular"
                              : "play.storedPlaylist.couldNotStartPlural",
                            { count: stored.tracks.length, skipNote },
                          );
                      return playbackReply(ctx, guildId, locale, {
                        title: started
                          ? t(locale, "play.storedPlaylist.titlePlaying", {
                              name: stored.playlist.name,
                            })
                          : t(locale, "play.storedPlaylist.titleQueued", {
                              name: stored.playlist.name,
                            }),
                        description: description + autoNote,
                        ...(started?.coverUrl
                          ? { thumbnail: { url: started.coverUrl } }
                          : {}),
                      });
                    }

                    const resolved = await resolveSourceOrError(
                      source,
                      userId,
                      locale,
                    );
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
                    await syncNowPlaying(guildId);
                    return playbackReply(ctx, guildId, locale, {
                      title: o.ok
                        ? t(locale, "play.single.titleNowPlaying")
                        : t(locale, "play.single.titleFailed"),
                      description:
                        (o.ok
                          ? t(locale, "play.single.started", { label: o.track.label })
                          : t(locale, "play.single.failed", { label: resolved.label })) +
                        autoNote,
                      ...(o.ok && o.track.coverUrl
                        ? { thumbnail: { url: o.track.coverUrl } }
                        : {}),
                    });
                  }

                  default:
                    return t(locale, "error.unknownSubcommand", {
                      sub: sub ?? "(none)",
                    });
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
      // External control channel (API-key auth). Shares the advance-loop
      // guild set so a play/queue started via the extension keeps
      // advancing like a slash-command session.
      registerExtRoutes(server, seenGuilds);
    },
  });
}

// Re-export so index.ts can wire deferred dependencies (bot RPC client,
// the bot's plugin-session JWT verify key, and the publicBaseUrl getter)
// into the WebUI routes once start() resolves (onReady runs before the
// lifecycle client exists).
export { setRadioBotRpc, setRadioPublicBaseUrl, setRadioSessionVerifyKey };
