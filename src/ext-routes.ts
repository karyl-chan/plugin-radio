/**
 * External control channel — `/api/ext/*`.
 *
 * A stable, API-key-authenticated HTTP surface for third-party
 * integrations (a browser extension, a Stream Deck, a shortcut) to drive
 * a guild's radio playback. It's the key-authed sibling of the SPA's
 * `/api/session/:guildId/*` routes, with two differences:
 *
 *   1. Auth is an `rk_…` API key (see api-keys.ts), not a bot session
 *      JWT. The key resolves to a single Discord user.
 *   2. The guild is never in the path. It's resolved per request:
 *      an explicit `guildId` in the body wins; otherwise the bot's
 *      `voice.locate` reverse-lookup finds whichever VC the key's user
 *      is currently sitting in ("play wherever I am").
 *
 * Kept as its own module (not folded into web-routes) so the external
 * contract — CORS, rate limiting, versioning — can evolve independently
 * of the SPA's routes. All playback primitives are reused from
 * queue/playback-actions/resolver, so behaviour matches the slash
 * command and the WebUI.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyKey, type ApiKeyScope } from "./api-keys.js";
import { runtime } from "./runtime.js";
import { withGuildLock } from "./guild-lock.js";
import * as nowPlaying from "./now-playing.js";
import {
  type LoopMode,
  type Track,
  clearQueue,
  enqueue,
  getCurrent,
  getEpoch,
  getState,
  getUpcoming,
  setAutoplay,
  setLoop,
} from "./queue.js";
import { doNext, doPrev, doPause, doStop } from "./playback-actions.js";
import {
  isYouTubePlaylistUrl,
  resolveAnyTrack,
  resolvePlaylist,
  resolveStoredPlaylist,
} from "./resolver.js";

/** Min spacing between control calls per key — blunts a runaway loop /
 *  spammy integration. Read-only (`/status`) is exempt. */
const CONTROL_MIN_INTERVAL_MS = 500;
const lastControlAt = new Map<string, number>();

/** Cap the upcoming-queue list a status poll returns — a long radio
 *  session could otherwise echo back hundreds of entries every few s. */
const QUEUE_VIEW_LIMIT = 20;

const LOOP_MODES: LoopMode[] = ["off", "track", "queue"];

interface AuthedKey {
  keyId: string;
  userId: string;
  scopes: ApiKeyScope[];
}

/** One voice.locate hit — where the key's user is currently sitting. */
interface VoiceMatch {
  guildId: string;
  guildName?: string | null;
  channelId: string;
  channelName?: string | null;
}

/** Resolved playback target for a request. */
interface Target {
  guildId: string;
  /** Set only when voice.locate pinned the exact channel. */
  channelId?: string;
}

export function registerExtRoutes(
  server: FastifyInstance,
  seenGuilds: Set<string>,
): void {
  const keepAdvancing = (guildId: string): void => {
    seenGuilds.add(guildId);
  };

  // ── CORS ────────────────────────────────────────────────────────────
  // Auth is a Bearer key, never a cookie, so reflecting the Origin (and
  // not allowing credentials) is safe and lets a browser extension or a
  // web integration call in. Scoped to /api/ext via the path guard.
  function applyCors(request: FastifyRequest, reply: FastifyReply): void {
    const origin = request.headers.origin;
    if (origin) {
      reply.header("Access-Control-Allow-Origin", origin);
      reply.header("Vary", "Origin");
    }
    reply.header("Access-Control-Allow-Methods", "GET, POST, OPTIONS");
    reply.header("Access-Control-Allow-Headers", "authorization, content-type");
    reply.header("Access-Control-Max-Age", "600");
  }

  server.options("/api/ext/*", async (request, reply) => {
    applyCors(request, reply);
    return reply.code(204).send();
  });

  /** Verify the Bearer API key; reply + return null on failure. */
  function authKey(
    request: FastifyRequest,
    reply: FastifyReply,
    need: ApiKeyScope,
  ): AuthedKey | null {
    applyCors(request, reply);
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      reply.code(401).send({ error: "Missing authorization" });
      return null;
    }
    const claims = verifyKey(token);
    if (!claims) {
      reply.code(401).send({ error: "Invalid or revoked API key" });
      return null;
    }
    // `control` implies `read` (you can't sensibly control without seeing
    // state), so a control key satisfies a read requirement too.
    const ok =
      claims.scopes.includes(need) ||
      (need === "read" && claims.scopes.includes("control"));
    if (!ok) {
      reply.code(403).send({ error: `API key lacks '${need}' scope` });
      return null;
    }
    if (need === "control") {
      const now = Date.now();
      const prev = lastControlAt.get(claims.keyId) ?? 0;
      if (now - prev < CONTROL_MIN_INTERVAL_MS) {
        reply.code(429).header("Retry-After", "1").send({ error: "Too many requests" });
        return null;
      }
      lastControlAt.set(claims.keyId, now);
    }
    return claims;
  }

  function parseBody(request: FastifyRequest): Record<string, unknown> {
    const b = request.body;
    if (typeof b === "string") {
      try {
        return JSON.parse(b) as Record<string, unknown>;
      } catch {
        return {};
      }
    }
    return (b as Record<string, unknown>) ?? {};
  }

  /** Where is the key's user sitting right now? Returns the (possibly
   *  empty) list of voice channels across guilds the bot shares with them.
   *  Best-effort — a locate failure resolves to no matches. */
  async function locate(userId: string): Promise<VoiceMatch[]> {
    const res = (await runtime()
      .botRpc("/api/plugin/voice.locate", { user_id: userId })
      .catch(() => null)) as { matches?: VoiceMatch[] } | null;
    return Array.isArray(res?.matches) ? (res as { matches: VoiceMatch[] }).matches : [];
  }

  /**
   * Resolve which guild (and ideally channel) this request acts on.
   * Precedence: explicit body.guildId → the user's sole current VC.
   * Replies + returns null on failure so callers just `return`.
   */
  async function resolveTarget(
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

  /** Resolve a source string to the Track(s) to enqueue (mirrors the
   *  WebUI /queue dispatch: YouTube playlist → stored playlist → single).
   *  Throws on an unresolvable / empty source. */
  async function resolveSource(source: string, userId: string): Promise<Track[]> {
    if (isYouTubePlaylistUrl(source)) {
      const tracks = await resolvePlaylist(source, userId);
      if (tracks.length === 0) throw new Error("Playlist is empty or unavailable");
      return tracks;
    }
    const stored = await resolveStoredPlaylist(source, userId);
    if (stored) {
      if (stored.tracks.length === 0) {
        throw new Error(`Playlist "${stored.playlist.name}" has no playable entries`);
      }
      return stored.tracks;
    }
    const track = await resolveAnyTrack(source, userId);
    if (!track) throw new Error("Unknown station/track/URL");
    return [track];
  }

  /** Card-shaped view of a queue track for the panel. (Library metadata
   *  like author/duration isn't on the queue Track — it'd need a per-poll
   *  library join — so the panel renders from label + cover.) */
  function trackView(t: Track): Record<string, unknown> {
    return {
      label: t.label,
      ...(t.qid !== undefined ? { qid: t.qid } : {}),
      ...(t.coverUrl ? { coverUrl: t.coverUrl } : {}),
    };
  }

  /** Voice-status fields the panel uses (superset of the SDK's VoiceStatus
   *  — channelName / guildName are bot-side additions). */
  interface VoiceStatusFull {
    connected?: boolean;
    channelId?: string | null;
    channelName?: string | null;
    guildName?: string | null;
    playing?: boolean;
    paused?: boolean;
    listeners?: number;
  }

  /**
   * The playback session for a guild: what the bot is connected to + the
   * current track and upcoming queue (all plugin-owned state, plus the
   * bot's channel name from voice.status). `userChannelId`, when known,
   * sets `inYourChannel` so the panel can tell "the bot is in YOUR VC"
   * apart from "the bot is playing elsewhere in this server".
   */
  async function sessionSnapshot(
    guildId: string,
    userChannelId?: string | null,
  ): Promise<Record<string, unknown>> {
    const s = getState(guildId);
    const status = (await runtime()
      .voice.status(guildId)
      .catch(() => null)) as VoiceStatusFull | null;
    const cur = s ? getCurrent(s) : null;
    const upcoming = s ? getUpcoming(s) : [];
    const botChannelId = status?.channelId ?? null;
    return {
      guildId,
      botConnected: status?.connected === true,
      botChannelId,
      botChannelName: status?.channelName ?? null,
      inYourChannel:
        userChannelId != null ? botChannelId === userChannelId : null,
      listeners: typeof status?.listeners === "number" ? status.listeners : null,
      playing: status?.playing === true,
      paused: status?.paused === true,
      loop: s?.loop ?? "off",
      autoplay: s?.autoplay ?? false,
      current: cur ? trackView(cur) : null,
      queue: upcoming.slice(0, QUEUE_VIEW_LIMIT).map(trackView),
      queueLength: upcoming.length,
    };
  }

  // ── GET /api/ext/status ─────────────────────────────────────────────
  // The panel's single poll: presence (is the key's user in a VC the bot
  // can reach?) + the session for the relevant guild + everything needed
  // to render controls. Never errors on "not in voice" — it reports
  // `presence.reachable:false` so the panel can show a calm hint.
  //
  // `?guildId=` overrides which guild's session to show (lets the panel
  // keep showing a session even after the user steps out of voice).
  server.get<{ Querystring: { guildId?: string } }>(
    "/api/ext/status",
    async (request, reply) => {
      const key = authKey(request, reply, "read");
      if (!key) return;
      const q = (request.query as { guildId?: string } | undefined) ?? {};
      const forced = typeof q.guildId === "string" ? q.guildId.trim() : "";

      const matches = await locate(key.userId);
      const here = matches.length === 1 ? matches[0] : null;
      const presence = {
        reachable: matches.length >= 1,
        ambiguous: matches.length > 1,
        guildId: here?.guildId ?? null,
        guildName: here?.guildName ?? null,
        channelId: here?.channelId ?? null,
        channelName: here?.channelName ?? null,
        candidates: matches.length > 1 ? matches : [],
      };

      // Which guild's session to show: explicit override → the user's sole
      // current VC. (Ambiguous / absent + no override → no session.)
      const sessionGuildId = forced || here?.guildId || null;
      const session = sessionGuildId
        ? await sessionSnapshot(sessionGuildId, here?.channelId ?? null)
        : null;

      return { user: { id: key.userId }, presence, session };
    },
  );

  // ── Shared play/queue plumbing ──────────────────────────────────────
  /** voice.join args: the locate-pinned channel if we have it, else let
   *  the bot resolve the key user's current VC in this guild. */
  function joinArgs(target: Target, userId: string) {
    return target.channelId
      ? { guildId: target.guildId, channelId: target.channelId }
      : { guildId: target.guildId, userId };
  }

  /** Join voice; reply 409 + return false on failure. */
  async function joinOr409(
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

  /** Resolve a source; reply 400 + return null on failure. */
  async function resolveSourceOr400(
    source: string,
    userId: string,
    reply: FastifyReply,
  ): Promise<Track[] | null> {
    try {
      return await resolveSource(source, userId);
    } catch (err) {
      reply.code(400).send({
        error:
          err instanceof Error ? err.message.slice(0, 200) : "Couldn't resolve source",
      });
      return null;
    }
  }

  /** Shared preamble for play/queue: auth (control), a non-empty source,
   *  and a resolved guild target. Replies + returns null on any failure. */
  async function requirePlayable(
    request: FastifyRequest,
    reply: FastifyReply,
  ): Promise<{ key: AuthedKey; source: string; target: Target } | null> {
    const key = authKey(request, reply, "control");
    if (!key) return null;
    const body = parseBody(request);
    const source = typeof body.source === "string" ? body.source.trim() : "";
    if (!source) {
      reply.code(400).send({ error: "source required" });
      return null;
    }
    const target = await resolveTarget(key.userId, body, reply);
    if (!target) return null;
    return { key, source, target };
  }

  // ── POST /api/ext/play ──────────────────────────────────────────────
  // Join the caller's current VC (or the channel voice.locate pinned),
  // then start a fresh session from `source`. The flagship endpoint: a
  // browser extension on any YouTube page POSTs { source: <page url> }.
  server.post("/api/ext/play", async (request, reply) => {
    const ctx = await requirePlayable(request, reply);
    if (!ctx) return;
    if (!(await joinOr409(ctx.target, ctx.key.userId, reply))) return;
    const tracks = await resolveSourceOr400(ctx.source, ctx.key.userId, reply);
    if (!tracks) return;

    const { guildId } = ctx.target;
    const epochAtStart = getEpoch(guildId);
    return withGuildLock(guildId, async () => {
      if (getEpoch(guildId) !== epochAtStart) {
        return reply.code(409).send({ error: "Session changed — retry." });
      }
      keepAdvancing(guildId);
      clearQueue(guildId);
      for (const t of tracks) enqueue(guildId, t);
      await doNext(guildId);
      await nowPlaying.sync(guildId).catch(() => null);
      return sessionSnapshot(guildId, ctx.target.channelId ?? null);
    });
  });

  // ── POST /api/ext/queue ─────────────────────────────────────────────
  // Append to the session. Starts playback (joining first) if nothing is
  // playing yet, so a cold `queue` still gets audio going.
  server.post("/api/ext/queue", async (request, reply) => {
    const ctx = await requirePlayable(request, reply);
    if (!ctx) return;
    const tracks = await resolveSourceOr400(ctx.source, ctx.key.userId, reply);
    if (!tracks) return;

    const { guildId } = ctx.target;
    const status = (await runtime()
      .voice.status(guildId)
      .catch(() => null)) as { playing?: boolean } | null;
    const coldStart = !status?.playing;
    if (coldStart && !(await joinOr409(ctx.target, ctx.key.userId, reply))) return;

    const epochAtStart = getEpoch(guildId);
    return withGuildLock(guildId, async () => {
      if (getEpoch(guildId) !== epochAtStart) {
        return reply.code(409).send({ error: "Session changed — retry." });
      }
      keepAdvancing(guildId);
      for (const t of tracks) enqueue(guildId, t);
      if (coldStart) await doNext(guildId);
      await nowPlaying.sync(guildId).catch(() => null);
      return sessionSnapshot(guildId, ctx.target.channelId ?? null);
    });
  });

  // ── Transport controls ──────────────────────────────────────────────
  // Each mirrors a now-playing card button. The op runs under the guild
  // lock; the response is the refreshed session so the panel updates in
  // one round-trip. `parseBody` is read once up front so a body-carried
  // `guildId` / `mode` / `on` reaches both resolveTarget and the op.
  async function control(
    request: FastifyRequest,
    reply: FastifyReply,
    op: (guildId: string) => Promise<unknown>,
  ): Promise<unknown> {
    const key = authKey(request, reply, "control");
    if (!key) return;
    const target = await resolveTarget(key.userId, parseBody(request), reply);
    if (!target) return;
    return withGuildLock(target.guildId, async () => {
      keepAdvancing(target.guildId);
      await op(target.guildId);
      await nowPlaying.sync(target.guildId).catch(() => null);
      return sessionSnapshot(target.guildId, target.channelId ?? null);
    });
  }

  server.post("/api/ext/next", (request, reply) =>
    control(request, reply, (g) => doNext(g)),
  );
  server.post("/api/ext/prev", (request, reply) =>
    control(request, reply, (g) => doPrev(g)),
  );
  server.post("/api/ext/stop", (request, reply) =>
    control(request, reply, (g) => doStop(g)),
  );
  server.post("/api/ext/pause", (request, reply) => {
    const body = parseBody(request);
    const paused = typeof body.paused === "boolean" ? body.paused : undefined;
    return control(request, reply, (g) => doPause(g, paused));
  });
  server.post("/api/ext/loop", (request, reply) => {
    const body = parseBody(request);
    const mode = body.mode;
    if (typeof mode !== "string" || !LOOP_MODES.includes(mode as LoopMode)) {
      return reply.code(400).send({ error: "mode must be off/track/queue" });
    }
    return control(request, reply, async (g) => setLoop(g, mode as LoopMode));
  });
  server.post("/api/ext/autoplay", (request, reply) => {
    const body = parseBody(request);
    if (typeof body.on !== "boolean") {
      return reply.code(400).send({ error: "`on` (boolean) required" });
    }
    return control(request, reply, async (g) => setAutoplay(g, body.on as boolean));
  });
}
