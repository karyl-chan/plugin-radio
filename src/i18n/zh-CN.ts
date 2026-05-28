/**
 * 简体中文 (Simplified Chinese) dictionary. Shape pinned to `LocaleKey`
 * from `./en.ts` — adding / removing a key over there triggers a TS
 * error here until this file is updated to match.
 */
import type { LocaleKey } from "./en.js";

export const zhCN: Record<LocaleKey, string> = {
  // ── feature meta ────────────────────────────────────────────────────────
  "feature.name": "Karyl 广播电台",
  "feature.description":
    "网络广播 + YouTube／HTTP 音频库：/radio 提供语音播放、队列、音乐库与管理 WebUI。默认关闭，需按 guild 启用。",

  // ── slash command + subcommand descriptions ─────────────────────────────
  "cmd.radio.description": "网络广播与音频库",
  "cmd.play.description":
    "播放电台、音乐库曲目或链接 (替换当前播放)",
  "cmd.play.source.description":
    "播放列表名称、电台代码、曲目名称／ID，或 http(s) 链接",
  "cmd.queue.description": "把曲目加入队列",
  "cmd.queue.source.description":
    "播放列表名称、电台代码、曲目名称／ID，或 http(s) 链接",
  "cmd.skip.description": "跳过当前曲目并播放队列中下一首",
  "cmd.back.description": "回到上一首播放过的曲目",
  "cmd.loop.description": "设置循环模式 (off／track／queue)",
  "cmd.loop.mode.description": "循环模式",
  "cmd.loop.mode.off": "off — 不循环",
  "cmd.loop.mode.track": "track — 重复当前曲目",
  "cmd.loop.mode.queue": "queue — 循环整个队列",
  "cmd.autoplay.description":
    "队列播完时自动接续 YouTube 推荐曲目",
  "cmd.autoplay.mode.description": "开启或关闭自动播放",
  "cmd.autoplay.mode.on": "on — 持续播放相关的 YouTube 歌曲",
  "cmd.autoplay.mode.off": "off — 队列播完即停止",
  "cmd.autoplayCount.description":
    "每次补充时自动播放要排入几首推荐 (1–25)",
  "cmd.autoplayCount.count.description":
    "每次补充的推荐数量 (1–25) — 省略则显示当前设置",
  "cmd.stop.description": "停止播放、清空队列并离开语音",
  "cmd.np.description": "显示当前播放中的曲目 (+ WebUI 链接)",
  "cmd.queuelist.description": "显示当前的播放队列",
  "cmd.stations.description": "列出可用的广播电台",
  "cmd.manage.description":
    "获取广播管理 WebUI 的私人链接 (需要权限)",

  // ── error / guard messages ──────────────────────────────────────────────
  "error.notInGuild": "⚠ 此指令仅可在服务器频道内使用。",
  "error.loop.invalidMode": "⚠ mode 必须为 off／track／queue 之一",
  "error.autoplay.invalidMode": "⚠ mode 必须是 `on` 或 `off`。",
  "error.autoplayCount.notNumber": "⚠ count 必须是整数。",
  "error.unknownSubcommand": "⚠ 未知的子指令 `{sub}`",
  "error.resolve.failed":
    "⚠ 无法加载该来源 — {reason}",
  "error.resolve.unknownSource":
    "⚠ 未知的电台／音乐库曲目／链接：`{source}`",
  "error.playlist.expandFailed":
    "⚠ 无法展开该播放列表 — {reason}",
  "error.playlist.empty": "⚠ 该播放列表为空或无法访问。",
  "error.storedPlaylist.empty":
    "⚠ 播放列表 **{name}** 没有可播放的曲目{skipped}。",
  "error.storedPlaylist.skippedCount":
    " ({n} 首无法解析)",
  "error.voice.joinFailed":
    "⚠ 无法加入语音 — 请确认你已加入语音频道，且 bot 具有相应权限。",

  // ── manage subcommand ───────────────────────────────────────────────────
  "manage.botRejected":
    "⚠ 无法生成登录链接 — bot 拒绝了请求 (插件 `{pluginKey}` 的 `auth.session` RPC 范围可能尚未核可，或 bot 暂时不可用)。",
  "manage.notAllowed":
    "⚠ 你无权管理 Karyl 广播。需要 `plugin:{pluginKey}:manage` 权限 (bot owner 与 admin 自动具备)。请联系 admin 将此权限授予你的角色。",
  "manage.linkHeader":
    "🔧 **Karyl 广播 — 管理 WebUI**\n管理已下载的曲目：搜索、编辑元数据、删除。请在 15 分钟内打开；之后标签页可自行续期最长 1 天。",
  "manage.openButton": "🔧 打开管理 WebUI",

  // ── component / now-playing controls ────────────────────────────────────
  "control.notInVoiceAnymore":
    "⚠ 我已经不在语音频道了，这个面板已失效。",
  "control.mustJoinVoice":
    "⚠ 你要先加入 <#{channelId}> 才能控制播放。",
  "control.stopped": "⏹ 已停止播放并离开语音频道。",
  "control.queueExhausted": "⏹ 队列播完了，已停止播放。",

  // ── /radio stop / /radio skip / /radio back / loop / autoplay replies ──
  "stop.done": "✓ 已停止、清空队列并离开语音。",
  "skip.queueEmpty": "队列已空 — 已停止播放。",
  "skip.nowPlaying": "⏭ 已跳过。正在播放 **{label}**。",
  "skip.startFailed":
    "⚠ 无法播放 **{label}** — 已重新排入队列，请再试一次。",
  "skip.exhausted": "⚠ 已跳过多首无法播放的曲目 — 请再试一次。",
  "back.noHistory": "↩ 播放记录中没有可回到的曲目。",
  "back.nowPlaying": "⏮ 已回到 **{label}**。",
  "back.startFailed": "⚠ 无法播放 **{label}**。",
  "loop.set": "{badge} 循环模式已设为 **{mode}**。",
  "autoplay.onSingular":
    "♾️ 自动播放 **开启** — 队列播完时我会从最后一首 YouTube 曲目衍生 **{count}** 首推荐并排入 (可用 `/radio autoplay-count` 调整)。",
  "autoplay.onPlural":
    "♾️ 自动播放 **开启** — 队列播完时我会从最后一首 YouTube 曲目衍生 **{count}** 首推荐并排入 (可用 `/radio autoplay-count` 调整)。",
  "autoplay.off": "自动播放 **关闭** — 队列播完即停止播放。",
  "autoplay.notice.on":
    "\n♾️ 自动播放开启 — 队列播完时我会继续用 YouTube 推荐接着播。",
  "autoplayCount.showSingular":
    "♾️ 自动播放每次补充 **{count}** 首推荐。传入 `count:` (1–{max}) 可调整。",
  "autoplayCount.showPlural":
    "♾️ 自动播放每次补充 **{count}** 首推荐。传入 `count:` (1–{max}) 可调整。",
  "autoplayCount.setSingular":
    "♾️ 自动播放往后每次补充 **{count}** 首推荐{clampNote}。下次补充时生效；已在队列里的曲目保持原样。",
  "autoplayCount.setPlural":
    "♾️ 自动播放往后每次补充 **{count}** 首推荐{clampNote}。下次补充时生效；已在队列里的曲目保持原样。",
  "autoplayCount.clampNote": " (已修正至 1–{max} 的范围内)",

  // ── /radio queue replies ───────────────────────────────────────────────
  "queue.youtubePlaylistAddedSingular":
    "➕ 已从播放列表排入 **{count}** 首曲目。",
  "queue.youtubePlaylistAddedPlural":
    "➕ 已从播放列表排入 **{count}** 首曲目。",
  "queue.storedPlaylistAddedSingular":
    "➕ 已从播放列表 **{name}** 排入 **{count}** 首曲目{skipNote}。",
  "queue.storedPlaylistAddedPlural":
    "➕ 已从播放列表 **{name}** 排入 **{count}** 首曲目{skipNote}。",
  "queue.skippedSuffixSingular": " (略过 {n} 首)",
  "queue.skippedSuffixPlural": " (略过 {n} 首)",
  "queue.addedAtPositionSingular":
    "➕ 已排入 **{label}** (位置 {position})。",
  "queue.addedAtPositionPlural":
    "➕ 已排入 **{label}** (位置 {position})。",

  // ── /radio play replies ────────────────────────────────────────────────
  "play.playlist.titlePlaying": "▶️ 正在播放播放列表",
  "play.playlist.titleQueued": "▶️ 播放列表已排入",
  "play.playlist.startedSingular":
    "**{label}** — 已排入 {count} 首曲目。",
  "play.playlist.startedPlural":
    "**{label}** — 已排入 {count} 首曲目。",
  "play.playlist.couldNotStartSingular":
    "已排入 {count} 首曲目，但无法播放第一首。",
  "play.playlist.couldNotStartPlural":
    "已排入 {count} 首曲目，但无法播放第一首。",
  "play.storedPlaylist.titlePlaying": "▶️ 正在播放播放列表：{name}",
  "play.storedPlaylist.titleQueued": "▶️ 播放列表已排入：{name}",
  "play.storedPlaylist.startedSingular":
    "**{label}** — 已排入 {count} 首曲目{skipNote}。",
  "play.storedPlaylist.startedPlural":
    "**{label}** — 已排入 {count} 首曲目{skipNote}。",
  "play.storedPlaylist.couldNotStartSingular":
    "已排入 {count} 首曲目{skipNote}，但无法播放第一首。",
  "play.storedPlaylist.couldNotStartPlural":
    "已排入 {count} 首曲目{skipNote}，但无法播放第一首。",
  "play.storedPlaylist.skipNote": " (略过 {n} 首)",
  "play.single.titleNowPlaying": "▶️ 正在播放",
  "play.single.titleFailed": "⚠ 播放失败",
  "play.single.started": "**{label}**",
  "play.single.failed":
    "已加入语音，但无法播放 **{label}**。",

  // ── /radio queuelist embed ──────────────────────────────────────────────
  "queuelist.title": "📜 队列",

  // ── format.ts: now-playing / queue / station list rendering ─────────────
  "stationList.header": "**可用电台：**",
  "stationList.entry": "• `{key}` — {name} ({description})",
  "stationList.footer":
    "_或直接粘贴任何 http(s) 音频链接 — mp3／opus／Icecast 流等。_",

  "now.nothing": "_(没有播放中)_",
  "now.queueEmpty": "_队列为空_",
  "now.queueSizeSingular": "_队列：{n} 首_",
  "now.queueSizePlural": "_队列：{n} 首_",
  "now.currentLine": "🎵 **{label}**",
  "now.currentLineQueuedBy": "🎵 **{label}** _(由 <@{userId}> 排入)_",
  "now.inChannel": "于 <#{channelId}>",
  "now.loopBadge": "{badge} 循环 `{mode}`",
  "now.autoplayOn": "♾️ 自动播放开启 (×{count})",
  "now.titlePlaying": "🎶 正在播放",
  "now.titlePaused": "⏸️ 已暂停",

  "queuelist.nowEmpty":
    "**当前：** _(无)_\n_(队列为空)_\n循环：`off`",
  "queuelist.nowLabel": "**当前：** {label}",
  "queuelist.nowLabelQueuedBy": "**当前：** {label} (<@{userId}>)",
  "queuelist.nowNothing": "**当前：** _(无)_",
  "queuelist.empty": "_(队列为空)_",
  "queuelist.entry": "{n}. {label}",
  "queuelist.entryQueuedBy": "{n}. {label} (<@{userId}>)",
  "queuelist.moreEntries": "… 还有 {n} 首",
  "queuelist.loopLine": "循环：`{mode}`",
  "queuelist.autoplayLine":
    "自动播放：`on` (每次 {count} 首)",

  // ── WebUI link button label (also used on now-playing message) ──────────
  "btn.openWebui": "🎛 打开 WebUI",
  "btn.webuiShort": "🎛 WebUI",
};
