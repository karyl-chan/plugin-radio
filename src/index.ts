import buildPlugin, {
  seenGuilds,
  setRadioBotRpc,
  setRadioPublicBaseUrl,
  setRadioSessionVerifyKey,
} from "./plugin.js";
import { startAdvanceLoop } from "./advance-loop.js";
import { wireRuntime } from "./runtime.js";

const started = await buildPlugin().start();
// Wire deferred deps into the WebUI routes — onReady ran before the
// lifecycle client existed, so these are only available now: the bot RPC
// client (voice control), the Ed25519 public key the bot returns at
// register (verifying plugin-session JWTs offline), and the publicBaseUrl
// the bot exposes for the WebUI (via WEB_BASE_URL on the bot side).
setRadioBotRpc(started.botRpc);
setRadioSessionVerifyKey(() => started.getSessionVerifyPublicKey());
setRadioPublicBaseUrl(() => started.getPublicBaseUrl());
// Shared module-level runtime so background loops (advance-loop,
// now-playing) and web handlers can hit the 0.4 typed voice / discord
// facades without threading them through every signature.
const log = {
  info: (msg: string, meta?: Record<string, unknown>) => started.server.log.info(meta ?? {}, msg),
  warn: (msg: string, meta?: Record<string, unknown>) => started.server.log.warn(meta ?? {}, msg),
  error: (msg: string, meta?: Record<string, unknown>) => started.server.log.error(meta ?? {}, msg),
};
wireRuntime({
  botRpc: started.botRpc,
  discord: started.discord,
  voice: started.voice,
  log,
});
startAdvanceLoop(started.botRpc, log, seenGuilds);
