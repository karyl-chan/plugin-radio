/**
 * Shared runtime handle for radio. Wired once at startup by `index.ts`
 * via {@link wireRuntime}; everywhere else reads {@link runtime} to
 * call the bot RPC, voice surface, or discord-messages surface
 * without threading `started` through every call site.
 *
 * `runtime()` throws if accessed before `wireRuntime` — only matters
 * if a flow file is imported at module-init time and calls out to the
 * bot synchronously. The slash + component handler paths run after
 * `start()`, so they're safe.
 *
 * Typed RPC: 0.4 of `@karyl-chan/plugin-sdk` exposes the camelCase
 * `voice.*` / `discord.*` namespaces on `StartedPlugin`. Reading them
 * here removes the per-call `botRpc("/api/plugin/voice.status", { ... })`
 * string-typed dispatch from the rest of the codebase. Auth (which
 * has no typed wrapper) still uses raw `botRpc`.
 */

import type { Discord, Logger as SdkLogger, Voice } from "@karyl-chan/plugin-sdk";

export interface Logger {
  info(msg: string, meta?: Record<string, unknown>): void;
  warn(msg: string, meta?: Record<string, unknown>): void;
  error(msg: string, meta?: Record<string, unknown>): void;
}

export type BotRpc = (path: string, body?: unknown) => Promise<unknown | null>;

interface Runtime {
  botRpc: BotRpc;
  discord: Discord;
  voice: Voice;
  log: Logger;
}

let active: Runtime | null = null;

export function wireRuntime(r: { botRpc: BotRpc; discord: Discord; voice: Voice; log: SdkLogger | Logger }): void {
  active = {
    botRpc: r.botRpc,
    discord: r.discord,
    voice: r.voice,
    log: {
      info: (msg, meta) => (r.log as Logger).info(msg, meta),
      warn: (msg, meta) => (r.log as Logger).warn(msg, meta),
      error: (msg, meta) => (r.log as Logger).error(msg, meta),
    },
  };
}

export function runtime(): Runtime {
  if (!active) {
    throw new Error("plugin-radio runtime not wired yet — call wireRuntime first");
  }
  return active;
}
