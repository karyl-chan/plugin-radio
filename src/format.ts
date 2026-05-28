/**
 * Pure presentation helpers used by the radio plugin: command-reply text,
 * the now-playing embed and the control-button rows. No bot RPC, no state
 * mutation — derived purely from the queue state (and the bits of voice
 * status / WebUI link the caller passes in).
 *
 * Every user-visible string flows through `t(locale, …)` — callers
 * either resolve the locale from their interaction (`/radio np` →
 * `resolveLocale(ctx)`) or fall back to `"en"` for surfaces that have
 * no interaction context (the persistent public now-playing message,
 * which several users in the channel may read).
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
import { t, type Locale } from "./i18n/index.js";

/** Embed colour shared across the radio plugin's Discord replies. */
export const EMBED_COLOR = 0x5865f2;

export function formatStationList(locale: Locale): string {
  const lines = STATIONS.map((s) =>
    t(locale, "stationList.entry", {
      key: s.key,
      name: s.name,
      description: s.description,
    }),
  );
  return [t(locale, "stationList.header"), ...lines, "", t(locale, "stationList.footer")].join("\n");
}

/**
 * Resolve a `source` argument (station key or full URL) into a Track.
 * Returns null if the source is neither a known station nor a parseable
 * http(s) URL — caller should reply with an error.
 *
 * No locale needed: the only string this emits is a Track `label`
 * derived from the source (station name or URL host/path), neither of
 * which is translated.
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

export function formatQueueList(guildId: string, locale: Locale): string {
  const s = getState(guildId);
  if (!s) return t(locale, "queuelist.nowEmpty");
  const cur = getCurrent(s);
  const upcoming = getUpcoming(s);
  const lines: string[] = [];
  lines.push(
    cur
      ? cur.queuedBy
        ? t(locale, "queuelist.nowLabelQueuedBy", { label: cur.label, userId: cur.queuedBy })
        : t(locale, "queuelist.nowLabel", { label: cur.label })
      : t(locale, "queuelist.nowNothing"),
  );
  if (upcoming.length === 0) {
    lines.push(t(locale, "queuelist.empty"));
  } else {
    upcoming.slice(0, 15).forEach((track, i) => {
      lines.push(
        track.queuedBy
          ? t(locale, "queuelist.entryQueuedBy", { n: i + 1, label: track.label, userId: track.queuedBy })
          : t(locale, "queuelist.entry", { n: i + 1, label: track.label }),
      );
    });
    if (upcoming.length > 15) {
      lines.push(t(locale, "queuelist.moreEntries", { n: upcoming.length - 15 }));
    }
  }
  lines.push(t(locale, "queuelist.loopLine", { mode: s.loop }));
  if (s.autoplay) {
    lines.push(t(locale, "queuelist.autoplayLine", { count: s.autoplayFetchCount }));
  }
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

/**
 * Build the "now playing" embed from the guild's queue state + voice
 * status. The public now-playing message has no per-user locale — it
 * lives in the voice-text channel where multiple users see it — so
 * callers there pass `"en"`. The ephemeral `/radio np` reply passes the
 * invoker's resolved locale.
 */
export function renderNowPlayingEmbed(
  guildId: string,
  status: NowPlayingStatus,
  locale: Locale,
): Record<string, unknown> {
  const s = getState(guildId);
  const cur = s ? getCurrent(s) : null;
  const loop = s?.loop ?? "off";
  const queueSize = s ? getUpcoming(s).length : 0;
  const paused = status.paused === true;

  const lines: string[] = [];
  lines.push(
    cur
      ? cur.queuedBy
        ? t(locale, "now.currentLineQueuedBy", { label: cur.label, userId: cur.queuedBy })
        : t(locale, "now.currentLine", { label: cur.label })
      : t(locale, "now.nothing"),
  );
  if (status.channelId) lines.push(t(locale, "now.inChannel", { channelId: status.channelId }));
  lines.push(
    queueSize === 0
      ? t(locale, "now.queueEmpty")
      : t(
          locale,
          queueSize === 1 ? "now.queueSizeSingular" : "now.queueSizePlural",
          { n: queueSize },
        ),
  );
  lines.push(t(locale, "now.loopBadge", { badge: loopBadge(loop), mode: loop }));
  if (s?.autoplay) {
    lines.push(t(locale, "now.autoplayOn", { count: s.autoplayFetchCount }));
  }

  return {
    title: paused ? t(locale, "now.titlePaused") : t(locale, "now.titlePlaying"),
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
 *
 * Only the link-button label is locale-sensitive; the icon-only control
 * buttons (emoji-only) need no translation.
 */
export function nowPlayingComponents(
  pluginKey: string,
  guildId: string,
  status: { paused?: boolean },
  webuiUrl: string | null,
  locale: Locale,
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
    row2.push({ type: 2, style: 5, label: t(locale, "btn.webuiShort"), url: webuiUrl });
  }
  rows.push({ type: 1, components: row2 } as unknown as MessageActionRow);
  return rows;
}
