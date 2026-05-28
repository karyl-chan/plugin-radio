/**
 * English (default) dictionary. The `en` const's shape is the source of
 * truth for the `LocaleKey` type — every other locale file is checked
 * against `Record<LocaleKey, string>`, so a missing key won't compile.
 *
 * Keys are flat dotted paths. Don't nest beyond three levels; prefer
 * adding a new top-level group to deepening an existing one.
 *
 * Interpolation uses the `{var}` form (single braces). See
 * `src/i18n/index.ts` for the substitution loop.
 */
export const en = {
  // ── feature meta ────────────────────────────────────────────────────────
  "feature.name": "Karyl Radio",
  "feature.description":
    "Internet radio + a YouTube/HTTP audio library: /radio gives voice playback, a queue, the library and a management WebUI. Off by default — enable it per-guild.",

  // ── slash command + subcommand descriptions ─────────────────────────────
  "cmd.radio.description": "Internet radio & audio library",
  "cmd.play.description":
    "Play a station, library track, or URL (replaces current)",
  "cmd.play.source.description":
    "Playlist name, station key, library track title/ID, or http(s) URL",
  "cmd.queue.description": "Add a track to the queue",
  "cmd.queue.source.description":
    "Playlist name, station key, library track title/ID, or http(s) URL",
  "cmd.skip.description": "Skip the current track and play next in queue",
  "cmd.back.description": "Go back to the previously played track",
  "cmd.loop.description": "Set loop mode (off / track / queue)",
  "cmd.loop.mode.description": "Loop mode",
  "cmd.loop.mode.off": "off — no looping",
  "cmd.loop.mode.track": "track — repeat current",
  "cmd.loop.mode.queue": "queue — cycle the queue",
  "cmd.autoplay.description":
    "Auto-queue YouTube recommendations when the queue runs out",
  "cmd.autoplay.mode.description": "Turn autoplay on or off",
  "cmd.autoplay.mode.on": "on — keep playing related YouTube songs",
  "cmd.autoplay.mode.off": "off — stop when the queue ends",
  "cmd.autoplayCount.description":
    "How many YouTube recommendations autoplay queues per refill (1–25)",
  "cmd.autoplayCount.count.description":
    "Recommendations per refill (1–25) — omit to show the current value",
  "cmd.stop.description": "Stop playback, clear queue and leave voice",
  "cmd.np.description": "Show what's currently playing (+ WebUI link)",
  "cmd.queuelist.description": "Show the current queue",
  "cmd.stations.description": "List available radio stations",
  "cmd.manage.description":
    "Get a private link to the radio admin WebUI (requires permission)",

  // ── error / guard messages ──────────────────────────────────────────────
  "error.notInGuild": "⚠ This command must be used inside a guild.",
  "error.loop.invalidMode": "⚠ mode must be one of: off / track / queue",
  "error.autoplay.invalidMode": "⚠ mode must be `on` or `off`.",
  "error.autoplayCount.notNumber": "⚠ count must be a whole number.",
  "error.unknownSubcommand": "⚠ Unknown subcommand `{sub}`",
  "error.resolve.failed":
    "⚠ Couldn't load that source — {reason}",
  "error.resolve.unknownSource":
    "⚠ Unknown station / library track / URL: `{source}`",
  "error.playlist.expandFailed":
    "⚠ Couldn't expand that playlist — {reason}",
  "error.playlist.empty": "⚠ That playlist is empty or unavailable.",
  "error.storedPlaylist.empty":
    "⚠ Playlist **{name}** has no playable entries{skipped}.",
  "error.storedPlaylist.skippedCount":
    " ({n} couldn't be resolved)",
  "error.voice.joinFailed":
    "⚠ Could not join voice — make sure you're in a voice channel and the bot has permission.",

  // ── manage subcommand ───────────────────────────────────────────────────
  "manage.botRejected":
    "⚠ Couldn't mint a login link — the bot rejected the request (plugin `{pluginKey}` may need its `auth.session` RPC scope approved, or the bot is unavailable).",
  "manage.notAllowed":
    "⚠ You're not allowed to manage Karyl Radio. Need the `plugin:{pluginKey}:manage` capability (bot owners and admins are exempt). Ask an admin to grant it to your role.",
  "manage.linkHeader":
    "🔧 **Karyl Radio — admin WebUI**\nManage downloaded tracks: search, edit metadata, delete. Open within 15 min; your tab session then refreshes itself for up to 1 day.",
  "manage.openButton": "🔧 Open admin WebUI",

  // ── component / now-playing controls ────────────────────────────────────
  "control.notInVoiceAnymore":
    "⚠ I've already left the voice channel — this panel is no longer active.",
  "control.mustJoinVoice":
    "⚠ You need to join <#{channelId}> before you can control playback.",
  "control.stopped": "⏹ Stopped playback and left the voice channel.",
  "control.queueExhausted": "⏹ Queue is empty — playback stopped.",

  // ── /radio stop / /radio skip / /radio back / loop / autoplay replies ──
  "stop.done": "✓ Stopped, queue cleared, and left voice.",
  "skip.queueEmpty": "Queue empty — stopped playback.",
  "skip.nowPlaying": "⏭ Skipped. Now playing **{label}**.",
  "skip.startFailed":
    "⚠ Couldn't start **{label}** — re-queued, try again.",
  "skip.exhausted": "⚠ Skipped several unplayable tracks — try again.",
  "back.noHistory": "↩ Nothing in the play history to go back to.",
  "back.nowPlaying": "⏮ Back to **{label}**.",
  "back.startFailed": "⚠ Failed to start **{label}**.",
  "loop.set": "{badge} Loop mode set to **{mode}**.",
  "autoplay.onSingular":
    "♾️ Autoplay **on** — when the queue runs out I'll queue **{count}** YouTube recommendation (change with `/radio autoplay-count`) seeded from the last YouTube track.",
  "autoplay.onPlural":
    "♾️ Autoplay **on** — when the queue runs out I'll queue **{count}** YouTube recommendations (change with `/radio autoplay-count`) seeded from the last YouTube track.",
  "autoplay.off": "Autoplay **off** — playback stops when the queue ends.",
  "autoplay.notice.on":
    "\n♾️ Autoplay on — I'll keep going with YouTube recommendations when the queue runs out.",
  "autoplayCount.showSingular":
    "♾️ Autoplay queues **{count}** recommendation per refill. Pass `count:` (1–{max}) to change it.",
  "autoplayCount.showPlural":
    "♾️ Autoplay queues **{count}** recommendations per refill. Pass `count:` (1–{max}) to change it.",
  "autoplayCount.setSingular":
    "♾️ Autoplay will now queue **{count}** recommendation per refill{clampNote}. Takes effect at the next refill; tracks already queued stay.",
  "autoplayCount.setPlural":
    "♾️ Autoplay will now queue **{count}** recommendations per refill{clampNote}. Takes effect at the next refill; tracks already queued stay.",
  "autoplayCount.clampNote": " (clamped to the 1–{max} range)",

  // ── /radio queue replies ───────────────────────────────────────────────
  "queue.youtubePlaylistAddedSingular":
    "➕ Queued **{count}** track from the playlist.",
  "queue.youtubePlaylistAddedPlural":
    "➕ Queued **{count}** tracks from the playlist.",
  "queue.storedPlaylistAddedSingular":
    "➕ Queued **{count}** track from playlist **{name}**{skipNote}.",
  "queue.storedPlaylistAddedPlural":
    "➕ Queued **{count}** tracks from playlist **{name}**{skipNote}.",
  "queue.skippedSuffixSingular": " ({n} entry skipped)",
  "queue.skippedSuffixPlural": " ({n} entries skipped)",
  "queue.addedAtPositionSingular":
    "➕ Queued **{label}** (position {position}).",
  "queue.addedAtPositionPlural":
    "➕ Queued **{label}** (position {position}).",

  // ── /radio play replies ────────────────────────────────────────────────
  "play.playlist.titlePlaying": "▶️ Playing playlist",
  "play.playlist.titleQueued": "▶️ Playlist queued",
  "play.playlist.startedSingular":
    "**{label}** — {count} track queued.",
  "play.playlist.startedPlural":
    "**{label}** — {count} tracks queued.",
  "play.playlist.couldNotStartSingular":
    "Queued {count} track, but couldn't start the first one.",
  "play.playlist.couldNotStartPlural":
    "Queued {count} tracks, but couldn't start the first one.",
  "play.storedPlaylist.titlePlaying": "▶️ Playing playlist: {name}",
  "play.storedPlaylist.titleQueued": "▶️ Playlist queued: {name}",
  "play.storedPlaylist.startedSingular":
    "**{label}** — {count} track queued{skipNote}.",
  "play.storedPlaylist.startedPlural":
    "**{label}** — {count} tracks queued{skipNote}.",
  "play.storedPlaylist.couldNotStartSingular":
    "Queued {count} track{skipNote}, but couldn't start the first one.",
  "play.storedPlaylist.couldNotStartPlural":
    "Queued {count} tracks{skipNote}, but couldn't start the first one.",
  "play.storedPlaylist.skipNote": " ({n} skipped)",
  "play.single.titleNowPlaying": "▶️ Now playing",
  "play.single.titleFailed": "⚠ Playback failed",
  "play.single.started": "**{label}**",
  "play.single.failed":
    "Joined voice but failed to start **{label}**.",

  // ── /radio queuelist embed ──────────────────────────────────────────────
  "queuelist.title": "📜 Queue",

  // ── format.ts: now-playing / queue / station list rendering ─────────────
  "stationList.header": "**Available stations:**",
  "stationList.entry": "• `{key}` — {name} ({description})",
  "stationList.footer":
    "_Or paste any direct http(s) audio URL — mp3 / opus / Icecast streams etc._",

  "now.nothing": "_(nothing playing)_",
  "now.queueEmpty": "_queue empty_",
  "now.queueSizeSingular": "_queue: {n} track_",
  "now.queueSizePlural": "_queue: {n} tracks_",
  "now.currentLine": "🎵 **{label}**",
  "now.currentLineQueuedBy": "🎵 **{label}** _(queued by <@{userId}>)_",
  "now.inChannel": "in <#{channelId}>",
  "now.loopBadge": "{badge} loop `{mode}`",
  "now.autoplayOn": "♾️ autoplay on (×{count})",
  "now.titlePlaying": "🎶 Now playing",
  "now.titlePaused": "⏸️ Paused",

  "queuelist.nowEmpty":
    "**Now:** _(nothing)_\n_(queue empty)_\nLoop: `off`",
  "queuelist.nowLabel": "**Now:** {label}",
  "queuelist.nowLabelQueuedBy": "**Now:** {label} (<@{userId}>)",
  "queuelist.nowNothing": "**Now:** _(nothing)_",
  "queuelist.empty": "_(queue empty)_",
  "queuelist.entry": "{n}. {label}",
  "queuelist.entryQueuedBy": "{n}. {label} (<@{userId}>)",
  "queuelist.moreEntries": "… and {n} more",
  "queuelist.loopLine": "Loop: `{mode}`",
  "queuelist.autoplayLine":
    "Autoplay: `on` (fetches {count} at a time)",

  // ── WebUI link button label (also used on now-playing message) ──────────
  "btn.openWebui": "🎛 Open WebUI",
  "btn.webuiShort": "🎛 WebUI",
} as const;

export type LocaleKey = keyof typeof en;
