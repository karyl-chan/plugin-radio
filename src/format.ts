/**
 * Pure presentation helpers used by the radio plugin: command-reply text,
 * the now-playing embed and the control-button rows. No bot RPC, no state
 * mutation — derived purely from the queue state (and the bits of voice
 * status / WebUI link the caller passes in).
 */
import { componentCustomId, type MessageActionRow } from "@karyl-chan/plugin-sdk";
import {
  type LoopMode,
  type Track,
  getCurrent,
  getState,
  getUpcoming,
  hasPrevious,
} from "./queue.js";
import { STATIONS, findStation } from "./stations.js";

/** Embed colour shared across the radio plugin's Discord replies. */
export const EMBED_COLOR = 0x5865f2;

export function formatStationList(): string {
  const lines = STATIONS.map(
    (s) => `• \`${s.key}\` — ${s.name} (${s.description})`,
  );
  return [
    "**Available stations:**",
    ...lines,
    "",
    "_Or paste any direct http(s) audio URL — mp3 / opus / Icecast streams etc._",
  ].join("\n");
}

/**
 * Resolve a `source` argument (station key or full URL) into a Track.
 * Returns null if the source is neither a known station nor a parseable
 * http(s) URL — caller should reply with an error.
 */
export function resolveTrack(
  source: string,
  queuedBy: string | null,
): Track | null {
  const s = source.trim();
  if (!s) return null;
  const station = findStation(s);
  if (station) {
    return { url: station.url, label: station.name, queuedBy };
  }
  let parsed: URL;
  try {
    parsed = new URL(s);
  } catch {
    return null;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") return null;
  const tail = parsed.pathname.split("/").filter(Boolean).pop() ?? "";
  const label = tail ? `${parsed.hostname}/${tail}` : parsed.hostname;
  return { url: s, label, queuedBy };
}

export function loopBadge(loop: LoopMode): string {
  if (loop === "track") return "🔂";
  if (loop === "queue") return "🔁";
  return "▶️";
}

export function formatNowPlaying(
  guildId: string,
  channelId: string | null,
): string {
  const s = getState(guildId);
  if (!s) return "_(nothing playing)_\n_queue empty_";
  const cur = getCurrent(s);
  const head = cur
    ? `🎵 **${cur.label}**${cur.queuedBy ? ` _(queued by <@${cur.queuedBy}>)_` : ""}`
    : "_(nothing playing)_";
  const where = channelId ? ` in <#${channelId}>` : "";
  const queueSize = getUpcoming(s).length;
  const queueLine =
    queueSize === 0
      ? "_queue empty_"
      : `_queue: ${queueSize} track${queueSize > 1 ? "s" : ""}_`;
  return `${loopBadge(s.loop)} ${head}${where}\n${queueLine}`;
}

export function formatQueueList(guildId: string): string {
  const s = getState(guildId);
  if (!s) return "**Now:** _(nothing)_\n_(queue empty)_\nLoop: `off`";
  const cur = getCurrent(s);
  const upcoming = getUpcoming(s);
  const lines: string[] = [];
  lines.push(
    cur
      ? `**Now:** ${cur.label}${cur.queuedBy ? ` (<@${cur.queuedBy}>)` : ""}`
      : "**Now:** _(nothing)_",
  );
  if (upcoming.length === 0) {
    lines.push("_(queue empty)_");
  } else {
    upcoming.slice(0, 15).forEach((t, i) => {
      lines.push(
        `${i + 1}. ${t.label}${t.queuedBy ? ` (<@${t.queuedBy}>)` : ""}`,
      );
    });
    if (upcoming.length > 15) {
      lines.push(`… and ${upcoming.length - 15} more`);
    }
  }
  lines.push(`Loop: \`${s.loop}\``);
  if (s.autoplay)
    lines.push(`Autoplay: \`on\` (fetches ${s.autoplayFetchCount} at a time)`);
  return lines.join("\n");
}

// ── Now-playing embed + control buttons ─────────────────────────────────────
// Shared by the public "now playing" message (now-playing.ts) and the
// /radio np reply. `<@id>` mentions are deliberate — these render inside a
// Discord message, where a mention is the right form (unlike the WebUI).

/** Voice-status bits the now-playing embed needs. */
export interface NowPlayingStatus {
  /** The voice channel the bot is in (for the "in <#…>" line), or null. */
  channelId: string | null;
  /** True when the current track is paused. */
  paused?: boolean;
}

/** Build the "now playing" embed from the guild's queue state + voice status. */
export function renderNowPlayingEmbed(
  guildId: string,
  status: NowPlayingStatus,
): Record<string, unknown> {
  const s = getState(guildId);
  const cur = s ? getCurrent(s) : null;
  const loop = s?.loop ?? "off";
  const queueSize = s ? getUpcoming(s).length : 0;
  const paused = status.paused === true;

  const lines: string[] = [];
  lines.push(
    cur
      ? `🎵 **${cur.label}**${cur.queuedBy ? ` _(queued by <@${cur.queuedBy}>)_` : ""}`
      : "_(nothing playing)_",
  );
  if (status.channelId) lines.push(`in <#${status.channelId}>`);
  lines.push(
    queueSize === 0
      ? "_queue empty_"
      : `_queue: ${queueSize} track${queueSize > 1 ? "s" : ""}_`,
  );
  lines.push(`${loopBadge(loop)} loop \`${loop}\``);
  if (s?.autoplay) lines.push(`♾️ autoplay on (×${s.autoplayFetchCount})`);

  return {
    title: paused ? "⏸️ Paused" : "🎶 Now playing",
    color: EMBED_COLOR,
    description: lines.join("\n"),
    ...(cur?.coverUrl ? { thumbnail: { url: cur.coverUrl } } : {}),
  };
}

/**
 * Build the two action rows for the now-playing message:
 *   row 1 — ⏮ prev · ⏯ play/pause · ⏭ next · ⏹ stop · 🔁 loop-cycle
 *   row 2 — ♾️ autoplay-toggle · 🎛 WebUI (link button; only when `webuiUrl` is non-null)
 * The control buttons carry `kc:<pluginKey>:<action>` custom ids (built
 * via the SDK's componentCustomId) and stay live for as long as the
 * message exists. `prev` is disabled with no play history; the loop and
 * autoplay buttons go blurple (style 1) while active; everything else is
 * the plain secondary style.
 */
export function nowPlayingComponents(
  pluginKey: string,
  guildId: string,
  status: { paused?: boolean },
  webuiUrl: string | null,
): MessageActionRow[] {
  const s = getState(guildId);
  const loop: LoopMode = s?.loop ?? "off";
  const autoplay = s?.autoplay ?? false;
  const hasPrev = hasPrevious(guildId);
  const btn = (
    id: string,
    emoji: string,
    opts?: { style?: number; disabled?: boolean },
  ): Record<string, unknown> => ({
    type: 2,
    style: opts?.style ?? 2,
    custom_id: componentCustomId(pluginKey, id),
    emoji: { name: emoji },
    ...(opts?.disabled ? { disabled: true } : {}),
  });
  const rows: MessageActionRow[] = [
    {
      type: 1,
      components: [
        btn("prev", "⏮️", { disabled: !hasPrev }),
        btn("pause", status.paused ? "▶️" : "⏸️"),
        btn("next", "⏭️"),
        btn("stop", "⏹️"),
        btn("loop", "🔁", { style: loop === "off" ? 2 : 1 }),
      ],
    } as unknown as MessageActionRow,
  ];
  const row2: unknown[] = [btn("autoplay", "♾️", { style: autoplay ? 1 : 2 })];
  if (webuiUrl) {
    row2.push({ type: 2, style: 5, label: "🎛 WebUI", url: webuiUrl });
  }
  rows.push({ type: 1, components: row2 } as unknown as MessageActionRow);
  return rows;
}
