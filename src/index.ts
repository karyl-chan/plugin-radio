import buildPlugin, {
  seenGuilds,
  setRadioBotRpc,
  setRadioPublicBaseUrl,
  setRadioSessionVerifyKey,
} from "./plugin.js";
import { startAdvanceLoop } from "./advance-loop.js";

const started = await buildPlugin().start();
// Wire deferred deps into the WebUI routes — onReady ran before the
// lifecycle client existed, so these are only available now: the bot RPC
// client (voice control), the Ed25519 public key the bot returns at
// register (verifying plugin-session JWTs offline), and the publicBaseUrl
// the bot exposes for the WebUI (via WEB_BASE_URL on the bot side).
setRadioBotRpc(started.botRpc);
setRadioSessionVerifyKey(() => started.getSessionVerifyPublicKey());
setRadioPublicBaseUrl(() => started.getPublicBaseUrl());
startAdvanceLoop(
  started.botRpc,
  {
    info: (msg, meta) => started.server.log.info(meta ?? {}, msg),
    warn: (msg, meta) => started.server.log.warn(meta ?? {}, msg),
    error: (msg, meta) => started.server.log.error(meta ?? {}, msg),
  },
  seenGuilds,
);
