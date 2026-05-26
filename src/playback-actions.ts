/**
 * Shared playback-mutation actions.
 *
 * The "skip past dead tracks" / "step back" / "stop & leave" / "pause"
 * logic was duplicated between the `/radio` slash handler and the WebUI
 * session routes; it now lives here so the now-playing message buttons
 * (and any future caller) reuse it too. No Fastify deps — callers pass a
 * `botRpc`, so this works from a command handler, an HTTP route or a
 * background interval alike.
 *
 * These functions do NOT register the guild with the auto-advance loop
 * (`seenGuilds.add`) — that's the caller's job, since not every caller
 * has (or should have) the `seenGuilds` set in scope.
 */
import {
  type LoopMode,
  type Track,
  commitCursor,
  endSession,
  peekNext,
  peekPrev,
  peekQid,
  removeTrackAt,
  reset,
} from "./queue.js";
import { playTrack } from "./resolver.js";
import { runtime } from "./runtime.js";

/** Re-exported for callers that still want the raw botRpc surface. */
export type BotRpc = (path: string, body?: unknown) => Promise<unknown | null>;

const voicePlay =
  (guildId: string) =>
  (url: string): Promise<unknown | null> =>
    runtime().voice.play({ guildId, url });

/** Cycle the loop mode: off → track → queue → off. */
export function cycleLoopMode(mode: LoopMode): LoopMode {
  return mode === "off" ? "track" : mode === "track" ? "queue" : "off";
}

export type NextResult =
  /** A track is now playing. */
  | { kind: "playing"; track: Track }
  /** Queue ran dry — playback was stopped. */
  | { kind: "queue-empty" }
  /** Resolved fine but `voice.play` failed — re-queued at the front to retry. */
  | { kind: "play-failed"; track: Track }
  /** Skipped past several unplayable tracks and gave up — try again. */
  | { kind: "exhausted" };

/**
 * Advance to the next playlist entry, skipping past entries that can't
 * be resolved (deleted / private playlist items) — up to a few hops.
 * Asks the bot to stop playback when nothing's left to play.
 */
export async function doNext(guildId: string): Promise<NextResult> {
  const play = voicePlay(guildId);
  for (let attempt = 0; attempt < 5; attempt++) {
    const candidate = peekNext(guildId);
    if (!candidate) {
      // Mark done BEFORE stopping voice — the WebUI's `voice.status` poll
      // in the next snapshot will see `done=true` so getCurrent reports
      // null and NowPlayingCard shows "Nothing playing" instead of the
      // last-played track frozen mid-row.
      endSession(guildId);
      await runtime().voice.stop(guildId).catch(() => null);
      return { kind: "queue-empty" };
    }
    const o = await playTrack(candidate.track, play);
    if (o.ok) {
      commitCursor(guildId, candidate.idx);
      return { kind: "playing", track: o.track };
    }
    if (o.reason === "play-failed") {
      // Cursor unchanged — the lazy entry stays at its current index
      // so the caller / next tick can re-attempt with a fresh resolve.
      return { kind: "play-failed", track: candidate.track };
    }
    // Unresolvable: drop this track from the playlist and try again.
    removeTrackAt(guildId, candidate.idx);
  }
  return { kind: "exhausted" };
}

export type PrevResult =
  | { kind: "playing"; track: Track }
  /** `voice.play` failed; kept as current unless it's a lazy (re-resolvable) entry. */
  | { kind: "play-failed"; track: Track }
  | { kind: "no-history" };

/** Step back to the most recently played track. */
export async function doPrev(guildId: string): Promise<PrevResult> {
  const candidate = peekPrev(guildId);
  if (!candidate) return { kind: "no-history" };
  const o = await playTrack(candidate.track, voicePlay(guildId));
  if (o.ok) {
    commitCursor(guildId, candidate.idx);
    return { kind: "playing", track: o.track };
  }
  // Transient failure for a non-lazy entry → still commit so the user
  // sees their requested prev as "now playing" (the file is fine; the
  // bot will retry on its next tick). Lazy entries that won't resolve
  // are left alone — committing to a track we can't actually play would
  // lie about playback state.
  if (!candidate.track.needsResolve) commitCursor(guildId, candidate.idx);
  return { kind: "play-failed", track: candidate.track };
}

export type JumpResult =
  | { kind: "playing"; track: Track }
  | { kind: "play-failed"; track: Track }
  | { kind: "no-such-qid" };

/**
 * Jump the cursor onto a specific qid (forward or backward in the
 * playlist). Same try-play-commit pattern as doNext / doPrev: only
 * commit the cursor on a successful voice.play; on a transient failure
 * leave the cursor where it was; on an unresolvable lazy entry, drop
 * it and report failure (the caller will refresh & try elsewhere).
 */
export async function doJump(
  guildId: string,
  qid: number,
): Promise<JumpResult> {
  const candidate = peekQid(guildId, qid);
  if (!candidate) return { kind: "no-such-qid" };
  const o = await playTrack(candidate.track, voicePlay(guildId));
  if (o.ok) {
    commitCursor(guildId, candidate.idx);
    return { kind: "playing", track: o.track };
  }
  if (!candidate.track.needsResolve) commitCursor(guildId, candidate.idx);
  return { kind: "play-failed", track: candidate.track };
}

/** Stop playback, clear the queue, leave voice. */
export async function doStop(guildId: string): Promise<void> {
  const voice = runtime().voice;
  await Promise.all([voice.stop(guildId), voice.leave(guildId)]);
  reset(guildId);
}

/**
 * Pause / resume the current track. `paused` undefined → toggle. Returns
 * the resulting paused state (best-effort — false if the RPC failed).
 */
export async function doPause(
  guildId: string,
  paused?: boolean,
): Promise<{ paused: boolean }> {
  const res = (await runtime()
    .voice.pause(paused !== undefined ? { guildId, paused } : { guildId })
    .catch(() => null)) as { paused?: boolean } | null;
  return { paused: res?.paused === true };
}
