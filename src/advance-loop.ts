import type { Logger } from "@karyl-chan/plugin-sdk";
import {
  type GuildState,
  type Track,
  commitCursor,
  endSession,
  enqueue,
  getCurrent,
  getPlayed,
  getUpcoming,
  getState,
  peekNext,
  removeTrackAt,
} from "./queue.js";
import {
  playTrack,
  resolveAnyTrack,
  resolveAutoplayRecommendations,
  youtubeVideoIdOf,
} from "./resolver.js";
import { doStop } from "./playback-actions.js";
import { withGuildLock } from "./guild-lock.js";
import * as nowPlaying from "./now-playing.js";

type BotRpc = (path: string, body?: unknown) => Promise<unknown | null>;

// Poll fast so a finished track is followed up within ~1 s rather than up
// to 5 s. Cheap — `voice.status` is an in-memory lookup on the bot; the
// inFlight guard below means a tick that runs long (a yt-dlp resolve)
// just makes the next ticks skip that guild rather than pile up.
const ADVANCE_INTERVAL_MS = 1_000;

// End a session if the bot's voice channel has had no human listeners for
// this long. `lastListenerAt` maps guild → the last tick at which we saw
// ≥1 listener (or couldn't tell — we conservatively treat "unknown" as
// "someone's there" so a transient hiccup never auto-stops).
const EMPTY_CHANNEL_STOP_MS = 60_000;
const lastListenerAt = new Map<string, number>();

// Guilds currently being processed. A tick can do a yt-dlp stream
// resolution for lazy (playlist / autoplay) tracks, which takes longer
// than the tick interval — without this guard a slow guild's next tick
// would run concurrently and double-play / clobber `current`.
const inFlight = new Set<string>();

/**
 * Exponential backoff for `voice.status` RPC failures, per guild.
 * Without it, a 30 s bot restart with 20 active guilds floods 20 req/s
 * of failing RPCs into the bot for the whole window. Cleared on the
 * first successful response.
 */
const rpcBackoff = new Map<
  string,
  { failures: number; nextAttemptAt: number }
>();
/** First retry waits 1 s; doubles per failure; caps at 30 s. */
const RPC_BACKOFF_BASE_MS = 1_000;
const RPC_BACKOFF_MAX_MS = 30_000;
function recordRpcFailure(guildId: string): void {
  const cur = rpcBackoff.get(guildId);
  const failures = (cur?.failures ?? 0) + 1;
  const delay = Math.min(
    RPC_BACKOFF_BASE_MS * 2 ** (failures - 1),
    RPC_BACKOFF_MAX_MS,
  );
  rpcBackoff.set(guildId, {
    failures,
    nextAttemptAt: Date.now() + delay,
  });
}
function clearRpcBackoff(guildId: string): void {
  rpcBackoff.delete(guildId);
}
function isBackoffActive(guildId: string): boolean {
  const cur = rpcBackoff.get(guildId);
  return cur !== undefined && cur.nextAttemptAt > Date.now();
}

// Pre-resolved next-up track per guild: while the current track plays we
// kick off the (slow) yt-dlp resolve for `queue[0]` so it's ready the
// moment the current one ends. Keyed by guild → { the lazy entry's url,
// the in-flight/settled resolution }. Cleared when the head changes
// (url-mismatch on consume) or the session ends.
const prefetched = new Map<
  string,
  { url: string; promise: Promise<Track | null> }
>();

/** Ensure the guild's next-up lazy track is being pre-resolved. */
function ensurePrefetch(guildId: string): void {
  const s = getState(guildId);
  const head = s ? getUpcoming(s)[0] : undefined;
  if (!head?.needsResolve) {
    prefetched.delete(guildId);
    return;
  }
  const pf = prefetched.get(guildId);
  if (pf && pf.url === head.url) return; // already prefetching this one
  prefetched.set(guildId, {
    url: head.url,
    promise: resolveAnyTrack(head.url, head.queuedBy).catch(() => null),
  });
}

/** True when this guild has nothing left to play and isn't looping. */
function isIdle(guildId: string): boolean {
  const s = getState(guildId);
  if (!s) return true;
  if (s.done) return true;
  if (s.loop !== "off") return false;
  // Nothing playing AND nothing upcoming.
  return !getCurrent(s) && getUpcoming(s).length === 0;
}

/** Video id to seed autoplay from: the current track's YouTube origin if
 *  it has one, else the most recently played YouTube track this session. */
function autoplaySeedVideoId(s: GuildState): string | null {
  const cur = getCurrent(s);
  const fromCurrent = cur ? youtubeVideoIdOf(cur) : null;
  if (fromCurrent) return fromCurrent;
  const played = getPlayed(s);
  for (let i = played.length - 1; i >= 0; i--) {
    const id = youtubeVideoIdOf(played[i]);
    if (id) return id;
  }
  return null;
}

/**
 * Decide whether the guild wants an autoplay refill right now, and if
 * so claim the seed under the lock so a concurrent tick can't fire
 * the same fetch. Caller runs this inside `withGuildLock`; the yt-dlp
 * mix call happens OUTSIDE the lock (Phase 2); then
 * `applyAutoplayRecs` re-enters the lock to enqueue (Phase 3).
 *
 * Splitting the fetch out of the lock keeps a 10 s mix resolve from
 * blocking every slash command / WebUI op on this guild for that
 * whole window — used to all be one critical section.
 */
function planAutoplayRefill(guildId: string): string | null {
  const s = getState(guildId);
  if (!s || !s.autoplay || s.loop !== "off") return null;
  if (getUpcoming(s).length > 0) return null;
  const seedId = autoplaySeedVideoId(s);
  if (!seedId || seedId === s.autoplaySeededFrom) return null;
  // Claim the seed under the lock — debounces concurrent ticks for
  // the duration of the (unlocked) yt-dlp call.
  s.autoplaySeededFrom = seedId;
  return seedId;
}

/**
 * Enqueue autoplay recommendations under the lock. Re-validates that
 * the session still wants this seed's recs — autoplay may have been
 * toggled off, the user may have queued tracks manually, or loop mode
 * may have changed while we were fetching.
 */
function applyAutoplayRecs(
  guildId: string,
  seedId: string,
  recs: Track[],
  log: Logger,
): void {
  const s = getState(guildId);
  if (!s) return;
  if (!s.autoplay || s.loop !== "off") return;
  if (s.autoplaySeededFrom !== seedId) return;
  if (getUpcoming(s).length > 0) return;

  // Skip the seed itself and anything already in the playlist this
  // session — and don't repeat a video within the same batch.
  const seen = new Set<string>([seedId]);
  for (const t of s.tracks) {
    const id = youtubeVideoIdOf(t);
    if (id) seen.add(id);
  }
  const want = s.autoplayFetchCount;
  let queued = 0;
  for (const t of recs) {
    if (queued >= want) break;
    const id = youtubeVideoIdOf(t);
    if (id === null || seen.has(id)) continue;
    seen.add(id);
    // Mark provenance so the WebUI "Clear ♾️ autoplay" button can wipe
    // these without touching user-queued entries.
    t.source = "autoplay";
    enqueue(guildId, t);
    queued++;
  }
  if (queued === 0) {
    log.info("autoplay: mix had nothing fresh", { guildId, seedId });
    return;
  }
  log.info("autoplay: queued recommendations", { guildId, seedId, count: queued });
}

type VoiceStatus = {
  connected?: boolean;
  playing?: boolean;
  channelId?: string | null;
  paused?: boolean;
  listeners?: number;
};

/**
 * Phase 1 (under lock): early-exit checks + claim an autoplay seed
 * if eligible. Returns `{ status, seedId }` for Phase 2; null tells
 * the caller to terminate this tick.
 */
async function probePhase(
  guildId: string,
  botRpc: BotRpc,
  log: Logger,
  seenGuilds: Set<string>,
): Promise<{ status: VoiceStatus; seedId: string | null } | null> {
  return withGuildLock(guildId, async () => {
    if (isIdle(guildId)) {
      seenGuilds.delete(guildId);
      prefetched.delete(guildId);
      await nowPlaying.teardown(guildId, botRpc).catch(() => {});
      return null;
    }
    const status = (await botRpc("/api/plugin/voice.status", {
      guild_id: guildId,
    })) as VoiceStatus | null;
    if (!status) {
      // RPC blip — record the failure and start / extend the
      // exponential backoff so a multi-second bot outage doesn't see
      // every active guild spam-retrying every 1 s.
      recordRpcFailure(guildId);
      return null;
    }
    clearRpcBackoff(guildId);
    if (!status.connected) {
      seenGuilds.delete(guildId);
      prefetched.delete(guildId);
      lastListenerAt.delete(guildId);
      await nowPlaying.teardown(guildId, botRpc).catch(() => {});
      return null;
    }
    // Auto-end the session once the bot's voice channel has been
    // empty of human listeners for EMPTY_CHANNEL_STOP_MS.
    const now = Date.now();
    if (status.listeners === 0) {
      const since = lastListenerAt.get(guildId);
      if (since !== undefined && now - since > EMPTY_CHANNEL_STOP_MS) {
        log.info(
          "advance: voice channel empty for >1min — stopping session",
          { guildId },
        );
        seenGuilds.delete(guildId);
        prefetched.delete(guildId);
        lastListenerAt.delete(guildId);
        await doStop(guildId, botRpc).catch(() => {});
        await nowPlaying.teardown(guildId, botRpc).catch(() => {});
        return null;
      }
      if (since === undefined) lastListenerAt.set(guildId, now);
    } else {
      lastListenerAt.set(guildId, now);
    }
    const seedId = planAutoplayRefill(guildId);
    return { status, seedId };
  });
}

/**
 * Phase 3 (under lock): apply any autoplay recs fetched outside the
 * lock, then run the normal advance work.
 */
async function advancePhase(
  guildId: string,
  botRpc: BotRpc,
  log: Logger,
  seenGuilds: Set<string>,
  status: VoiceStatus,
  refill: { seedId: string; recs: Track[] } | null,
): Promise<void> {
  return withGuildLock(guildId, async () => {
    if (refill) applyAutoplayRecs(guildId, refill.seedId, refill.recs, log);
    if (!status.playing) {
      const candidate = peekNext(guildId);
      if (candidate) {
        // If we pre-resolved this exact entry while the last track
        // was playing, use that — no fresh yt-dlp call between songs.
        const pf = prefetched.get(guildId);
        prefetched.delete(guildId);
        const hint =
          candidate.track.needsResolve && pf && pf.url === candidate.track.url
            ? { resolved: await pf.promise }
            : undefined;
        const outcome = await playTrack(
          candidate.track,
          (url) =>
            botRpc("/api/plugin/voice.play", { guild_id: guildId, url }),
          hint,
        );
        if (outcome.ok) {
          commitCursor(guildId, candidate.idx);
        } else if (outcome.reason === "play-failed") {
          // Transient — leave the cursor where it was so the next
          // tick re-attempts the same lazy entry with a fresh resolve.
          log.warn("advance: voice.play failed, leaving cursor for retry", {
            guildId,
            url: candidate.track.url,
          });
        } else {
          // Deleted / private / region-blocked entry — drop it from
          // the playlist entirely; next tick picks whatever now sits
          // at cursor+1.
          removeTrackAt(guildId, candidate.idx);
          log.warn("advance: dropping unplayable track", {
            guildId,
            url: candidate.track.url,
          });
        }
      } else {
        // Nothing to advance to and autoplay didn't refill — mark
        // done so isIdle below tears the session down.
        endSession(guildId);
      }
    }
    // The advance above may have drained the queue — if so, the
    // session is done: tear down rather than flashing a "nothing
    // playing" card.
    if (isIdle(guildId)) {
      seenGuilds.delete(guildId);
      prefetched.delete(guildId);
      await nowPlaying.teardown(guildId, botRpc).catch(() => {});
      return;
    }
    // Pre-resolve the (new) next-up track so the next hand-off is
    // gapless.
    ensurePrefetch(guildId);
    // Keep the public now-playing message current (cheap — hash-
    // gated; reuses the voice status we already fetched).
    await nowPlaying.sync(guildId, botRpc, { status }).catch(() => {});
  });
}

async function processGuild(
  guildId: string,
  botRpc: BotRpc,
  log: Logger,
  seenGuilds: Set<string>,
): Promise<void> {
  if (inFlight.has(guildId)) return;
  // Honour the per-guild RPC backoff so a bot outage doesn't have
  // every active guild firing voice.status every 1 s for the whole
  // window. The probe phase below clears the backoff on success.
  if (isBackoffActive(guildId)) return;
  inFlight.add(guildId);
  try {
    // Two-phase tick under the same `inFlight` guard:
    //
    //   Phase 1 (lock) — voice.status, listener tracking, claim an
    //   autoplay seed if eligible.
    //   Phase 2 (no lock) — yt-dlp resolve autoplay recommendations.
    //     Other slash commands / WebUI ops on this guild can run
    //     during this window. The seed claim from Phase 1 prevents
    //     concurrent refills.
    //   Phase 3 (lock) — apply recs (re-validated for stale state),
    //   then the normal peek/play/commit/prefetch.
    //
    // Splitting the autoplay yt-dlp out of the lock prevents a 10 s
    // mix fetch from blocking every other op on the guild.
    const probe = await probePhase(guildId, botRpc, log, seenGuilds);
    if (!probe) return;
    let recs: Track[] | null = null;
    if (probe.seedId) {
      try {
        recs = await resolveAutoplayRecommendations(probe.seedId);
      } catch (err) {
        log.warn("autoplay: mix fetch failed", {
          guildId,
          seedId: probe.seedId,
          err: String(err),
        });
        recs = null;
      }
    }
    const refill =
      probe.seedId && recs ? { seedId: probe.seedId, recs } : null;
    await advancePhase(guildId, botRpc, log, seenGuilds, probe.status, refill);
  } finally {
    inFlight.delete(guildId);
  }
}

export function startAdvanceLoop(
  botRpc: BotRpc,
  log: Logger,
  seenGuilds: Set<string>,
): NodeJS.Timeout {
  const timer = setInterval(() => {
    const snapshot = [...seenGuilds];
    void Promise.all(
      snapshot.map((guildId) =>
        processGuild(guildId, botRpc, log, seenGuilds).catch((err) => {
          log.warn("advance: processGuild errored", {
            guildId,
            err: String(err),
          });
        }),
      ),
    );
  }, ADVANCE_INTERVAL_MS);
  timer.unref();
  return timer;
}
