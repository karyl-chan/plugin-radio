import type { FastifyInstance, FastifyReply, FastifyRequest } from "fastify";
import fastifyMultipart from "@fastify/multipart";
import { createReadStream, readFileSync } from "fs";
import { stat } from "fs/promises";
import { join, dirname } from "path";
import { fileURLToPath } from "url";
import {
  hasPluginCapability,
  verifyPluginSession,
  type PluginSessionClaims,
} from "@karyl-chan/plugin-sdk";
import {
  issueManagePair,
  verifyManageToken,
  type ManageClaims,
} from "./manage-tokens.js";
import {
  issueKey,
  listKeys,
  normalizeScopes,
  revokeKey,
} from "./api-keys.js";
import { getMusicDir, isHttpUrl } from "./downloader.js";
import {
  findBySourceUrl,
  getTrack,
  listTracks,
  removeTrack,
  searchTracks,
  syncWithDisk,
  updateTrack,
  uploadAndStore,
  type LibraryTrack,
  type TrackMetadataPatch,
} from "./library.js";
import {
  coverFilePath,
  deleteCoverFor,
  extForMime,
  isSafeCoverFilename,
  mimeForCoverFile,
  saveCover,
} from "./covers.js";
import {
  type LoopMode,
  type Track,
  DEFAULT_AUTOPLAY_FETCH_COUNT,
  clearQueue,
  commitCursor,
  dequeueAt,
  dequeueByQids,
  enqueue,
  getCurrent,
  getEpoch,
  getState,
  peekNext,
  reorderByQid,
  setAutoplay,
  setLoop,
} from "./queue.js";
import {
  doJump,
  doNext,
  doPause,
  doPrev,
  doStop,
} from "./playback-actions.js";
import { withGuildLock } from "./guild-lock.js";
import * as nowPlaying from "./now-playing.js";
import { runtime } from "./runtime.js";
import {
  isYouTubePlaylistUrl,
  libraryTrackToTrack,
  resolveAnyTrack,
  resolvePlaylist,
  resolveStoredPlaylist,
} from "./resolver.js";
import {
  addPlaylist,
  getPlaylist,
  listPlaylists,
  removePlaylist,
  updatePlaylist,
  type Playlist,
  type PlaylistPatch,
} from "./playlists.js";

/** capability key (plugin-local) that gates the admin/manage WebUI routes. */
const MANAGE_CAP = "manage";
/** Files in the music dir that are NOT audio and must never be streamed. */
const NON_AUDIO_RE = /(^library\.json(\.migrated)?$)|(^playlists\.json(\.migrated)?$)|(^radio\.db(-wal|-shm)?$)|(\.tmp$)/;

// ── Deferred wiring from index.ts ─────────────────────────────────────────
// The WebUI routes need things the SDK only produces *after* start()
// resolves — the bot RPC client (voice.play / voice.status), the
// Ed25519 public key the bot hands back at register (for verifying
// plugin-session JWTs), and the bot-provided publicBaseUrl. These routes
// are registered in `onReady`, which runs before the lifecycle client
// exists, so index.ts injects all three once start() resolves.
type BotRpc = (path: string, body?: unknown) => Promise<unknown | null>;
let _botRpc: BotRpc | null = null;
export function setRadioBotRpc(fn: BotRpc): void {
  _botRpc = fn;
}

let _sessionVerifyKey: (() => string | null) | null = null;
/** Wire the getter for the bot's plugin-session JWT verify key (SPKI PEM). */
export function setRadioSessionVerifyKey(getter: () => string | null): void {
  _sessionVerifyKey = getter;
}

let _publicBaseUrlGetter: (() => string | undefined) | null = null;
/** Wire the getter for the SDK-provided publicBaseUrl (set after start()). */
export function setRadioPublicBaseUrl(getter: () => string | undefined): void {
  _publicBaseUrlGetter = getter;
}

/** Env-var fallback — imported from plugin.ts via the same module. */
let _publicUrlEnvFallback: string | undefined;
/** Set the env-var fallback value (called once from plugin.ts at module init). */
export function setPublicUrlEnvFallback(value: string | undefined): void {
  _publicUrlEnvFallback = value;
}

/**
 * Effective browser-reachable base URL for this plugin's HTTP surface.
 * Precedence: SDK publicBaseUrl (from bot) → RADIO_PUBLIC_URL env → last-resort default.
 */
export function effectiveBase(): string {
  const sdkUrl = _publicBaseUrlGetter?.();
  if (sdkUrl) return sdkUrl.replace(/\/+$/, "");
  if (_publicUrlEnvFallback) return _publicUrlEnvFallback;
  return "http://localhost:903";
}

/** Validate a `:filename` path param: single segment, audio file only. */
function safeAudioName(filename: string): boolean {
  return (
    !filename.includes("..") &&
    !filename.includes("/") &&
    !filename.includes("\\") &&
    !NON_AUDIO_RE.test(filename)
  );
}

const LOOP_MODES: LoopMode[] = ["off", "track", "queue"];

/** WebUI-facing shape of a track (no internal URLs leaked). */
function publicTrack(
  t: Track,
  libIndex?: Map<string, LibraryTrack>,
): Record<string, unknown> {
  // The track's user-facing "source": a YouTube/SoundCloud/… page URL it
  // was resolved or downloaded from (kept on the Track as `originUrl`),
  // else a direct http(s) media / station URL — but never the internal
  // `/internal/audio/…` path a downloaded library file is streamed from.
  const sourceUrl =
    t.originUrl ?? (!t.trackId && isHttpUrl(t.url) ? t.url : undefined);
  // Library-sourced tracks carry only `trackId` + `coverUrl` in the queue
  // state — the WebUI also wants the editable metadata (author / album /
  // duration) so the now-playing / queue / played lists can render them
  // alongside the label. Resolve via the optional in-memory library index
  // the caller built so we don't re-load library.json per track.
  const lib = t.trackId ? libIndex?.get(t.trackId) : undefined;
  return {
    label: t.label,
    queuedBy: t.queuedBy,
    ...(t.queuedByName ? { queuedByName: t.queuedByName } : {}),
    ...(t.trackId ? { trackId: t.trackId } : {}),
    ...(t.qid !== undefined ? { qid: t.qid } : {}),
    ...(t.coverUrl ? { coverUrl: t.coverUrl } : {}),
    ...(sourceUrl ? { sourceUrl } : {}),
    ...(t.source ? { source: t.source } : {}),
    ...(t.playlistId ? { playlistId: t.playlistId } : {}),
    ...(lib?.author ? { author: lib.author } : {}),
    ...(lib?.album ? { album: lib.album } : {}),
    ...(lib?.duration != null ? { duration: lib.duration } : {}),
  };
}

/** Build the playback-session snapshot the WebUI polls. */
async function sessionSnapshot(
  guildId: string,
): Promise<Record<string, unknown>> {
  const s = getState(guildId);
  let channelId: string | null = null;
  let paused = false;
  if (_botRpc) {
    const status = (await runtime()
      .voice.status(guildId)
      .catch(() => null)) as { channelId?: string | null; paused?: boolean } | null;
    channelId = status?.channelId ?? null;
    paused = status?.paused === true;
  }
  // Build the library index once — listTracks() reads a cached in-memory
  // array, but Map lookup beats Array.find() across the (current + queue +
  // played) traversal that follows.
  const libIndex = new Map<string, LibraryTrack>();
  for (const lt of await listTracks()) libIndex.set(lt.id, lt);
  const cur = s ? getCurrent(s) : null;
  return {
    guildId,
    channelId,
    paused,
    loop: s?.loop ?? "off",
    autoplay: s?.autoplay ?? false,
    autoplayFetchCount: s?.autoplayFetchCount ?? DEFAULT_AUTOPLAY_FETCH_COUNT,
    // The full ordered playlist + the qid of the cursor's track. The
    // FE renders played / current / upcoming by partitioning this list
    // around cursorQid — no separate queue / played arrays needed.
    playlist: s ? s.tracks.map((t) => publicTrack(t, libIndex)) : [],
    cursorQid: cur?.qid ?? null,
  };
}

/**
 * Sync the public now-playing message (best effort), then return the
 * session snapshot — the response shape every WebUI playback-mutating
 * route hands back. The plain `sessionSnapshot` (no sync) backs the GET
 * poll, which must NOT edit Discord on every refresh.
 */
async function syncAndSnapshot(
  guildId: string,
): Promise<Record<string, unknown>> {
  if (_botRpc) await nowPlaying.sync(guildId).catch(() => null);
  return sessionSnapshot(guildId);
}

/** Max upload size for a cover image. */
const MAX_COVER_BYTES = 5 * 1024 * 1024;

/** Max upload size for a library audio file (manager upload route). */
const MAX_AUDIO_UPLOAD_BYTES = 100 * 1024 * 1024;

export async function registerWebRoutes(
  server: FastifyInstance,
  pluginKey: string,
  /**
   * Getter for the browser-reachable base URL — called per-request so a
   * late-arriving publicBaseUrl from the bot is reflected immediately.
   * Used to build cover image URLs and to inject `window.__PLUGIN_BASE__`
   * into the served HTML.
   */
  getEffectiveBase: () => string,
  /**
   * The set of guilds the auto-advance loop ticks over (owned by
   * plugin.ts). The advance loop is the ONLY thing that auto-plays the
   * next queued track when the current one ends, and it drops a guild
   * from this set the moment its session goes idle — so every WebUI
   * action that adds to the queue or moves playback must (re-)register
   * the guild here, or playback dies after the current track.
   */
  seenGuilds: Set<string>,
): Promise<void> {
  // Multipart accepts both cover (≤ 5 MB) and audio upload (≤ 100 MB) —
  // size the global cap at the larger of the two; per-route handlers
  // check the actual byte count against their own limit.
  await server.register(fastifyMultipart, {
    limits: { fileSize: MAX_AUDIO_UPLOAD_BYTES, files: 1, fields: 6 },
  });

  /** Re-register a guild with the auto-advance loop after a WebUI playback action. */
  const keepAdvancing = (guildId: string): void => {
    seenGuilds.add(guildId);
  };

  /** Verify the Bearer plugin-session JWT. Returns claims or null (after replying). */
  function auth(
    request: FastifyRequest,
    reply: FastifyReply,
  ): PluginSessionClaims | null {
    const verifyKey = _sessionVerifyKey?.() ?? null;
    if (!verifyKey) {
      // The bot hands this key back in the register response. Null means
      // either the first register hasn't completed yet, or the bot is too
      // old to provide it (pre-Ed25519-plugin-session bot).
      reply.code(503).send({
        error:
          "session verification unavailable — plugin not yet registered, or the bot is too old to issue a verification key",
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
    return claims;
  }

  /** Manage bootstrap gate: bot's plugin-session JWT, capability-bearing.
   *  Used only by /api/manage/exchange to mint plugin-side access+refresh. */
  function authManageBootstrap(
    request: FastifyRequest,
    reply: FastifyReply,
  ): PluginSessionClaims | null {
    const claims = auth(request, reply);
    if (!claims) return null;
    if (!hasPluginCapability(claims.capabilities, pluginKey, MANAGE_CAP)) {
      reply.code(403).send({
        error: `Missing capability plugin:${pluginKey}:${MANAGE_CAP} — ask an admin to grant it to your role.`,
      });
      return null;
    }
    return claims;
  }

  /** Manage gate for the day-to-day /api/tracks* routes: plugin-issued
   *  access token only. The bot JWT is intentionally NOT accepted here
   *  — clients have to exchange it once and then live on plugin tokens. */
  function authManageAccess(
    request: FastifyRequest,
    reply: FastifyReply,
  ): ManageClaims | null {
    const header = request.headers.authorization;
    const token = header?.startsWith("Bearer ") ? header.slice(7) : null;
    if (!token) {
      reply.code(401).send({ error: "Missing authorization" });
      return null;
    }
    const claims = verifyManageToken(token, "manage-access");
    if (!claims) {
      reply.code(401).send({ error: "Invalid or expired access token" });
      return null;
    }
    if (!hasPluginCapability(claims.capabilities, pluginKey, MANAGE_CAP)) {
      reply.code(403).send({
        error: `Missing capability plugin:${pluginKey}:${MANAGE_CAP} — ask an admin to grant it to your role.`,
      });
      return null;
    }
    return claims;
  }

  /** Session gate: token must be scoped to the guild in the path. */
  function authSession(
    request: FastifyRequest,
    reply: FastifyReply,
    guildId: string,
  ): PluginSessionClaims | null {
    const claims = auth(request, reply);
    if (!claims) return null;
    if (claims.guildId !== guildId) {
      reply.code(403).send({ error: "Token is not valid for this session" });
      return null;
    }
    return claims;
  }

  // Sync library with disk once on route registration.
  void syncWithDisk();

  // ── Manage session tokens (plugin-issued, swap for bot JWT) ──────────
  //
  // The bot's plugin-session JWT (15 min) only crosses the wire once,
  // here: the SPA reads it from `?token=`, POSTs to /exchange, and
  // from then on lives on the plugin's own short-lived access token
  // (5 min) + 1-day refresh — kept in sessionStorage so the tab can
  // self-renew without going back to the bot. Process restart wipes
  // the HMAC secret in manage-tokens.ts, so all outstanding manage
  // sessions invalidate at once (the kill-switch).

  server.post("/api/manage/exchange", async (request, reply) => {
    const claims = authManageBootstrap(request, reply);
    if (!claims) return;
    // Carry only the manage-relevant subset; the bot already filtered
    // session/other-plugin caps out before signing the JWT.
    return issueManagePair(claims.userId, claims.capabilities ?? []);
  });

  server.post<{ Body: { refreshToken?: unknown } }>(
    "/api/manage/refresh",
    async (request, reply) => {
      let body: { refreshToken?: unknown };
      try {
        body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : (request.body as { refreshToken?: unknown });
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }
      const refresh =
        typeof body?.refreshToken === "string" ? body.refreshToken : null;
      if (!refresh) {
        return reply.code(400).send({ error: "refreshToken required" });
      }
      const claims = verifyManageToken(refresh, "manage-refresh");
      if (!claims) {
        return reply
          .code(401)
          .send({ error: "Invalid or expired refresh token" });
      }
      // Re-issue both halves on every refresh (stateless rotation): the
      // refresh window stretches forward, capped at REFRESH_TTL_MS per
      // call — so a tab kept open keeps refreshing, while a tab that
      // sits idle past REFRESH_TTL_MS naturally lapses.
      return issueManagePair(claims.userId, claims.capabilities);
    },
  );

  // ── Manage WebUI: library management ────────────────────────────────────
  server.get<{ Querystring: { q?: string } }>(
    "/api/tracks",
    async (request, reply) => {
      if (!authManageAccess(request, reply)) return;
      const tracks = await searchTracks(request.query?.q ?? "");
      return { tracks };
    },
  );

  server.get<{ Params: { id: string } }>(
    "/api/tracks/:id",
    async (request, reply) => {
      if (!authManageAccess(request, reply)) return;
      const track = await getTrack(request.params.id);
      if (!track) return reply.code(404).send({ error: "Not found" });
      return { track };
    },
  );

  server.patch<{ Params: { id: string } }>(
    "/api/tracks/:id",
    async (request, reply) => {
      if (!authManageAccess(request, reply)) return;
      let body: TrackMetadataPatch;
      try {
        body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : (request.body as TrackMetadataPatch);
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }
      if (!body || typeof body !== "object") {
        return reply.code(400).send({ error: "body must be an object" });
      }
      try {
        const track = await updateTrack(request.params.id, {
          title: body.title,
          album: body.album,
          author: body.author,
          coverUrl: body.coverUrl,
        });
        if (!track) return reply.code(404).send({ error: "Not found" });
        return { track };
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : "invalid input",
        });
      }
    },
  );

  server.delete<{ Params: { id: string } }>(
    "/api/tracks/:id",
    async (request, reply) => {
      if (!authManageAccess(request, reply)) return;
      const ok = await removeTrack(request.params.id);
      if (!ok) return reply.code(404).send({ error: "Not found" });
      return { ok: true };
    },
  );

  // Upload an image file to use as the track's cover. multipart/form-data
  // with a single `file` part. Stored under COVER_DIR/<trackId>.<ext>;
  // coverUrl is set to <effectiveBase()>/cover/<filename>.
  server.post<{ Params: { id: string } }>(
    "/api/tracks/:id/cover",
    async (request, reply) => {
      if (!authManageAccess(request, reply)) return;
      const id = request.params.id;
      const track = await getTrack(id);
      if (!track) return reply.code(404).send({ error: "Not found" });
      let file;
      try {
        // Per-call cap — the global multipart limit is sized for the
        // (much larger) audio-upload route, so the cover route narrows
        // it back down to its own 5 MB image budget here.
        file = await request.file({ limits: { fileSize: MAX_COVER_BYTES } });
      } catch {
        return reply.code(400).send({ error: "Expected a multipart upload" });
      }
      if (!file) return reply.code(400).send({ error: "No file uploaded" });
      const ext = extForMime(file.mimetype || "");
      if (!ext) {
        return reply
          .code(415)
          .send({ error: "Unsupported image type (use jpeg/png/webp/gif)" });
      }
      let buf: Buffer;
      try {
        buf = await file.toBuffer();
      } catch {
        return reply
          .code(413)
          .send({ error: `Image too large (max ${MAX_COVER_BYTES >> 20} MB)` });
      }
      if (buf.length === 0) {
        return reply.code(400).send({ error: "Empty file" });
      }
      const filename = await saveCover(id, buf, ext);
      // Append a cache-busting query param keyed on upload time. Without
      // it, replacing a cover with another of the same mimetype yields
      // an identical `<id>.<ext>` URL and browsers happily serve the
      // stale image from disk cache.
      const coverUrl = `${getEffectiveBase()}/cover/${filename}?v=${Date.now()}`;
      try {
        const updated = await updateTrack(id, { coverUrl });
        return { track: updated };
      } catch (err) {
        // updateTrack rejected the URL (e.g. effectiveBase() misconfigured)
        // — don't leave the just-written file orphaned.
        await deleteCoverFor(id);
        return reply.code(500).send({
          error: `Couldn't set cover URL: ${err instanceof Error ? err.message : "error"}`,
        });
      }
    },
  );

  // ── Manage WebUI: playlists ──────────────────────────────────────────
  //
  // A playlist is a named, ordered list of source strings (anything
  // /radio play accepts). At play time each entry is fed through the
  // same resolveAnyTrack dispatch as the slash command — so a single
  // playlist can mix library tracks, station keys, watch URLs and
  // direct media URLs. Same auth gate as /api/tracks*.

  server.get("/api/playlists", async (request, reply) => {
    if (!authManageAccess(request, reply)) return;
    const playlists = await listPlaylists();
    return { playlists };
  });

  server.get<{ Params: { id: string } }>(
    "/api/playlists/:id",
    async (request, reply) => {
      if (!authManageAccess(request, reply)) return;
      const playlist = await getPlaylist(request.params.id);
      if (!playlist) return reply.code(404).send({ error: "Not found" });
      return { playlist };
    },
  );

  server.post("/api/playlists", async (request, reply) => {
    const claims = authManageAccess(request, reply);
    if (!claims) return;
    let body: { name?: unknown; description?: unknown; entries?: unknown };
    try {
      body =
        typeof request.body === "string"
          ? JSON.parse(request.body)
          : (request.body as typeof body);
    } catch {
      return reply.code(400).send({ error: "Invalid JSON" });
    }
    if (!body || typeof body !== "object") {
      return reply.code(400).send({ error: "body must be an object" });
    }
    try {
      const playlist = await addPlaylist({
        name: body.name as string,
        description: body.description as string | undefined,
        entries: body.entries as string[] | undefined,
        createdBy: claims.userId,
      });
      return { playlist };
    } catch (err) {
      return reply.code(400).send({
        error: err instanceof Error ? err.message : "invalid input",
      });
    }
  });

  server.patch<{ Params: { id: string } }>(
    "/api/playlists/:id",
    async (request, reply) => {
      if (!authManageAccess(request, reply)) return;
      let body: PlaylistPatch;
      try {
        body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : (request.body as PlaylistPatch);
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }
      if (!body || typeof body !== "object") {
        return reply.code(400).send({ error: "body must be an object" });
      }
      try {
        const playlist = await updatePlaylist(request.params.id, {
          name: body.name,
          description: body.description,
          entries: body.entries,
        });
        if (!playlist) return reply.code(404).send({ error: "Not found" });
        return { playlist };
      } catch (err) {
        return reply.code(400).send({
          error: err instanceof Error ? err.message : "invalid input",
        });
      }
    },
  );

  server.delete<{ Params: { id: string } }>(
    "/api/playlists/:id",
    async (request, reply) => {
      if (!authManageAccess(request, reply)) return;
      const ok = await removePlaylist(request.params.id);
      if (!ok) return reply.code(404).send({ error: "Not found" });
      return { ok: true };
    },
  );

  // Resolve a single source string into a preview — used by the playlist
  // editor to show a friendly label / cover for each entry the admin
  // pastes, so an opaque UUID or URL doesn't sit there raw. The endpoint
  // never plays anything; it just tells the WebUI what /radio play would
  // see for that string.
  server.post("/api/playlists/lookup-entry", async (request, reply) => {
    if (!authManageAccess(request, reply)) return;
    let body: { source?: unknown };
    try {
      body =
        typeof request.body === "string"
          ? JSON.parse(request.body)
          : (request.body as { source?: unknown });
    } catch {
      return reply.code(400).send({ error: "Invalid JSON" });
    }
    const source =
      typeof body?.source === "string" ? body.source.trim() : "";
    if (!source) return reply.code(400).send({ error: "Missing source" });

    // Library hits resolve synchronously without yt-dlp; URL hits need
    // network. The lookup follows resolveAnyTrack's dispatch order but
    // never blocks on yt-dlp — for a URL we don't have downloaded yet
    // we just echo back the URL as the label so the UI stays snappy.
    const lib = await searchTracks("");
    const direct =
      lib.find((t) => t.id === source) ??
      lib.find((t) =>
        t.title.toLowerCase().includes(source.toLowerCase()),
      );
    if (direct) {
      const track = libraryTrackToTrack(direct, null);
      return {
        kind: "library",
        trackId: direct.id,
        label: direct.title,
        ...(direct.author ? { author: direct.author } : {}),
        ...(direct.album ? { album: direct.album } : {}),
        ...(track.coverUrl ? { coverUrl: track.coverUrl } : {}),
      };
    }
    if (isHttpUrl(source)) {
      const downloaded = await findBySourceUrl(source);
      if (downloaded) {
        const track = libraryTrackToTrack(downloaded, null);
        return {
          kind: "library",
          trackId: downloaded.id,
          label: downloaded.title,
          ...(downloaded.author ? { author: downloaded.author } : {}),
          ...(downloaded.album ? { album: downloaded.album } : {}),
          ...(track.coverUrl ? { coverUrl: track.coverUrl } : {}),
        };
      }
      return { kind: "url", label: source };
    }
    return { kind: "unknown", label: source };
  });

  // Manager-only audio upload — multipart/form-data with `file` (required)
  // and optional `title` / `author` / `album` text fields. The file is
  // hashed and saved into MUSIC_DIR under a stable `upload-<hash>.<ext>`
  // name, so re-uploading the same bytes is idempotent. The library row's
  // sourceUrl is `upload://<hash>` (not a fetchable URL) — it exists only
  // to give the dedupe path a key.
  server.post("/api/tracks/upload", async (request, reply) => {
    const claims = authManageAccess(request, reply);
    if (!claims) return;
    let mp;
    try {
      mp = await request.file({
        limits: { fileSize: MAX_AUDIO_UPLOAD_BYTES },
      });
    } catch {
      return reply.code(400).send({ error: "Expected a multipart upload" });
    }
    if (!mp) return reply.code(400).send({ error: "No file uploaded" });
    // Pull the optional metadata fields out of the same form. `mp.fields`
    // is keyed by name; each entry is `{ value: <string> }` for plain text.
    const fieldText = (key: string): string => {
      const f = (mp as unknown as { fields: Record<string, unknown> }).fields?.[
        key
      ];
      if (!f || typeof f !== "object") return "";
      const v = (f as { value?: unknown }).value;
      return typeof v === "string" ? v.trim() : "";
    };
    const titleField = fieldText("title");
    const author = fieldText("author");
    const album = fieldText("album");
    let buf: Buffer;
    try {
      buf = await mp.toBuffer();
    } catch {
      return reply.code(413).send({
        error: `Audio file too large (max ${MAX_AUDIO_UPLOAD_BYTES >> 20} MB)`,
      });
    }
    // Default the title to the upload's basename (sans extension) so the
    // manager doesn't have to type one for the common "drag the file in"
    // case.
    const fallbackTitle = (mp.filename || "upload")
      .replace(/\.[^.]+$/, "")
      .trim();
    const title = titleField || fallbackTitle;
    try {
      const result = await uploadAndStore({
        data: buf,
        mime: mp.mimetype || "",
        title,
        ...(author ? { author } : {}),
        ...(album ? { album } : {}),
        addedBy: claims.userId,
      });
      return reply
        .code(result.alreadyExisted ? 200 : 201)
        .send(result);
    } catch (err) {
      const msg = err instanceof Error ? err.message : "upload failed";
      return reply.code(400).send({ error: msg });
    }
  });

  // ── Manage WebUI: external-control API keys ─────────────────────────────
  //
  // CRUD for the `rk_…` keys that authenticate the /api/ext/* control
  // channel (browser extension, etc.). Same manage gate as /api/tracks*;
  // keys are bound to the manager's own userId (the manage token's
  // identity), so a manager only ever sees / mints / revokes their own.

  server.get("/api/keys", async (request, reply) => {
    const claims = authManageAccess(request, reply);
    if (!claims) return;
    return { keys: listKeys(claims.userId) };
  });

  server.post("/api/keys", async (request, reply) => {
    const claims = authManageAccess(request, reply);
    if (!claims) return;
    let body: { label?: unknown; scopes?: unknown };
    try {
      body =
        typeof request.body === "string"
          ? JSON.parse(request.body)
          : (request.body as { label?: unknown; scopes?: unknown });
    } catch {
      return reply.code(400).send({ error: "Invalid JSON" });
    }
    const label =
      typeof body?.label === "string" ? body.label.slice(0, 100) : null;
    const { record, plaintext } = issueKey({
      userId: claims.userId,
      label,
      scopes: normalizeScopes(body?.scopes),
    });
    // The plaintext crosses the wire exactly once, here — the client must
    // surface it to the user immediately (it's only stored hashed).
    return { key: record, plaintext };
  });

  server.delete<{ Params: { id: string } }>(
    "/api/keys/:id",
    async (request, reply) => {
      const claims = authManageAccess(request, reply);
      if (!claims) return;
      const ok = revokeKey(request.params.id, claims.userId);
      if (!ok) return reply.code(404).send({ error: "Not found" });
      return { ok: true };
    },
  );

  // ── Session WebUI: playback control ─────────────────────────────────────
  server.get<{ Params: { guildId: string } }>(
    "/api/session/:guildId",
    async (request, reply) => {
      const { guildId } = request.params;
      if (!authSession(request, reply, guildId)) return;
      return sessionSnapshot(guildId);
    },
  );

  // Per-guild batching for /next: a rapid burst of skip clicks would
  // otherwise trigger one voice.play per click (each tearing down and
  // restarting the bot's audio stream a few ms later — audible as
  // stuttering). We collect all /next requests that arrive within a
  // short window into a single batch keyed on guild: every /next during
  // that window resolves to the same final snapshot, and we advance the
  // queue past the intermediate tracks (committing each via setCurrent
  // so history / playLog reflect them) and call voice.play only once,
  // on the final destination.
  //
  // 90 ms is below the human "this felt instant" threshold (~100 ms),
  // short enough not to feel laggy on an isolated click, but long
  // enough to catch a 5-click spam.
  const SKIP_COALESCE_MS = 90;
  interface SkipBatch {
    count: number;
    waiters: Array<{
      resolve: (snap: Record<string, unknown>) => void;
      reject: (err: unknown) => void;
    }>;
  }
  const skipBatches = new Map<string, SkipBatch>();

  function scheduleSkip(
    guildId: string,
  ): Promise<Record<string, unknown>> {
    return new Promise((resolve, reject) => {
      const existing = skipBatches.get(guildId);
      if (existing) {
        existing.count++;
        existing.waiters.push({ resolve, reject });
        return;
      }
      const batch: SkipBatch = {
        count: 1,
        waiters: [{ resolve, reject }],
      };
      skipBatches.set(guildId, batch);
      setTimeout(() => drainSkipBatch(guildId), SKIP_COALESCE_MS);
    });
  }

  async function drainSkipBatch(guildId: string): Promise<void> {
    const batch = skipBatches.get(guildId);
    if (!batch) return;
    skipBatches.delete(guildId);
    if (!_botRpc) {
      const err = new Error("bot RPC unavailable");
      for (const w of batch.waiters) w.reject(err);
      return;
    }
    try {
      const snap = await withGuildLock(guildId, async () => {
        keepAdvancing(guildId);
        // Walk the cursor past `batch.count - 1` tracks without playing
        // them so the final doNext is the only voice.play of this burst.
        // peekNext + commitCursor lets us skip safely under any loop
        // mode (track → no-op; queue → wraps; off → stops at end).
        for (let i = 0; i < batch.count - 1; i++) {
          const peek = peekNext(guildId);
          if (!peek) break;
          commitCursor(guildId, peek.idx);
        }
        await doNext(guildId);
        return syncAndSnapshot(guildId);
      });
      for (const w of batch.waiters) w.resolve(snap);
    } catch (err) {
      for (const w of batch.waiters) w.reject(err);
    }
  }

  server.post<{ Params: { guildId: string } }>(
    "/api/session/:guildId/next",
    async (request, reply) => {
      const { guildId } = request.params;
      if (!authSession(request, reply, guildId)) return;
      if (!_botRpc)
        return reply.code(503).send({ error: "bot RPC unavailable" });
      return scheduleSkip(guildId);
    },
  );

  server.post<{ Params: { guildId: string } }>(
    "/api/session/:guildId/prev",
    async (request, reply) => {
      const { guildId } = request.params;
      if (!authSession(request, reply, guildId)) return;
      return withGuildLock(guildId, async () => {
        keepAdvancing(guildId);
        if (!_botRpc)
          return reply.code(503).send({ error: "bot RPC unavailable" });
        const r = await doPrev(guildId);
        if (r.kind === "no-history")
          return reply.code(409).send({ error: "Nothing to go back to" });
        return syncAndSnapshot(guildId);
      });
    },
  );

  // ⏯ Pause / resume. Body `{ paused: bool }` to force a state, omit to
  // toggle. Mirrors the np-embed pause button.
  server.post<{ Params: { guildId: string } }>(
    "/api/session/:guildId/pause",
    async (request, reply) => {
      const { guildId } = request.params;
      if (!authSession(request, reply, guildId)) return;
      let body: { paused?: unknown } | undefined;
      try {
        body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : (request.body as { paused?: unknown });
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }
      const wantPaused =
        body && typeof body.paused === "boolean" ? body.paused : undefined;
      return withGuildLock(guildId, async () => {
        if (!_botRpc)
          return reply.code(503).send({ error: "bot RPC unavailable" });
        await doPause(guildId, wantPaused);
        return syncAndSnapshot(guildId);
      });
    },
  );

  // ⏹ Stop: clear queue, leave voice. Mirrors the np-embed stop button.
  // Session lives on (the WebUI link stays usable for queueing new tracks).
  server.post<{ Params: { guildId: string } }>(
    "/api/session/:guildId/stop",
    async (request, reply) => {
      const { guildId } = request.params;
      if (!authSession(request, reply, guildId)) return;
      return withGuildLock(guildId, async () => {
        if (!_botRpc)
          return reply.code(503).send({ error: "bot RPC unavailable" });
        await doStop(guildId);
        return syncAndSnapshot(guildId);
      });
    },
  );

  server.post<{ Params: { guildId: string } }>(
    "/api/session/:guildId/loop",
    async (request, reply) => {
      const { guildId } = request.params;
      if (!authSession(request, reply, guildId)) return;
      let body: { mode?: string };
      try {
        body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : (request.body as { mode?: string });
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }
      const mode = body?.mode;
      if (!mode || !LOOP_MODES.includes(mode as LoopMode)) {
        return reply.code(400).send({ error: "mode must be off/track/queue" });
      }
      return withGuildLock(guildId, async () => {
        keepAdvancing(guildId);
        setLoop(guildId, mode as LoopMode);
        return syncAndSnapshot(guildId);
      });
    },
  );

  server.post<{ Params: { guildId: string } }>(
    "/api/session/:guildId/autoplay",
    async (request, reply) => {
      const { guildId } = request.params;
      if (!authSession(request, reply, guildId)) return;
      let body: { on?: unknown };
      try {
        body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : (request.body as { on?: unknown });
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }
      if (typeof body?.on !== "boolean") {
        return reply.code(400).send({ error: "`on` (boolean) required" });
      }
      const on = body.on;
      return withGuildLock(guildId, async () => {
        keepAdvancing(guildId);
        setAutoplay(guildId, on);
        return syncAndSnapshot(guildId);
      });
    },
  );

  server.post<{ Params: { guildId: string } }>(
    "/api/session/:guildId/queue",
    async (request, reply) => {
      const { guildId } = request.params;
      const claims = authSession(request, reply, guildId);
      if (!claims) return;
      let body: { source?: string };
      try {
        body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : (request.body as { source?: string });
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }
      const source = (body?.source ?? "").trim();
      // queuedBy=null: the session token's userId is "who started the
      // session" (whoever last minted the cached token), not necessarily
      // whoever is clicking the WebUI now — don't misattribute.
      // Resolve outside the lock (it's a read, and can take seconds); only
      // the enqueue + sync below run under it.
      //
      // Snapshot the session epoch before the (slow) resolve. If
      // anything bumps it during resolve (`/radio play <new>` ran
      // `clearQueue`, or `/radio stop` ran `reset`), the resolved
      // tracks are stale and we drop them rather than enqueue into
      // a session that's moved on.
      const epochAtStart = getEpoch(guildId);
      let toQueue: Track[];
      if (isYouTubePlaylistUrl(source)) {
        try {
          toQueue = await resolvePlaylist(source, null);
        } catch (err) {
          return reply.code(400).send({
            error: `Couldn't expand that playlist: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`,
          });
        }
        if (toQueue.length === 0) {
          return reply
            .code(400)
            .send({ error: "Playlist is empty or unavailable" });
        }
      } else {
        // Stored playlist? Resolve it the same way the slash command
        // does — single dispatch, mixed entry types — before falling
        // back to a single source.
        const stored = await resolveStoredPlaylist(source, null);
        if (stored) {
          if (stored.tracks.length === 0) {
            return reply.code(400).send({
              error: `Playlist "${stored.playlist.name}" has no playable entries`,
            });
          }
          toQueue = stored.tracks;
        } else {
          let track: Track | null;
          try {
            track = await resolveAnyTrack(source, null);
          } catch (err) {
            return reply.code(400).send({
              error: `Couldn't resolve that source: ${err instanceof Error ? err.message.slice(0, 200) : "error"}`,
            });
          }
          if (!track) {
            return reply.code(400).send({ error: "Unknown station/track/URL" });
          }
          toQueue = [track];
        }
      }
      return withGuildLock(guildId, async () => {
        if (getEpoch(guildId) !== epochAtStart) {
          // Session was cleared / reset while we were resolving — abort
          // rather than push these tracks into a different session.
          return reply.code(409).send({
            error:
              "Session changed while resolving — please retry from the current state.",
          });
        }
        keepAdvancing(guildId);
        for (const t of toQueue) enqueue(guildId, t);
        return syncAndSnapshot(guildId);
      });
    },
  );

  server.post<{ Params: { guildId: string; index: string } }>(
    "/api/session/:guildId/dequeue/:index",
    async (request, reply) => {
      const { guildId } = request.params;
      if (!authSession(request, reply, guildId)) return;
      const idx = Number(request.params.index);
      return withGuildLock(guildId, async () => {
        keepAdvancing(guildId);
        const removed = dequeueAt(guildId, idx);
        if (!removed)
          return reply.code(404).send({ error: "No such queue item" });
        return syncAndSnapshot(guildId);
      });
    },
  );

  // Batch dequeue: { qids: number[] }. The WebUI debounces rapid ✕
  // clicks into one window and hits this once, so even removing 10
  // items costs one bot RPC pair (status + Discord message edit)
  // instead of N. Unknown qids are silently no-op — the auto-advance
  // loop or another caller may have already removed them.
  server.post<{ Params: { guildId: string } }>(
    "/api/session/:guildId/dequeue",
    async (request, reply) => {
      const { guildId } = request.params;
      if (!authSession(request, reply, guildId)) return;
      let body: { qids?: unknown };
      try {
        body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : (request.body as { qids?: unknown });
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }
      const raw = body?.qids;
      if (!Array.isArray(raw))
        return reply.code(400).send({ error: "qids must be an array" });
      const qids: number[] = [];
      for (const v of raw) {
        if (typeof v === "number" && Number.isInteger(v) && v > 0) qids.push(v);
      }
      return withGuildLock(guildId, async () => {
        keepAdvancing(guildId);
        dequeueByQids(guildId, qids);
        return syncAndSnapshot(guildId);
      });
    },
  );

  server.post<{ Params: { guildId: string } }>(
    "/api/session/:guildId/clear",
    async (request, reply) => {
      const { guildId } = request.params;
      if (!authSession(request, reply, guildId)) return;
      return withGuildLock(guildId, async () => {
        clearQueue(guildId);
        return syncAndSnapshot(guildId);
      });
    },
  );

  // Jump the cursor onto any track in the playlist by qid. The user
  // clicked a played track to step back, or an upcoming track to skip
  // ahead — both are the same operation against the unified playlist.
  server.post<{ Params: { guildId: string } }>(
    "/api/session/:guildId/jump",
    async (request, reply) => {
      const { guildId } = request.params;
      if (!authSession(request, reply, guildId)) return;
      let body: { qid?: unknown };
      try {
        body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : (request.body as { qid?: unknown });
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }
      const qid = body?.qid;
      if (typeof qid !== "number" || !Number.isInteger(qid) || qid <= 0) {
        return reply.code(400).send({ error: "qid must be a positive integer" });
      }
      return withGuildLock(guildId, async () => {
        keepAdvancing(guildId);
        if (!_botRpc)
          return reply.code(503).send({ error: "bot RPC unavailable" });
        const r = await doJump(guildId, qid);
        if (r.kind === "no-such-qid")
          return reply.code(404).send({ error: "No such track (refresh and retry)" });
        return syncAndSnapshot(guildId);
      });
    },
  );

  // Drag-reorder: move `qid` to immediately before `beforeQid` (or to
  // the end when beforeQid is null). The currently-playing track keeps
  // playing — the cursor anchors to its qid through the move.
  server.post<{ Params: { guildId: string } }>(
    "/api/session/:guildId/reorder",
    async (request, reply) => {
      const { guildId } = request.params;
      if (!authSession(request, reply, guildId)) return;
      let body: { qid?: unknown; beforeQid?: unknown };
      try {
        body =
          typeof request.body === "string"
            ? JSON.parse(request.body)
            : (request.body as { qid?: unknown; beforeQid?: unknown });
      } catch {
        return reply.code(400).send({ error: "Invalid JSON" });
      }
      const qid = body?.qid;
      const beforeQid = body?.beforeQid;
      if (typeof qid !== "number" || !Number.isInteger(qid) || qid <= 0) {
        return reply.code(400).send({ error: "qid must be a positive integer" });
      }
      const before =
        beforeQid === null || beforeQid === undefined
          ? null
          : typeof beforeQid === "number" &&
              Number.isInteger(beforeQid) &&
              beforeQid > 0
            ? beforeQid
            : NaN;
      if (Number.isNaN(before)) {
        return reply
          .code(400)
          .send({ error: "beforeQid must be a positive integer or null" });
      }
      return withGuildLock(guildId, async () => {
        keepAdvancing(guildId);
        const ok = reorderByQid(guildId, qid, before);
        if (!ok)
          return reply.code(404).send({ error: "Unknown qid (refresh and retry)" });
        return syncAndSnapshot(guildId);
      });
    },
  );

  // ── Audio streaming ─────────────────────────────────────────────────────
  server.get<{ Params: { filename: string } }>(
    "/audio/:filename",
    async (request, reply) => {
      // Manage cap required: raw-file download is a manager concern,
      // not something a session listener needs (in-channel playback
      // goes through the bot via /internal/audio).
      if (!authManageAccess(request, reply)) return;
      const filename = request.params.filename;
      if (!safeAudioName(filename)) {
        return reply.code(400).send({ error: "Invalid filename" });
      }
      const filepath = join(getMusicDir(), filename);
      try {
        const st = await stat(filepath);
        reply.header("Content-Type", "audio/ogg");
        reply.header("Content-Length", st.size);
        return reply.send(createReadStream(filepath));
      } catch {
        return reply.code(404).send({ error: "File not found" });
      }
    },
  );

  // Internal audio endpoint — no auth, only reachable within the Docker
  // network. Used by the bot's voice.play. Audio files only (never
  // library.json / *.tmp — see safeAudioName).
  server.get<{ Params: { filename: string } }>(
    "/internal/audio/:filename",
    async (request, reply) => {
      const filename = request.params.filename;
      if (!safeAudioName(filename)) {
        return reply.code(400).send({ error: "Invalid filename" });
      }
      const filepath = join(getMusicDir(), filename);
      try {
        const st = await stat(filepath);
        reply.header("Content-Type", "audio/ogg");
        reply.header("Content-Length", st.size);
        return reply.send(createReadStream(filepath));
      } catch {
        return reply.code(404).send({ error: "File not found" });
      }
    },
  );

  // Uploaded cover images — no auth (just pictures; the bot also fetches
  // these for Discord embeds). Strict single-segment <id>.<ext> filename.
  server.get<{ Params: { filename: string } }>(
    "/cover/:filename",
    async (request, reply) => {
      const filename = request.params.filename;
      if (!isSafeCoverFilename(filename)) {
        return reply.code(400).send({ error: "Invalid filename" });
      }
      const filepath = coverFilePath(filename);
      try {
        const st = await stat(filepath);
        reply.header("Content-Type", mimeForCoverFile(filename));
        reply.header("Content-Length", st.size);
        reply.header("Cache-Control", "public, max-age=86400");
        // bytes are admin-uploaded — never let a browser sniff them as HTML
        reply.header("X-Content-Type-Options", "nosniff");
        return reply.send(createReadStream(filepath));
      } catch {
        return reply.code(404).send({ error: "File not found" });
      }
    },
  );

  // ── SPA ─────────────────────────────────────────────────────────────────
  // The Vue source under web/ is built by Vite into a single-file bundle at
  // dist/ui/index.html (all JS+CSS inlined — see vite.config.ts) so that the
  // existing inline-only CSP and per-request __PLUGIN_BASE__ injection still
  // work unchanged. Both the prod runtime (where this module is dist/web-routes.js)
  // and `tsx watch src/web-routes.ts` resolve to the same dist/ui location.
  const __dirname = dirname(fileURLToPath(import.meta.url));
  let htmlContent: string;
  try {
    htmlContent = readFileSync(join(__dirname, "ui", "index.html"), "utf-8");
  } catch {
    htmlContent = readFileSync(
      join(__dirname, "..", "dist", "ui", "index.html"),
      "utf-8",
    );
  }
  server.get("/", async (_request, reply) => {
    reply.header("Content-Type", "text/html; charset=utf-8");
    // Inline JS/CSS SPA; outbound resources: same-origin uploaded covers
    // + external https thumbnail URLs.
    reply.header(
      "Content-Security-Policy",
      "default-src 'none'; img-src 'self' https: data:; style-src 'unsafe-inline'; " +
        "script-src 'unsafe-inline'; connect-src 'self'; base-uri 'none'; form-action 'none'",
    );
    reply.header("X-Content-Type-Options", "nosniff");
    reply.header("Referrer-Policy", "no-referrer");

    // Inject the path part of effectiveBase() so the SPA knows its prefix
    // when served through the bot proxy (e.g. /plugin/karyl-radio). Done
    // per-request so a late-arriving publicBaseUrl is picked up immediately.
    let basePath = "";
    try {
      basePath = new URL(getEffectiveBase()).pathname.replace(/\/+$/, "");
    } catch {
      // Malformed URL — leave basePath empty; SPA falls back to same-origin.
    }
    const injectedScript = `<script>window.__PLUGIN_BASE__=${JSON.stringify(basePath)}</script>`;
    const html = htmlContent.replace("<head>", `<head>${injectedScript}`);

    return reply.send(html);
  });
}
