# @karyl-chan/plugin-radio

Voice/audio plugin for karyl-chan:
internet radio + an HTTP/streaming audio library, with a queue, an
auto-advance loop, and a small management WebUI. The only stateful
plugin in the family — it holds per-guild voice-channel state, the queue,
and the advance loop, so it keeps its own package and docker service.

## `/radio`

| Sub-command | What it does |
|---|---|
| `play <source>` | Join your voice channel and play a station / library track / direct http(s) media URL / page link from a common streaming site / streaming playlist (replaces current) |
| `queue <source>` | Append to the queue (also expands a streaming playlist) |
| `skip` / `back` | Skip to next / go back to the previous track |
| `loop <off\|track\|queue>` | Set the loop mode |
| `autoplay <on\|off>` | Auto-queue recommended tracks when the queue runs out (see below) |
| `autoplay-count <count>` | How many recommendations autoplay queues per refill (1–25; live, per session) |
| `stop` | Stop, clear the queue, leave voice |
| `np` / `queuelist` | Now-playing card (the embed + control buttons below; ephemeral, not auto-updated) / show the queue |
| `stations` | List the built-in radio stations |
| `manage` | Get a private link to the admin WebUI (requires the `plugin:karyl-radio:manage` capability — bot owners/admins exempt). The manage WebUI is the only way to put audio into the library: managers upload audio files they own. |

`source` for `play`/`queue` auto-resolves a station key, a library track
title/ID, a direct http(s) media URL, or a track page on a common
streaming site (anything yt-dlp can resolve). For the non-direct cases
yt-dlp resolves a streaming URL on the fly — that URL is signed and
short-lived, so it's fine for immediate playback but a track that may
sit queued for a long time is better placed into the library ahead of
time (manager uploads the audio file through the manage WebUI). (HLS
playlists still aren't supported by the ffmpeg pipeline, so the resolver
prefers a progressive stream where the site offers one.) A streaming
URL that points at a mix/radio or playlist given to `/radio play` also
switches **autoplay on** for the guild; any other `play` source switches
it off.

## Library

The library is the plugin's private store of audio files. Only the
manager (anyone with `plugin:karyl-radio:manage`, plus bot owners /
admins) can put audio into it, and only through the manage WebUI's
file-upload form — there is no command or endpoint that downloads
external audio into the library. Uploads are deduped by SHA-256 of
the file bytes, so the same file uploaded twice resolves to the same
library row.

The intent is that managers upload audio they actually own, or that
they have the right to play in their server — the plugin does not
clear any rights on their behalf. Use the built-in [stations](#stations)
or `/radio play <streaming URL>` (live re-stream, no on-disk copy) for
content you don't own.

## Stations

The built-in stations list (`/radio stations`) ships SomaFM streams
only — SomaFM's listener terms explicitly permit personal,
non-commercial re-streaming, which is the bar this plugin's
"out-of-the-box safe" set is curated against. Adding new entries to
`src/stations.ts` is allowed, but the same bar applies: the
broadcaster has to publicly authorize personal-use re-streaming. Many
public / commercial broadcasters serve their stream for direct
listening only — a bot rebroadcasting it doesn't fall under that, so
when in doubt, leave it out.

## Autoplay

With autoplay on, the advance loop keeps the queue topped up: whenever the
queue is empty (and loop is `off`) it pulls a recommendation mix seeded
from the most recent compatible track this session and appends up to **N**
recommendations not already played/queued — N defaults to **7** and is
per-session, live-tunable with `/radio autoplay-count <n>` (range 1–25).
Refilling only when the queue is empty (including while the current track
is still playing, so the next song is lined up before this one ends) keeps
the resolver fetch to roughly one per N songs; a smaller N tracks the
current song more closely, a larger N means fewer fetches and a longer
look-ahead. If the most recent track isn't from a recommendation-capable
source it falls back to the last compatible track in the session play-log,
and it gives up gracefully (the session ends as usual) if the mix has
nothing fresh. Off by default; toggle it with `/radio autoplay`, the ♾️
button on the now-playing message, or the session WebUI. Same yt-dlp path
as `/radio play <URL>` — see [Copyright & terms of use](#copyright--terms-of-use).

## Now-playing message

While a guild has an active playback session the plugin keeps **one
public embed in the bot's voice-channel text chat** — current track,
queue size, loop/pause/autoplay state — with control buttons (⏮ prev · ⏯
play/pause · ⏭ next · ⏹ stop · 🔁 loop-cycle · ♾️ autoplay-toggle) plus a
"🎛 WebUI" link.
It's edited in place on every state change (a `/radio` command, a WebUI
action, or the auto-advance loop moving to the next track) and deleted
when the session ends (the bot leaves voice, `/radio stop`, the queue
runs dry, or the voice channel has been empty of human listeners for a
minute — the bot then stops and leaves on its own). Edits are
change-gated, so a steady radio stream causes none.

Only members **currently in the bot's voice channel** can use the control
buttons (others get an ephemeral nudge); the WebUI link button stays valid
for the whole session. The buttons reach the plugin via the bot's
component-dispatch path (`kc:karyl-radio:<action>` custom ids); see the
bot's `docs/development/plugin-guide.md`. `/radio np` returns the same
embed + buttons template, ephemeral — but it isn't auto-updated; only its
own buttons edit it.

## WebUI

The WebUI is normally reached via the **bot proxy**:
`<WEB_BASE_URL>/plugin/karyl-radio/` (e.g. `http://localhost:902/plugin/karyl-radio/`).
No per-plugin TLS certificate or public port is required — the bot handles
TLS termination and reverse-proxies the traffic. The bot includes the
`publicBaseUrl` in its register and heartbeat responses; the SDK surfaces it
via `StartedPlugin.getPublicBaseUrl()`, and the radio plugin uses it to build
the `/radio manage` link, play-response buttons, and cover image URLs.

`RADIO_PUBLIC_URL` is an optional fallback/override — only needed for
direct-access debugging (re-add the `ports:` mapping in docker-compose and
set `RADIO_PUBLIC_URL`). In production with `WEB_BASE_URL` configured on the
bot, leave it unset.

`/radio np`, `/radio manage`, and the play replies hand back a link carrying a
short-lived `plugin-session` JWT. The WebUI server (in `src/web-routes.ts`)
verifies that token **offline** with the bot's Ed25519 public key (the SDK's
`verifyPluginSession`) — there's no shared secret; the bot signs with a private
key that never leaves it. `manage` tokens carry the user's capabilities and gate
the library-management routes; session tokens are guild-scoped and gate playback
control. An admin rotating the bot's JWT signing key invalidates outstanding
links; the plugin picks up the new public key on its next heartbeat.

## Copyright & terms of use

This is a self-hostable plugin, not a hosted service — what gets played
on a given Discord server is the responsibility of the operator running
it and the managers they grant `plugin:karyl-radio:manage` to. The
plugin does not clear any rights on anyone's behalf.

The defaults and architecture are positioned for content the operator
has the right to play in their voice channels:

- **Stations** ship SomaFM only — SomaFM publicly authorizes
  personal-use re-streaming. Additions to `src/stations.ts` must clear
  the same bar (see [Stations](#stations)).
- **Library** holds manager-uploaded audio only; no command or endpoint
  pulls external audio in. Managers are responsible for the rights of
  what they upload (see [Library](#library)).
- **`/radio play <streaming / direct URL>`** and
  **[Autoplay](#autoplay)** re-stream third-party audio into the voice
  channel via yt-dlp. Nothing is written to disk, but re-streaming audio
  to listeners is a separate copyright concern from downloading.
  Operators are responsible for complying with their jurisdiction's
  copyright law and with the source platform's Terms of Service (many
  platforms restrict third-party extraction).

## Runtime dependencies

- the bot's voice RPC (`voice.join` / `voice.play` / `voice.pause` / `voice.stop` / `voice.status`) — the plugin does no audio I/O of its own beyond resolving/downloading
- `messages.send` / `messages.edit` / `messages.delete` (the now-playing message) and the component-dispatch path (the control buttons) — needs a bot recent enough to provide them
- `ffmpeg` and `yt-dlp` in the container (see `Dockerfile.radio`)
- volumes for the library and cover images (`MUSIC_DIR` / `COVER_DIR`; mapped in the monorepo `docker-compose.yml`)

## Setup

1. Bring up the bot first (creates the `karyl-chan-net` network). Have an
   admin run `POST /api/plugins/setup-secret { pluginKey: "karyl-radio" }`
   and put the returned cleartext in `KARYL_PLUGIN_SETUP_SECRET_RADIO` in
   the monorepo's root `.env`.
2. `COMPOSE_PROFILES` (root `.env`) must include `radio`.
3. `pnpm docker:up` (from the monorepo root) — or `docker compose up --build -d karyl-plugin-radio`.

On startup the plugin registers with the bot, gets a token + the dispatch
HMAC key + the JWT verify public key, and starts a ~30 s heartbeat; the
bot then registers the `/radio` command with Discord.

Edit `src/stations.ts` to change the built-in station list — each URL must
serve `Content-Type: audio/*` directly (HLS / playlist URLs aren't
supported by the ffmpeg pipeline).
