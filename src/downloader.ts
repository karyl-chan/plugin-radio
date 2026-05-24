import { spawn } from "child_process";
import { mkdir } from "fs/promises";
import { mkdirSync } from "fs";

/** http(s) URL with no characters that would break out of an HTML attribute. */
const SAFE_HTTPS_URL_RE = /^https?:\/\/[^\s"'<>\\]+$/i;

/** A page URL (YouTube / SoundCloud / …) resolved to a directly-streamable
 *  audio URL (+ metadata). */
export interface ResolvedStream {
  /** Direct CDN media URL ffmpeg can read. Time-limited (~hours). */
  streamUrl: string;
  title: string;
  /** Thumbnail URL, if the site provided a plain http(s) one. */
  coverUrl?: string;
  duration: number | null;
}

const MUSIC_DIR = process.env.MUSIC_DIR || "/app/data/music";

export function getMusicDir(): string {
  return MUSIC_DIR;
}

export async function ensureMusicDir(): Promise<void> {
  await mkdir(MUSIC_DIR, { recursive: true });
}

export function ensureMusicDirSync(): void {
  mkdirSync(MUSIC_DIR, { recursive: true });
}

/**
 * Resolve a page URL from any yt-dlp-supported site (YouTube, SoundCloud,
 * Bandcamp, Vimeo, …) into a direct audio stream URL ffmpeg can play, plus
 * the title / thumbnail / duration. Throws if yt-dlp fails or returns
 * nothing usable. The stream URL is signed and time-limited — fine for
 * immediate playback, but a track that may sit queued for hours can go
 * stale before it's played; a manager can sidestep that by uploading
 * the audio file into the library through the manage WebUI.
 *
 * Format preference: `webm` audio first (YouTube's Opus), then the best
 * *non-HLS* audio (e.g. SoundCloud's progressive MP3 — the ffmpeg
 * pipeline streams those cleanly), then any best audio (HLS as a last
 * resort), then any best.
 */
export async function resolveStreamUrl(url: string): Promise<ResolvedStream> {
  const out = await runYtDlp([
    "-f",
    "bestaudio[ext=webm]/bestaudio[protocol!=m3u8][protocol!=m3u8_native]/bestaudio/best",
    "--no-playlist",
    "--no-warnings",
    "--print",
    "%(title)s",
    "--print",
    "%(thumbnail)s",
    "--print",
    "%(duration)s",
    "--print",
    "%(urls)s",
    url,
  ]);
  const lines = out.split("\n").map((l) => l.trim());
  // Output order matches the --print flags above; the stream URL(s) is
  // last (may be >1 line if the chosen "format" is split — take the first).
  const streamUrl = lines.filter((l) => SAFE_HTTPS_URL_RE.test(l)).pop() ?? "";
  if (!streamUrl) {
    throw new Error("yt-dlp returned no playable stream URL");
  }
  const title = lines[0] && lines[0] !== "NA" ? lines[0] : "audio";
  const thumb = lines[1];
  const coverUrl =
    thumb && thumb !== "NA" && SAFE_HTTPS_URL_RE.test(thumb)
      ? thumb
      : undefined;
  const durNum = Number(lines[2]);
  const duration = Number.isFinite(durNum) && durNum > 0 ? durNum : null;
  return { streamUrl, title, ...(coverUrl ? { coverUrl } : {}), duration };
}

/** One entry of an expanded playlist (flat — no per-video network fetch). */
export interface PlaylistEntry {
  /** Canonical watch URL, e.g. https://www.youtube.com/watch?v=<id>. */
  url: string;
  title: string;
}

/** Hard cap on how many playlist entries we expand into the queue. */
export const PLAYLIST_MAX_ENTRIES = 100;

/**
 * Expand a YouTube playlist URL into its entries (flat — fast, no
 * per-video extraction). Capped at `maxEntries` (default
 * PLAYLIST_MAX_ENTRIES). Throws if yt-dlp fails; returns [] if the
 * playlist is empty / unavailable.
 */
export async function resolvePlaylistEntries(
  playlistUrl: string,
  maxEntries: number = PLAYLIST_MAX_ENTRIES,
): Promise<PlaylistEntry[]> {
  const out = await runYtDlp([
    "--flat-playlist",
    "--no-warnings",
    "--playlist-end",
    String(Math.max(1, Math.floor(maxEntries))),
    "--print",
    "%(url)s",
    "--print",
    "%(title)s",
    playlistUrl,
  ]);
  // Each entry prints exactly two lines: <url>\n<title> (YouTube titles
  // never contain newlines). Pair them up; skip any entry whose first
  // line isn't an http(s) URL (defensive against unexpected output).
  const lines = out.split("\n").map((l) => l.trim());
  const entries: PlaylistEntry[] = [];
  for (let i = 0; i + 1 < lines.length; i += 2) {
    const url = lines[i];
    const title = lines[i + 1];
    if (!SAFE_HTTPS_URL_RE.test(url)) {
      // Output drifted (or a blank trailing line) — re-sync by stepping 1.
      i -= 1;
      continue;
    }
    entries.push({
      url,
      title: title && title !== "NA" ? title : "YouTube video",
    });
  }
  return entries;
}

/** How many entries we pull from a YouTube auto-mix when seeding
 *  autoplay — enough headroom to still hand back a full batch after
 *  de-duping recently played tracks. */
export const MIX_FETCH_MAX = 50;

/**
 * Pull the auto-generated YouTube "Mix" radio for `videoId`
 * (`watch?v=<id>&list=RD<id>`) as flat entries — used to seed autoplay
 * recommendations. The first entry is usually the seed video itself, so
 * callers de-duplicate. Throws on yt-dlp failure; returns [] for an
 * invalid id or an empty / unavailable mix.
 */
export async function resolveMixRecommendations(
  videoId: string,
): Promise<PlaylistEntry[]> {
  if (!/^[\w-]{11}$/.test(videoId)) return [];
  return resolvePlaylistEntries(
    `https://www.youtube.com/watch?v=${videoId}&list=RD${videoId}`,
    MIX_FETCH_MAX,
  );
}

/** Hard timeout for a yt-dlp invocation. Without this a hung yt-dlp could
 *  block the 5 s advance loop forever. The resolve / playlist / mix paths
 *  are all metadata-only fetches that finish well inside this. */
const DEFAULT_YTDLP_TIMEOUT_MS = 120_000;

/**
 * Cap on yt-dlp processes that may run concurrently. Each one peaks
 * around 80-150 MB RSS (Python runtime + yt-dlp bytecode); 20 guilds
 * hitting `needsResolve` at the same tick used to spawn 20 in parallel
 * → multi-GB RAM spike + Google rate-limiting on the source-IP.
 *
 * 4 is a conservative default; tune via env if running on a large
 * host. Calls that exceed the cap queue rather than throw, so the
 * advance loop just waits its turn rather than failing the play.
 */
const YTDLP_MAX_CONCURRENCY = (() => {
  const raw = parseInt(process.env.RADIO_YTDLP_MAX_CONCURRENCY ?? "", 10);
  return Number.isFinite(raw) && raw > 0 ? raw : 4;
})();

let ytdlpInflight = 0;
const ytdlpWaiters: Array<() => void> = [];

function acquireYtdlpSlot(): Promise<void> {
  if (ytdlpInflight < YTDLP_MAX_CONCURRENCY) {
    ytdlpInflight++;
    return Promise.resolve();
  }
  return new Promise<void>((resolve) => {
    ytdlpWaiters.push(() => {
      ytdlpInflight++;
      resolve();
    });
  });
}

function releaseYtdlpSlot(): void {
  ytdlpInflight--;
  const next = ytdlpWaiters.shift();
  if (next) next();
}

async function runYtDlp(
  args: string[],
  timeoutMs: number = DEFAULT_YTDLP_TIMEOUT_MS,
): Promise<string> {
  await acquireYtdlpSlot();
  try {
    return await spawnYtDlp(args, timeoutMs);
  } finally {
    releaseYtdlpSlot();
  }
}

function spawnYtDlp(args: string[], timeoutMs: number): Promise<string> {
  return new Promise((resolve, reject) => {
    const proc = spawn("yt-dlp", args, { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    let stderr = "";
    let settled = false;
    const finish = (fn: () => void) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      fn();
    };
    const timer = setTimeout(() => {
      proc.kill("SIGKILL");
      finish(() =>
        reject(
          new Error(`yt-dlp timed out after ${Math.round(timeoutMs / 1000)}s`),
        ),
      );
    }, timeoutMs);

    proc.stdout.on("data", (chunk: Buffer) => {
      stdout += chunk.toString();
    });

    proc.stderr.on("data", (chunk: Buffer) => {
      stderr += chunk.toString();
    });

    proc.on("close", (code) => {
      finish(() => {
        if (code === 0) resolve(stdout);
        else
          reject(new Error(`yt-dlp exited ${code}: ${stderr.slice(0, 500)}`));
      });
    });

    proc.on("error", (err) => {
      finish(() => reject(new Error(`Failed to spawn yt-dlp: ${err.message}`)));
    });
  });
}

export function isYouTubeUrl(url: string): boolean {
  try {
    const u = new URL(url);
    return (
      u.hostname === "youtube.com" ||
      u.hostname === "www.youtube.com" ||
      u.hostname === "m.youtube.com" ||
      u.hostname === "youtu.be" ||
      u.hostname === "music.youtube.com"
    );
  } catch {
    return false;
  }
}

/** True iff `s` parses as an http(s) URL — used by the resolver to tell
 *  station / library / URL inputs apart, and by the upload route to reject
 *  obvious non-files in pasted source fields. */
export function isHttpUrl(s: string): boolean {
  try {
    const u = new URL(s);
    return u.protocol === "http:" || u.protocol === "https:";
  } catch {
    return false;
  }
}

/**
 * True iff `s` is a YouTube **playlist** URL — `…/playlist?list=<id>`.
 * A `watch?v=X&list=Y` is deliberately NOT a playlist here (it's the
 * single video X); paste the `/playlist?list=` form to queue the list.
 */
export function isYouTubePlaylistUrl(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  if (!isYouTubeUrl(s)) return false;
  return (
    u.pathname.replace(/\/+$/, "") === "/playlist" &&
    !!u.searchParams.get("list")
  );
}

/**
 * True iff `s` is a YouTube URL carrying a non-empty `list=` query param
 * — a Mix/radio share (`watch?v=X&list=RD…`) or a `/playlist?list=…`.
 * The radio plugin treats such a link as "keep this going" and switches
 * autoplay on for the guild.
 */
export function isYouTubeUrlWithList(s: string): boolean {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return false;
  }
  return isYouTubeUrl(s) && !!u.searchParams.get("list");
}

/** Extract the 11-char YouTube video id from a watch / youtu.be / embed URL. */
function youtubeVideoId(u: URL): string | null {
  if (u.hostname === "youtu.be") {
    const id = u.pathname.split("/").filter(Boolean)[0];
    return id && /^[\w-]{11}$/.test(id) ? id : null;
  }
  const v = u.searchParams.get("v");
  if (v && /^[\w-]{11}$/.test(v)) return v;
  // /embed/<id>, /shorts/<id>, /v/<id> — anchor the segment end so a
  // longer (junk-padded) path can't be silently truncated to 11 chars.
  const m = u.pathname.match(/^\/(?:embed|shorts|v)\/([\w-]{11})(?:[/?#]|$)/);
  return m ? m[1] : null;
}

/**
 * The 11-char YouTube video id from any watch / youtu.be / embed /
 * shorts / music URL string, or null if `s` isn't a parseable YouTube
 * video URL. (Public wrapper over the internal URL-form helper.)
 */
export function youtubeVideoIdFromUrl(s: string): string | null {
  let u: URL;
  try {
    u = new URL(s);
  } catch {
    return null;
  }
  if (!isYouTubeUrl(s)) return null;
  return youtubeVideoId(u);
}

/** Deterministic YouTube cover-art URL for `videoId`. Every video id has
 *  a `hqdefault.jpg` served from i.ytimg, so callers can stamp this
 *  eagerly without a per-track network call. */
export function youtubeThumbnailUrl(videoId: string): string {
  return `https://i.ytimg.com/vi/${videoId}/hqdefault.jpg`;
}

/**
 * Canonicalize a source URL for de-duplication. YouTube links (any of
 * the watch / youtu.be / embed / shorts / music forms, with or without
 * extra `&t=` / `&list=` params) collapse to
 * `https://www.youtube.com/watch?v=<id>`. Other URLs just have their
 * fragment stripped. Non-URL input is returned trimmed, unchanged.
 */
export function canonicalSourceUrl(url: string): string {
  const trimmed = (url ?? "").trim();
  let u: URL;
  try {
    u = new URL(trimmed);
  } catch {
    return trimmed;
  }
  const ytHosts = new Set([
    "youtube.com",
    "www.youtube.com",
    "m.youtube.com",
    "music.youtube.com",
    "youtu.be",
  ]);
  if (ytHosts.has(u.hostname)) {
    const id = youtubeVideoId(u);
    if (id) return `https://www.youtube.com/watch?v=${id}`;
  }
  u.hash = "";
  return u.href;
}
