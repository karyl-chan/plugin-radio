/**
 * 繁體中文 (Traditional Chinese) dictionary. Shape pinned to `LocaleKey`
 * from `./en.ts` — adding / removing a key over there triggers a TS
 * error here until this file is updated to match.
 */
import type { LocaleKey } from "./en.js";

export const zhTW: Record<LocaleKey, string> = {
  // ── feature meta ────────────────────────────────────────────────────────
  "feature.name": "Karyl 廣播電台",
  "feature.description":
    "網路廣播 + YouTube／HTTP 音訊資料庫：/radio 提供語音播放、佇列、音樂庫與管理 WebUI。預設關閉，需逐 guild 啟用。",

  // ── slash command + subcommand descriptions ─────────────────────────────
  "cmd.radio.description": "網路廣播與音訊資料庫",
  "cmd.play.description":
    "播放電台、音樂庫曲目或網址 (取代目前播放)",
  "cmd.play.source.description":
    "播放清單名稱、電台代碼、曲目名稱／ID，或 http(s) 網址",
  "cmd.queue.description": "把曲目加進佇列",
  "cmd.queue.source.description":
    "播放清單名稱、電台代碼、曲目名稱／ID，或 http(s) 網址",
  "cmd.skip.description": "跳過目前曲目並播放佇列中下一首",
  "cmd.back.description": "回到上一首播放過的曲目",
  "cmd.loop.description": "設定循環模式 (off／track／queue)",
  "cmd.loop.mode.description": "循環模式",
  "cmd.loop.mode.off": "off — 不循環",
  "cmd.loop.mode.track": "track — 重複目前曲目",
  "cmd.loop.mode.queue": "queue — 循環整個佇列",
  "cmd.autoplay.description":
    "佇列播完時自動接續 YouTube 推薦曲目",
  "cmd.autoplay.mode.description": "開啟或關閉自動播放",
  "cmd.autoplay.mode.on": "on — 持續播放相關的 YouTube 歌曲",
  "cmd.autoplay.mode.off": "off — 佇列播完即停止",
  "cmd.autoplayCount.description":
    "每次補充時自動播放要排入幾首推薦 (1–25)",
  "cmd.autoplayCount.count.description":
    "每次補充的推薦數量 (1–25) — 省略則顯示目前設定",
  "cmd.stop.description": "停止播放、清空佇列並離開語音",
  "cmd.np.description": "顯示目前播放中的曲目 (+ WebUI 連結)",
  "cmd.queuelist.description": "顯示目前的播放佇列",
  "cmd.stations.description": "列出可用的廣播電台",
  "cmd.manage.description":
    "取得廣播管理 WebUI 的私人連結 (需要權限)",

  // ── error / guard messages ──────────────────────────────────────────────
  "error.notInGuild": "⚠ 此指令僅可在伺服器頻道內使用。",
  "error.loop.invalidMode": "⚠ mode 必須為 off／track／queue 其中之一",
  "error.autoplay.invalidMode": "⚠ mode 必須是 `on` 或 `off`。",
  "error.autoplayCount.notNumber": "⚠ count 必須是整數。",
  "error.unknownSubcommand": "⚠ 未知的子指令 `{sub}`",
  "error.resolve.failed":
    "⚠ 無法載入該來源 — {reason}",
  "error.resolve.unknownSource":
    "⚠ 未知的電台／音樂庫曲目／網址：`{source}`",
  "error.playlist.expandFailed":
    "⚠ 無法展開該播放清單 — {reason}",
  "error.playlist.empty": "⚠ 該播放清單為空或無法存取。",
  "error.storedPlaylist.empty":
    "⚠ 播放清單 **{name}** 沒有可播放的曲目{skipped}。",
  "error.storedPlaylist.skippedCount":
    " ({n} 首無法解析)",
  "error.voice.joinFailed":
    "⚠ 無法加入語音 — 請確認你已加入語音頻道，且 bot 有對應的權限。",

  // ── manage subcommand ───────────────────────────────────────────────────
  "manage.botRejected":
    "⚠ 無法產生登入連結 — bot 拒絕了請求 (外掛 `{pluginKey}` 的 `auth.session` RPC 範圍可能尚未獲核可，或 bot 暫時無法使用)。",
  "manage.notAllowed":
    "⚠ 你無權管理 Karyl 廣播。需要 `plugin:{pluginKey}:manage` 權限 (bot owner 與 admin 自動具備)。請聯絡 admin 將此權限授予你的角色。",
  "manage.linkHeader":
    "🔧 **Karyl 廣播 — 管理 WebUI**\n管理已下載的曲目：搜尋、編輯詮釋資料、刪除。請在 15 分鐘內開啟；之後分頁可自行續期最長 1 天。",
  "manage.openButton": "🔧 開啟管理 WebUI",

  // ── component / now-playing controls ────────────────────────────────────
  "control.notInVoiceAnymore":
    "⚠ 我已經不在語音頻道了，這個面板已失效。",
  "control.mustJoinVoice":
    "⚠ 你要先加入 <#{channelId}> 才能控制播放。",
  "control.stopped": "⏹ 已停止播放並離開語音頻道。",
  "control.queueExhausted": "⏹ 佇列播完了，已停止播放。",

  // ── /radio stop / /radio skip / /radio back / loop / autoplay replies ──
  "stop.done": "✓ 已停止、清空佇列並離開語音。",
  "skip.queueEmpty": "佇列已空 — 已停止播放。",
  "skip.nowPlaying": "⏭ 已跳過。正在播放 **{label}**。",
  "skip.startFailed":
    "⚠ 無法播放 **{label}** — 已重新排入佇列，請再試一次。",
  "skip.exhausted": "⚠ 已跳過多首無法播放的曲目 — 請再試一次。",
  "back.noHistory": "↩ 播放紀錄中沒有可回到的曲目。",
  "back.nowPlaying": "⏮ 已回到 **{label}**。",
  "back.startFailed": "⚠ 無法播放 **{label}**。",
  "loop.set": "{badge} 循環模式已設為 **{mode}**。",
  "autoplay.onSingular":
    "♾️ 自動播放 **開啟** — 佇列播完時我會從最後一首 YouTube 曲目衍生 **{count}** 首推薦並排入 (可用 `/radio autoplay-count` 調整)。",
  "autoplay.onPlural":
    "♾️ 自動播放 **開啟** — 佇列播完時我會從最後一首 YouTube 曲目衍生 **{count}** 首推薦並排入 (可用 `/radio autoplay-count` 調整)。",
  "autoplay.off": "自動播放 **關閉** — 佇列播完即停止播放。",
  "autoplay.notice.on":
    "\n♾️ 自動播放開啟 — 佇列播完時我會繼續用 YouTube 推薦接著播。",
  "autoplayCount.showSingular":
    "♾️ 自動播放每次補充 **{count}** 首推薦。傳入 `count:` (1–{max}) 可調整。",
  "autoplayCount.showPlural":
    "♾️ 自動播放每次補充 **{count}** 首推薦。傳入 `count:` (1–{max}) 可調整。",
  "autoplayCount.setSingular":
    "♾️ 自動播放往後每次補充 **{count}** 首推薦{clampNote}。下次補充時生效；已在佇列裡的曲目維持原樣。",
  "autoplayCount.setPlural":
    "♾️ 自動播放往後每次補充 **{count}** 首推薦{clampNote}。下次補充時生效；已在佇列裡的曲目維持原樣。",
  "autoplayCount.clampNote": " (已修正至 1–{max} 的範圍內)",

  // ── /radio queue replies ───────────────────────────────────────────────
  "queue.youtubePlaylistAddedSingular":
    "➕ 已從播放清單排入 **{count}** 首曲目。",
  "queue.youtubePlaylistAddedPlural":
    "➕ 已從播放清單排入 **{count}** 首曲目。",
  "queue.storedPlaylistAddedSingular":
    "➕ 已從播放清單 **{name}** 排入 **{count}** 首曲目{skipNote}。",
  "queue.storedPlaylistAddedPlural":
    "➕ 已從播放清單 **{name}** 排入 **{count}** 首曲目{skipNote}。",
  "queue.skippedSuffixSingular": " (略過 {n} 首)",
  "queue.skippedSuffixPlural": " (略過 {n} 首)",
  "queue.addedAtPositionSingular":
    "➕ 已排入 **{label}** (位置 {position})。",
  "queue.addedAtPositionPlural":
    "➕ 已排入 **{label}** (位置 {position})。",

  // ── /radio play replies ────────────────────────────────────────────────
  "play.playlist.titlePlaying": "▶️ 正在播放播放清單",
  "play.playlist.titleQueued": "▶️ 播放清單已排入",
  "play.playlist.startedSingular":
    "**{label}** — 已排入 {count} 首曲目。",
  "play.playlist.startedPlural":
    "**{label}** — 已排入 {count} 首曲目。",
  "play.playlist.couldNotStartSingular":
    "已排入 {count} 首曲目，但無法播放第一首。",
  "play.playlist.couldNotStartPlural":
    "已排入 {count} 首曲目，但無法播放第一首。",
  "play.storedPlaylist.titlePlaying": "▶️ 正在播放播放清單：{name}",
  "play.storedPlaylist.titleQueued": "▶️ 播放清單已排入：{name}",
  "play.storedPlaylist.startedSingular":
    "**{label}** — 已排入 {count} 首曲目{skipNote}。",
  "play.storedPlaylist.startedPlural":
    "**{label}** — 已排入 {count} 首曲目{skipNote}。",
  "play.storedPlaylist.couldNotStartSingular":
    "已排入 {count} 首曲目{skipNote}，但無法播放第一首。",
  "play.storedPlaylist.couldNotStartPlural":
    "已排入 {count} 首曲目{skipNote}，但無法播放第一首。",
  "play.storedPlaylist.skipNote": " (略過 {n} 首)",
  "play.single.titleNowPlaying": "▶️ 正在播放",
  "play.single.titleFailed": "⚠ 播放失敗",
  "play.single.started": "**{label}**",
  "play.single.failed":
    "已加入語音，但無法播放 **{label}**。",

  // ── /radio queuelist embed ──────────────────────────────────────────────
  "queuelist.title": "📜 佇列",

  // ── format.ts: now-playing / queue / station list rendering ─────────────
  "stationList.header": "**可用電台：**",
  "stationList.entry": "• `{key}` — {name} ({description})",
  "stationList.footer":
    "_或直接貼上任何 http(s) 音訊網址 — mp3／opus／Icecast 串流等。_",

  "now.nothing": "_(沒有播放中)_",
  "now.queueEmpty": "_佇列為空_",
  "now.queueSizeSingular": "_佇列：{n} 首_",
  "now.queueSizePlural": "_佇列：{n} 首_",
  "now.currentLine": "🎵 **{label}**",
  "now.currentLineQueuedBy": "🎵 **{label}** _(由 <@{userId}> 排入)_",
  "now.inChannel": "於 <#{channelId}>",
  "now.loopBadge": "{badge} 循環 `{mode}`",
  "now.autoplayOn": "♾️ 自動播放開啟 (×{count})",
  "now.titlePlaying": "🎶 正在播放",
  "now.titlePaused": "⏸️ 已暫停",

  "queuelist.nowEmpty":
    "**目前：** _(無)_\n_(佇列為空)_\n循環：`off`",
  "queuelist.nowLabel": "**目前：** {label}",
  "queuelist.nowLabelQueuedBy": "**目前：** {label} (<@{userId}>)",
  "queuelist.nowNothing": "**目前：** _(無)_",
  "queuelist.empty": "_(佇列為空)_",
  "queuelist.entry": "{n}. {label}",
  "queuelist.entryQueuedBy": "{n}. {label} (<@{userId}>)",
  "queuelist.moreEntries": "… 還有 {n} 首",
  "queuelist.loopLine": "循環：`{mode}`",
  "queuelist.autoplayLine":
    "自動播放：`on` (每次 {count} 首)",

  // ── WebUI link button label (also used on now-playing message) ──────────
  "btn.openWebui": "🎛 開啟 WebUI",
  "btn.webuiShort": "🎛 WebUI",
};
