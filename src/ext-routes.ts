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
  type Track,
  clearQueue,
  enqueue,
  getCurrent,
  getEpoch,
  getState,
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

interface AuthedKey {
  keyId: string;
  userId: string;
  scopes: ApiKeyScope[];
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
    if (!claims.scopes.includes(need)) {
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

  /**
   * Resolve which guild (and ideally channel) this request acts on.
   * Precedence: explicit body.guildId → bot voice.locate of the key's
   * user. Replies + returns null on failure so callers just `return`.
   */
  async function resolveTarget(
    userId: string,
    body: Record<string, unknown>,
    reply: FastifyReply,
  ): Promise<Target | null> {
    const explicit = typeof body.guildId === "string" ? body.guildId.trim() : "";
    if (explicit) return { guildId: explicit };
    try {
      const res = (await runtime().botRpc("/api/plugin/voice.locate", {
        user_id: userId,
      })) as { guildId?: string; channelId?: string } | null;
      if (res && typeof res.guildId === "string") {
        return {
          guildId: res.guildId,
          ...(typeof res.channelId === "string" ? { channelId: res.channelId } : {}),
        };
      }
      reply.code(502).send({ error: "voice.locate returned no guild" });
      return null;
    } catch (err) {
      const status = (err as { status?: number }).status;
      if (status === 404) {
        reply.code(409).send({
          error: "You're not in a voice channel I can see — join one first.",
        });
        return null;
      }
      if (status === 409) {
        reply.code(409).send({
          error:
            "You're in voice channels on more than one server — pass `guildId` to pick one.",
        });
        return null;
      }
      reply.code(502).send({ error: "Couldn't locate your voice channel" });
      return null;
    }
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

  /** Compact playback snapshot — the external contract's status shape. */
  async function snapshot(guildId: string): Promise<Record<string, unknown>> {
    const s = getState(guildId);
    const status = (await runtime()
      .voice.status(guildId)
      .catch(() => null)) as
      | { channelId?: string | null; paused?: boolean; playing?: boolean }
      | null;
    const cur = s ? getCurrent(s) : null;
    return {
      guildId,
      channelId: status?.channelId ?? null,
      playing: status?.playing === true,
      paused: status?.paused === true,
      loop: s?.loop ?? "off",
      autoplay: s?.autoplay ?? false,
      current: cur ? { label: cur.label, ...(cur.coverUrl ? { coverUrl: cur.coverUrl } : {}) } : null,
      queueLength: s ? s.tracks.length : 0,
    };
  }

  // ── GET /api/ext/status ─────────────────────────────────────────────
  // GET has no JSON body in most browsers, so the guild override comes
  // from `?guildId=`; absent that, voice.locate resolves it.
  server.get<{ Querystring: { guildId?: string } }>(
    "/api/ext/status",
    async (request, reply) => {
      const key = authKey(request, reply, "read");
      if (!key) return;
      const q = (request.query as { guildId?: string } | undefined) ?? {};
      const hint = typeof q.guildId === "string" ? { guildId: q.guildId } : {};
      const target = await resolveTarget(key.userId, hint, reply);
      if (!target) return;
      return snapshot(target.guildId);
    },
  );

  // ── POST /api/ext/play ──────────────────────────────────────────────
  // Join the caller's current VC (or the channel voice.locate pinned),
  // then start a fresh session from `source`. The flagship endpoint: a
  // browser extension on any YouTube page POSTs { source: <page url> }.
  server.post("/api/ext/play", async (request, reply) => {
    const key = authKey(request, reply, "control");
    if (!key) return;
    const body = parseBody(request);
    const source = typeof body.source === "string" ? body.source.trim() : "";
    if (!source) return reply.code(400).send({ error: "source required" });
    const target = await resolveTarget(key.userId, body, reply);
    if (!target) return;

    try {
      await runtime().voice.join(
        target.channelId
          ? { guildId: target.guildId, channelId: target.channelId }
          : { guildId: target.guildId, userId: key.userId },
      );
    } catch {
      return reply.code(409).send({ error: "Couldn't join your voice channel" });
    }

    let tracks: Track[];
    try {
      tracks = await resolveSource(source, key.userId);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message.slice(0, 200) : "Couldn't resolve source",
      });
    }

    const epochAtStart = getEpoch(target.guildId);
    return withGuildLock(target.guildId, async () => {
      if (getEpoch(target.guildId) !== epochAtStart) {
        return reply.code(409).send({ error: "Session changed — retry." });
      }
      keepAdvancing(target.guildId);
      clearQueue(target.guildId);
      for (const t of tracks) enqueue(target.guildId, t);
      await doNext(target.guildId);
      await nowPlaying.sync(target.guildId).catch(() => null);
      return snapshot(target.guildId);
    });
  });

  // ── POST /api/ext/queue ─────────────────────────────────────────────
  // Append to the session. Starts playback (joining first) if nothing is
  // playing yet, so a cold `queue` still gets audio going.
  server.post("/api/ext/queue", async (request, reply) => {
    const key = authKey(request, reply, "control");
    if (!key) return;
    const body = parseBody(request);
    const source = typeof body.source === "string" ? body.source.trim() : "";
    if (!source) return reply.code(400).send({ error: "source required" });
    const target = await resolveTarget(key.userId, body, reply);
    if (!target) return;

    let tracks: Track[];
    try {
      tracks = await resolveSource(source, key.userId);
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message.slice(0, 200) : "Couldn't resolve source",
      });
    }

    const status = (await runtime()
      .voice.status(target.guildId)
      .catch(() => null)) as { connected?: boolean; playing?: boolean } | null;
    const coldStart = !status?.playing;
    if (coldStart) {
      try {
        await runtime().voice.join(
          target.channelId
            ? { guildId: target.guildId, channelId: target.channelId }
            : { guildId: target.guildId, userId: key.userId },
        );
      } catch {
        return reply.code(409).send({ error: "Couldn't join your voice channel" });
      }
    }

    const epochAtStart = getEpoch(target.guildId);
    return withGuildLock(target.guildId, async () => {
      if (getEpoch(target.guildId) !== epochAtStart) {
        return reply.code(409).send({ error: "Session changed — retry." });
      }
      keepAdvancing(target.guildId);
      for (const t of tracks) enqueue(target.guildId, t);
      if (coldStart) await doNext(target.guildId);
      await nowPlaying.sync(target.guildId).catch(() => null);
      return snapshot(target.guildId);
    });
  });

  // ── Transport controls ──────────────────────────────────────────────
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
      return snapshot(target.guildId);
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
}
