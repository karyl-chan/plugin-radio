export function fmtDur(sec?: number): string {
  if (!sec || sec <= 0) return "";
  const m = Math.floor(sec / 60);
  const s = sec % 60;
  return `${m}:${String(s).padStart(2, "0")}`;
}

export function fmtSize(b?: number): string {
  if (!b) return "";
  return b < 1048576
    ? `${(b / 1024).toFixed(0)} KB`
    : `${(b / 1048576).toFixed(1)} MB`;
}

export function loopBadge(m: "off" | "track" | "queue"): string {
  return m === "track"
    ? "🔂 repeat track"
    : m === "queue"
    ? "🔁 loop queue"
    : "▶️ no loop";
}

export function nextLoop(
  m: "off" | "track" | "queue",
): "off" | "track" | "queue" {
  return m === "off" ? "track" : m === "track" ? "queue" : "off";
}

export function autoplayBadge(on: boolean, n?: number): string {
  return on ? `♾️ autoplay on (×${n || 7})` : "♾️ autoplay off";
}

export function isExternalUrl(u?: string): boolean {
  return typeof u === "string" && /^https?:\/\//i.test(u);
}

/** Join author · album · duration into a single subline; empty when none set. */
export function trackMeta(t: {
  author?: string;
  album?: string;
  duration?: number;
}): string {
  return [t.author, t.album, fmtDur(t.duration)].filter(Boolean).join(" · ");
}
