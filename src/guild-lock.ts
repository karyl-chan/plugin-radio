/**
 * Per-guild serialization for playback-state mutations.
 *
 * The queue / current / loop / autoplay state in queue.ts is shared
 * between the `/radio` slash handler, the now-playing message buttons,
 * the WebUI session routes, and the 1-second auto-advance loop — and most
 * of those do several `await`s (a yt-dlp resolve can take seconds)
 * between reading and writing it. Without ordering, a loop tick can land
 * in the middle of a `/radio play`, run `advance()` / `requeueFront()` /
 * the autoplay `enqueue()`, and leave the queue inconsistent (e.g. a
 * track sitting in both `current` and the queue).
 *
 * `withGuildLock(guildId, fn)` runs `fn` only after every previously
 * queued critical section for that guild has settled — a per-guild
 * promise chain. Sections for *different* guilds still run in parallel.
 *
 * NOT reentrant: never call `withGuildLock` for a guild from inside an
 * `fn` already holding that guild's lock — it would deadlock. The shared
 * playback helpers (doNext / doPrev / doStop / playTrack / …) therefore
 * never lock themselves; only the entry points (command handlers, button
 * handlers, WebUI routes, the advance loop) do.
 */
const chains = new Map<string, Promise<unknown>>();

export function withGuildLock<T>(
  guildId: string,
  fn: () => Promise<T>,
): Promise<T> {
  const prev = chains.get(guildId) ?? Promise.resolve();
  // Run `fn` once `prev` settles, success OR failure — a thrown critical
  // section must not wedge the chain for the guild.
  const result = prev.then(fn, fn);
  // Store a never-rejecting link so an unhandled rejection from one
  // section can't crash the process; the real outcome still propagates to
  // *this* caller via `result`.
  const link: Promise<unknown> = result.then(
    () => undefined,
    () => undefined,
  );
  chains.set(guildId, link);
  // Drop the entry once it's the settled tail, so an idle guild doesn't
  // retain a resolved promise indefinitely.
  void link.then(() => {
    if (chains.get(guildId) === link) chains.delete(guildId);
  });
  return result;
}
