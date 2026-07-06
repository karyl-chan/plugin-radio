/**
 * Turning a "source" (a string the user typed, or a stored queue
 * entry) into something the bot can actually play.
 *
 *   resolveAnyTrack(source)        — one Track from a library id/title,
 *                                    a previously-downloaded URL, a
 *                                    YouTube URL (→ live stream), or a
 *                                    station / direct http(s) URL.
 *   resolvePlaylist(url)           — many *lazy* Tracks from a YouTube
 *                                    playlist URL (each `needsResolve`).
 *   playTrack(track, voicePlay)    — resolve (if `needsResolve`) + play a
 *                                    queued Track; returns a PlayOutcome
 *                                    (ok / unresolvable / play-failed).
 *
 * Lives in its own module (no Fastify deps) so the slash-command layer
 * (plugin.ts), the WebUI layer (web-routes.ts) and the advance loop all
 * share one implementation.
 */
import type { Track } from "./queue.js";
import {
  isHttpUrl,
  isYouTubeUrl,
  isYouTubePlaylistUrl,
  resolveMixRecommendations,
  resolvePlaylistEntries,
  resolveStreamUrl,
  youtubeThumbnailUrl,
  youtubeVideoIdFromUrl,
} from "./downloader.js";
import { findBySourceUrl, getTrack, searchTracks } from "./library.js";
import { findPlaylistByName, type Playlist } from "./playlists.js";
import { resolveTrack } from "./format.js";

/**
 * Best-effort probe: does `url` serve an HTML page (a track page that needs
 * yt-dlp extraction — SoundCloud, Bandcamp, Vimeo, …) rather than a direct
 * media file? A HEAD failure / non-HTML content type → treat it as direct
 * media (play it as-is). 5 s budget; follows redirects.
 */
async function looksLikeWebpage(url: string): Promise<boolean> {
  try {
    const res = await fetch(url, {
      method: "HEAD",
      redirect: "follow",
      signal: AbortSignal.timeout(5_000),
    });
    const ct = (res.headers.get("content-type") ?? "").toLowerCase();
    return ct.startsWith("text/html") || ct.startsWith("application/xhtml");
  } catch {
    return false;
  }
}

/** A page URL (YouTube / SoundCloud / …) resolved to a streaming Track. */
function streamTrack(
  pageUrl: string,
  r: { streamUrl: string; title: string; coverUrl?: string },
  userId: string | null,
): Track {
  return {
    url: r.streamUrl,
    label: r.title,
    queuedBy: userId,
    // Keep the page URL — the stream URL is opaque & time-limited; a
    // replay re-resolves a fresh one, and YouTube autoplay seeds off it.
    originUrl: pageUrl,
    ...(r.coverUrl ? { coverUrl: r.coverUrl } : {}),
  };
}

/** Docker-internal URL the bot uses to stream library files (voice.play). */
const PLUGIN_URL = (process.env.PLUGIN_URL || "http://localhost:3000").replace(
  /\/+$/,
  "",
);

/** Turn a stored library track into a playable Track (served from disk). */
export function libraryTrackToTrack(
  t: {
    id: string;
    filename: string;
    title: string;
    coverUrl?: string;
    /** The URL it was downloaded from — kept as `originUrl` (YouTube
     *  autoplay seeds recommendations from it; the WebUI links the track
     *  title to it). */
    sourceUrl?: string;
  },
  userId: string | null,
): Track {
  const originUrl =
    t.sourceUrl && isHttpUrl(t.sourceUrl) ? t.sourceUrl : undefined;
  return {
    url: `${PLUGIN_URL}/internal/audio/${encodeURIComponent(t.filename)}`,
    label: t.title,
    queuedBy: userId,
    trackId: t.id,
    ...(t.coverUrl ? { coverUrl: t.coverUrl } : {}),
    ...(originUrl ? { originUrl } : {}),
  };
}

export { isYouTubePlaylistUrl };

/**
 * Resolve a single `source` into a playable Track. Order:
 *   1. library track by id, then by title substring
 *   2. if `source` is a URL we've already downloaded → that local file
 *   3. YouTube URL → yt-dlp resolves a direct audio stream
 *   4. other http(s) URL that serves an HTML page (SoundCloud / Bandcamp /
 *      Vimeo / … track page) → yt-dlp resolves a stream; if yt-dlp can't,
 *      fall through to (5)
 *   5. else → radio station key / direct http(s) media URL streamed as-is
 * Returns null when nothing matches; **throws** if a YouTube URL fails to
 * resolve (so callers can surface why); for case (4) a yt-dlp failure is
 * swallowed and the URL is handed to ffmpeg raw instead.
 */
export async function resolveAnyTrack(
  source: string,
  userId: string | null,
): Promise<Track | null> {
  const s = (source ?? "").trim();
  if (!s) return null;
  const library = await searchTracks("");
  const byNameOrId =
    library.find((t) => t.id === s) ??
    library.find((t) => t.title.toLowerCase().includes(s.toLowerCase()));
  if (byNameOrId) return libraryTrackToTrack(byNameOrId, userId);

  if (isHttpUrl(s)) {
    const downloaded = await findBySourceUrl(s);
    if (downloaded) return libraryTrackToTrack(downloaded, userId);

    if (isYouTubeUrl(s)) {
      return streamTrack(s, await resolveStreamUrl(s), userId);
    }
    // A non-YouTube page URL (SoundCloud / Bandcamp / …) → extract a
    // stream via yt-dlp. A direct media URL → skip straight to raw play.
    if (await looksLikeWebpage(s)) {
      try {
        return streamTrack(s, await resolveStreamUrl(s), userId);
      } catch {
        /* yt-dlp couldn't extract — fall through to raw play */
      }
    }
  }
  return resolveTrack(s, userId);
}

/**
 * The YouTube video id this track was sourced from — its `originUrl`, or
 * `url` if that is itself a YouTube watch URL. Null for non-YouTube
 * tracks (stations, direct media, library tracks not from YouTube). Used
 * to seed / de-duplicate autoplay recommendations.
 */
export function youtubeVideoIdOf(track: Track): string | null {
  return (
    (track.originUrl ? youtubeVideoIdFromUrl(track.originUrl) : null) ??
    youtubeVideoIdFromUrl(track.url)
  );
}

/**
 * The YouTube "mix" radio for `videoId` as queue-ready *lazy* Tracks
 * (each `needsResolve`, `url` = the watch URL — resolved to a stream
 * right before playback, like playlist entries). The autoplay loop in
 * advance-loop.ts seeds the queue from these; the first entry is usually
 * the seed video itself, so the caller de-duplicates. Throws on yt-dlp
 * failure; returns [] for an invalid id or an empty / unavailable mix.
 */
export async function resolveAutoplayRecommendations(
  videoId: string,
): Promise<Track[]> {
  const entries = await resolveMixRecommendations(videoId);
  return entries.map((e) => {
    // Stamp the i.ytimg cover eagerly so the WebUI has art the moment
    // the refill lands, instead of waiting for playTrack to resolve it.
    const id = youtubeVideoIdFromUrl(e.url);
    const coverUrl = id ? youtubeThumbnailUrl(id) : undefined;
    return {
      url: e.url,
      label: e.title,
      queuedBy: null,
      queuedByName: "Autoplay",
      needsResolve: true,
      ...(coverUrl ? { coverUrl } : {}),
    };
  });
}

/**
 * Expand a YouTube playlist URL into queue-ready Tracks. Each is *lazy*
 * (`needsResolve: true`, `url` = the watch URL) — call
 * `resolveTrackForPlayback` right before playing it. Throws on yt-dlp
 * failure; returns [] for an empty / unavailable playlist.
 */
export async function resolvePlaylist(
  playlistUrl: string,
  userId: string | null,
): Promise<Track[]> {
  const entries = await resolvePlaylistEntries(playlistUrl);
  return entries.map((e) => ({
    url: e.url,
    label: e.title,
    queuedBy: userId,
    needsResolve: true,
  }));
}

/**
 * Resolve a playlist's raw entry strings into queue-ready Tracks, using
 * the same per-entry dispatch as `/radio play`: a URL entry is kept lazy
 * (a fresh stream URL is resolved right before playback, so we don't burn
 * N × yt-dlp seconds under the guild lock just to load a list), while a
 * library id / station key / title is resolved eagerly (cheap local
 * lookup). Failed entries are collected in `skipped` and dropped so one
 * dead link or a since-deleted library track can't block the rest. Each
 * resolved Track is stamped `source: "playlist"` (+ `playlistId`, when
 * given) for provenance.
 *
 * Shared by the manager-owned stored playlists (`resolveStoredPlaylist`)
 * and the per-user personal playlists (the `/me` play route).
 */
/** An entry to resolve: a bare `source` string, or one carrying display
 *  metadata (title + cover) cached when it was saved from a resolved queue
 *  track. The cached meta enriches the resulting Track so a URL entry shows
 *  its real title + cover *before* it's played, instead of the raw link
 *  (URL entries otherwise resolve lazily — see the `needsResolve` branch). */
export interface ResolveEntry {
  source: string;
  label?: string;
  coverUrl?: string;
}

export async function resolveEntriesToTracks(
  entries: ReadonlyArray<string | ResolveEntry>,
  userId: string | null,
  playlistId?: string,
): Promise<{ tracks: Track[]; skipped: string[] }> {
  const tracks: Track[] = [];
  const skipped: string[] = [];
  for (const raw of entries) {
    const entry: ResolveEntry = typeof raw === "string" ? { source: raw } : raw;
    const source = entry.source;
    // A cover for a bare YouTube URL, derivable from the video id without a
    // yt-dlp round-trip — so a lazily-resolved entry still shows art before
    // it's played. Cached meta (from a favorite / saved queue track) wins.
    const ytId = youtubeVideoIdFromUrl(source);
    const cover = entry.coverUrl || (ytId ? youtubeThumbnailUrl(ytId) : undefined);
    let resolved: Track | null;
    if (isHttpUrl(source)) {
      const downloaded = await findBySourceUrl(source);
      resolved = downloaded
        ? libraryTrackToTrack(downloaded, userId)
        : // A bare lazy Track — the shared enrichment block below fills in the
          // cached label + cover uniformly for every branch.
          { url: source, label: source, queuedBy: userId, needsResolve: true };
    } else {
      try {
        resolved = await resolveAnyTrack(source, userId);
      } catch {
        resolved = null;
      }
    }
    if (!resolved) {
      skipped.push(source);
      continue;
    }
    // Enrich a bare/lazy resolve with cached meta: a lazy Track keeps the
    // raw URL as its label — swap in the cached title; and fill a missing
    // cover from the cache or the derived thumbnail.
    if (entry.label && (!resolved.label || resolved.label === source)) {
      resolved.label = entry.label;
    }
    if (!resolved.coverUrl && cover) resolved.coverUrl = cover;
    // Only mark playlist provenance when this really is a stored playlist —
    // the favorite-queue path reuses this resolver for a single favorite and
    // passes no playlistId, so it must NOT be tagged source:"playlist".
    if (playlistId) {
      resolved.source = "playlist";
      resolved.playlistId = playlistId;
    }
    tracks.push(resolved);
  }
  return { tracks, skipped };
}

/**
 * Resolve a stored (manager-owned) playlist by name into queue-ready
 * Tracks. Thin wrapper over `resolveEntriesToTracks`.
 *
 * Returns `null` when no playlist by that name exists; callers fall back
 * to single-source resolution.
 */
export async function resolveStoredPlaylist(
  name: string,
  userId: string | null,
): Promise<{
  playlist: Playlist;
  tracks: Track[];
  skipped: string[];
} | null> {
  const playlist = await findPlaylistByName(name);
  if (!playlist) return null;
  const { tracks, skipped } = await resolveEntriesToTracks(
    playlist.entries,
    userId,
    playlist.id,
  );
  return { playlist, tracks, skipped };
}

/**
 * Outcome of trying to play a track:
 *  - ok          → it's playing; `track` is what to store as `current`
 *  - unresolvable → a lazy entry that couldn't be resolved — drop it
 *  - play-failed  → resolved fine but `voice.play` failed — re-queue & retry
 */
export type PlayOutcome =
  | { ok: true; track: Track }
  | { ok: false; reason: "unresolvable" }
  | { ok: false; reason: "play-failed" };

/**
 * Resolve `track` (re-fetching a fresh stream URL if `needsResolve`) and
 * play it via `voicePlay`. The single place that turns a queued Track into
 * an actual `voice.play` — used by the slash commands, the WebUI session
 * routes and the auto-advance loop.
 *
 * For a `needsResolve` YouTube entry that resolves to a stream (not a
 * since-downloaded local file), the returned `track` keeps `needsResolve`
 * and the original watch URL — so on the next cycle (loop=queue), replay
 * (loop=track) or `/radio back`, it re-resolves a *fresh* stream URL
 * instead of replaying the now-expired one. Only fresher metadata
 * (title / cover) is merged in.
 *
 * `prefetched` lets a caller hand in a resolution it already computed
 * ahead of time (the advance loop pre-resolves the next-up entry while
 * the current track is still playing, so the gap between tracks isn't a
 * fresh yt-dlp call). It's only used for a `needsResolve` `track`; pass
 * `{ resolved: null }` to signal "I tried to pre-resolve and it failed".
 */
export async function playTrack(
  track: Track,
  voicePlay: (url: string) => Promise<unknown | null>,
  prefetched?: { resolved: Track | null },
): Promise<PlayOutcome> {
  let playUrl: string;
  let toStore: Track;
  if (!track.needsResolve) {
    // A library-sourced entry whose track was deleted since it was
    // queued → its file is gone; drop it rather than 404 on every retry.
    // (Lazy `needsResolve` entries never carry a `trackId`, so this only
    // matters on the non-lazy branch.)
    if (track.trackId && !(await getTrack(track.trackId))) {
      return { ok: false, reason: "unresolvable" };
    }
    playUrl = track.url;
    toStore = track;
  } else {
    let resolved: Track | null;
    if (prefetched !== undefined) {
      resolved = prefetched.resolved;
    } else {
      try {
        resolved = await resolveAnyTrack(track.url, track.queuedBy);
      } catch {
        return { ok: false, reason: "unresolvable" };
      }
    }
    if (!resolved) return { ok: false, reason: "unresolvable" };
    if (resolved.trackId) {
      // It's been downloaded since — the local file is stable, stop being lazy.
      playUrl = resolved.url;
      toStore = {
        ...resolved,
        queuedBy: track.queuedBy,
        ...(track.queuedByName ? { queuedByName: track.queuedByName } : {}),
      };
    } else {
      playUrl = resolved.url;
      toStore = {
        url: track.url, // keep the watch URL — re-resolvable next time
        label: resolved.label,
        queuedBy: track.queuedBy,
        ...(track.queuedByName ? { queuedByName: track.queuedByName } : {}),
        needsResolve: true,
        ...(resolved.coverUrl ? { coverUrl: resolved.coverUrl } : {}),
      };
    }
  }
  const res = await Promise.resolve(voicePlay(playUrl)).catch(() => null);
  if (!res) return { ok: false, reason: "play-failed" };
  return { ok: true, track: toStore };
}
