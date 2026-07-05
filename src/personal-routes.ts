/**
 * Personal page routes — `/api/me/*`.
 *
 * The self-service tier: any ordinary Discord member (no `manage`
 * capability) can curate their own playlists and API keys, and start one
 * of their playlists in whichever voice channel they're currently in.
 *
 * Auth is the bot's plugin-session JWT, exactly like the `/api/session/*`
 * routes, but WITHOUT a guild scope — `/radio me` mints a guildless token
 * (`guildId: null`) carrying the member's real Discord id, and every
 * route here is keyed on that `userId` (the same ownership discipline the
 * API-key routes use). It reuses the shared voice-target plumbing
 * (`voice-target.ts`) for "play wherever I am", and the shared per-user
 * stores (`user-playlists.ts`, `api-keys.ts`).
 *
 * Kept in its own module so this third auth tier doesn't get tangled into
 * web-routes.ts's manage/session surface.
 */
import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import { verifyPluginSession } from "@karyl-chan/plugin-sdk";
import { getSessionVerifyKeyFn, effectiveBase } from "./web-routes.js";
import { isHttpUrl } from "./downloader.js";
import { issueKey, listKeys, normalizeScopes, revokeKey } from "./api-keys.js";
import {
  getUserFavorite,
  listUserFavorites,
  removeUserFavorite,
  toggleUserFavorite,
} from "./user-favorites.js";
import {
  type UserPlaylistPatch,
  addUserPlaylist,
  getUserPlaylist,
  listUserPlaylists,
  removeUserPlaylist,
  updateUserPlaylist,
} from "./user-playlists.js";
import { resolveEntriesToTracks } from "./resolver.js";
import { locate, resolveTarget, joinOr409 } from "./voice-target.js";
import { clearQueue, enqueue, getEpoch } from "./queue.js";
import { doNext } from "./playback-actions.js";
import { withGuildLock } from "./guild-lock.js";
import * as nowPlaying from "./now-playing.js";
import { runtime } from "./runtime.js";
import { resolveViewer, NP_SYNTHETIC_PREFIX } from "./viewer.js";

export function registerPersonalRoutes(
  server: FastifyInstance,
  seenGuilds: Set<string>,
): void {
  /** Re-register a guild with the auto-advance loop after a WebUI play. */
  const keepAdvancing = (guildId: string): void => {
    seenGuilds.add(guildId);
  };

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

  /** Personal gate: a real member's guildless plugin-session JWT. Verifies
   *  the bot's Ed25519 signature (same key as the session routes), then
   *  rejects the synthetic now-playing user and any guild-scoped token so
   *  the personal tier is only ever reached via `/radio me`. */
  function authPersonal(
    request: FastifyRequest,
    reply: FastifyReply,
  ): { userId: string } | null {
    const verifyKey = getSessionVerifyKeyFn();
    if (!verifyKey) {
      reply.code(503).send({
        error:
          "session verification unavailable — plugin not yet registered with the bot",
      });
      return null;
    }
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      reply.code(401).send({ error: "Missing authorization" });
      return null;
    }
    const claims = verifyPluginSession(token, verifyKey);
    if (!claims) {
      reply.code(401).send({ error: "Invalid or expired token" });
      return null;
    }
    if (claims.userId.startsWith(NP_SYNTHETIC_PREFIX)) {
      reply.code(403).send({ error: "This link isn't valid for a personal page." });
      return null;
    }
    // Authenticate purely by the real userId — the /api/me/* routes are all
    // userId-scoped (the caller's own playlists / keys). We intentionally do
    // NOT require a guildless token: any real-user session token works,
    // guildless (`/radio me`) OR guild-scoped (a `/radio np|play` link). That
    // makes /me and the player page share ONE login — the guild session
    // token opens both, so navigating between them (and the browser back
    // button) never trips over a token swap. Only the synthetic public
    // now-playing user (rejected above) is barred.
    return { userId: claims.userId };
  }

  // ── identity + presence ─────────────────────────────────────────────
  // Identity probe — lets the SPA recover after a tab reload (token in
  // sessionStorage, no decoded claims) by confirming the token still
  // verifies and echoing back the user id.
  server.get("/api/me", async (request, reply) => {
    const me = authPersonal(request, reply);
    if (!me) return;
    // Resolve the logged-in profile for the top-right identity chip. Uses
    // the global user (users.get) — a /me token may be guildless or
    // guild-scoped, so we don't assume a guild here.
    return { userId: me.userId, viewer: await resolveViewer(me.userId, null) };
  });

  // Mint a playback-session link for a guild the member is currently in
  // voice on, carrying their real identity so the session page opens
  // "logged in" (drives the clickable voice-status on the personal page).
  server.get<{ Params: { guildId: string } }>(
    "/api/me/session-link/:guildId",
    async (request, reply) => {
      const me = authPersonal(request, reply);
      if (!me) return;
      const { guildId } = request.params;
      const matches = await locate(me.userId);
      if (!matches.some((m) => m.guildId === guildId)) {
        return reply
          .code(409)
          .send({ error: "You're not in a voice channel on that server." });
      }
      const res = (await runtime()
        .botRpc("/api/plugin/auth.session", {
          user_id: me.userId,
          kind: "session",
          guild_id: guildId,
        })
        .catch(() => null)) as { token?: string } | null;
      if (!res || typeof res.token !== "string") {
        return reply.code(502).send({ error: "Couldn't create a session link." });
      }
      return { url: `${effectiveBase()}/?token=${res.token}` };
    },
  );

  // Where the member is sitting right now (drives the Play button's
  // channel target). Empty matches → not in any visible voice channel.
  server.get("/api/me/locate", async (request, reply) => {
    const me = authPersonal(request, reply);
    if (!me) return;
    return { matches: await locate(me.userId) };
  });

  // ── playlists ───────────────────────────────────────────────────────
  server.get("/api/me/playlists", async (request, reply) => {
    const me = authPersonal(request, reply);
    if (!me) return;
    return { playlists: await listUserPlaylists(me.userId) };
  });

  server.post("/api/me/playlists", async (request, reply) => {
    const me = authPersonal(request, reply);
    if (!me) return;
    const body = parseBody(request);
    try {
      const playlist = await addUserPlaylist({
        ownerId: me.userId,
        name: typeof body.name === "string" ? body.name : "",
        description:
          typeof body.description === "string" ? body.description : undefined,
        entries: Array.isArray(body.entries)
          ? (body.entries as string[])
          : undefined,
      });
      return { playlist };
    } catch (e) {
      return reply
        .code(400)
        .send({ error: e instanceof Error ? e.message : "Invalid playlist" });
    }
  });

  server.get("/api/me/playlists/:id", async (request, reply) => {
    const me = authPersonal(request, reply);
    if (!me) return;
    const { id } = request.params as { id: string };
    const playlist = await getUserPlaylist(id, me.userId);
    if (!playlist) return reply.code(404).send({ error: "Not found" });
    return { playlist };
  });

  server.patch("/api/me/playlists/:id", async (request, reply) => {
    const me = authPersonal(request, reply);
    if (!me) return;
    const { id } = request.params as { id: string };
    const body = parseBody(request);
    const patch: UserPlaylistPatch = {};
    if (typeof body.name === "string") patch.name = body.name;
    if (typeof body.description === "string") patch.description = body.description;
    if (Array.isArray(body.entries)) patch.entries = body.entries as string[];
    try {
      const playlist = await updateUserPlaylist(id, me.userId, patch);
      if (!playlist) return reply.code(404).send({ error: "Not found" });
      return { playlist };
    } catch (e) {
      return reply
        .code(400)
        .send({ error: e instanceof Error ? e.message : "Invalid patch" });
    }
  });

  server.delete("/api/me/playlists/:id", async (request, reply) => {
    const me = authPersonal(request, reply);
    if (!me) return;
    const { id } = request.params as { id: string };
    const ok = await removeUserPlaylist(id, me.userId);
    if (!ok) return reply.code(404).send({ error: "Not found" });
    return { ok: true };
  });

  // Cosmetic entry preview for the editor. Personal users can't browse the
  // private library, so we never surface library hits — just classify
  // URL vs. free-form. (A bare title still resolves against the library at
  // *play* time; this only labels the row.)
  server.post("/api/me/playlists/lookup-entry", async (request, reply) => {
    const me = authPersonal(request, reply);
    if (!me) return;
    const body = parseBody(request);
    const source = typeof body.source === "string" ? body.source.trim() : "";
    if (!source) return reply.code(400).send({ error: "Missing source" });
    if (isHttpUrl(source)) return { kind: "url", label: source };
    return { kind: "unknown", label: source };
  });

  // Start a personal playlist in the member's current voice channel. Mirrors
  // POST /api/ext/play: resolve the voice target (explicit guildId or
  // voice.locate), join, then clear+enqueue+play under the guild lock with
  // an epoch guard so a concurrent session change bails cleanly.
  server.post("/api/me/playlists/:id/play", async (request, reply) => {
    const me = authPersonal(request, reply);
    if (!me) return;
    const { id } = request.params as { id: string };
    const pl = await getUserPlaylist(id, me.userId);
    if (!pl) return reply.code(404).send({ error: "Not found" });
    if (pl.entries.length === 0) {
      return reply.code(409).send({ error: "This playlist is empty." });
    }
    const target = await resolveTarget(me.userId, parseBody(request), reply);
    if (!target) return; // resolveTarget already replied (409)
    if (!(await joinOr409(target, me.userId, reply))) return;
    const { tracks } = await resolveEntriesToTracks(pl.entries, me.userId, pl.id);
    if (tracks.length === 0) {
      return reply
        .code(409)
        .send({ error: "None of this playlist's entries could be played right now." });
    }
    const { guildId } = target;
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
      return { ok: true, guildId };
    });
  });

  // ── API keys (self-service; scoped to the caller) ───────────────────
  server.get("/api/me/keys", async (request, reply) => {
    const me = authPersonal(request, reply);
    if (!me) return;
    return { keys: listKeys(me.userId) };
  });

  server.post("/api/me/keys", async (request, reply) => {
    const me = authPersonal(request, reply);
    if (!me) return;
    const body = parseBody(request);
    // Cap the label at the route layer (issueKey trims but doesn't bound
    // length) — same as the manage keys route in web-routes.ts.
    const label = typeof body.label === "string" ? body.label.slice(0, 100) : null;
    const scopes = normalizeScopes(body.scopes);
    const { record, plaintext } = issueKey({ userId: me.userId, label, scopes });
    return { key: record, plaintext };
  });

  server.delete("/api/me/keys/:id", async (request, reply) => {
    const me = authPersonal(request, reply);
    if (!me) return;
    const { id } = request.params as { id: string };
    const ok = revokeKey(id, me.userId);
    if (!ok) return reply.code(404).send({ error: "Not found" });
    return { ok: true };
  });

  // ── favorites (the player ☆ toggle, the add-to-queue autocomplete, and
  //    the /me favorites tab all share these) ──────────────────────────
  server.get("/api/me/favorites", async (request, reply) => {
    const me = authPersonal(request, reply);
    if (!me) return;
    return { favorites: listUserFavorites(me.userId) };
  });

  // ☆ toggle. `source` is the WebUI's per-item key (trackId ?? sourceUrl);
  // label/cover are display caches captured at star time.
  server.post("/api/me/favorites/toggle", async (request, reply) => {
    const me = authPersonal(request, reply);
    if (!me) return;
    const body = parseBody(request);
    try {
      return toggleUserFavorite({
        ownerId: me.userId,
        source: typeof body.source === "string" ? body.source : "",
        label: typeof body.label === "string" ? body.label : undefined,
        coverUrl: typeof body.coverUrl === "string" ? body.coverUrl : undefined,
      });
    } catch (e) {
      return reply
        .code(400)
        .send({ error: e instanceof Error ? e.message : "Invalid favorite" });
    }
  });

  server.delete("/api/me/favorites/:id", async (request, reply) => {
    const me = authPersonal(request, reply);
    if (!me) return;
    const { id } = request.params as { id: string };
    const ok = removeUserFavorite(id, me.userId);
    if (!ok) return reply.code(404).send({ error: "Not found" });
    return { ok: true };
  });

  // Append a favorite to the member's current voice queue (cold-starts if
  // idle). Mirrors POST /api/ext/queue: resolve the target guild (explicit
  // guildId wins, else voice.locate), join only when nothing's playing.
  server.post<{ Params: { id: string } }>(
    "/api/me/favorites/:id/queue",
    async (request, reply) => {
      const me = authPersonal(request, reply);
      if (!me) return;
      const { id } = request.params;
      const fav = getUserFavorite(id, me.userId);
      if (!fav) return reply.code(404).send({ error: "Not found" });
      const target = await resolveTarget(me.userId, parseBody(request), reply);
      if (!target) return; // resolveTarget already replied (409)
      const { tracks } = await resolveEntriesToTracks([fav.source], me.userId);
      if (tracks.length === 0) {
        return reply
          .code(409)
          .send({ error: "This favorite couldn't be played right now." });
      }
      const { guildId } = target;
      const status = (await runtime()
        .voice.status(guildId)
        .catch(() => null)) as { playing?: boolean } | null;
      const coldStart = !status?.playing;
      if (coldStart && !(await joinOr409(target, me.userId, reply))) return;
      const epochAtStart = getEpoch(guildId);
      return withGuildLock(guildId, async () => {
        if (getEpoch(guildId) !== epochAtStart) {
          return reply.code(409).send({ error: "Session changed — retry." });
        }
        keepAdvancing(guildId);
        for (const t of tracks) enqueue(guildId, t);
        if (coldStart) await doNext(guildId);
        await nowPlaying.sync(guildId).catch(() => null);
        return { ok: true, guildId };
      });
    },
  );
}
