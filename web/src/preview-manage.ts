import { createApp, h } from "vue";
import "./styles/global.css";
import ManageView from "./views/ManageView.vue";
import AppToast from "./components/AppToast.vue";
import type { LibraryTrack, Playlist, PlaylistEntryInfo } from "./types";

// Stand-alone preview of the ManageView edit-track flow. All HTTP calls
// the SPA would normally make are intercepted by a fake `fetch` so this
// page runs without any bot/plugin auth — used both for manual visual
// review and for Playwright assertions on the modal state machine.

window.__PLUGIN_BASE__ = "";

const tracks: LibraryTrack[] = [
  {
    id: "trk-a",
    title: "Stardust Reverie",
    author: "Yuyuko",
    album: "Touhou: Perfect Cherry Blossom",
    duration: 188,
    sizeBytes: 4_800_000,
    coverUrl: "/preview-covers/a.svg",
    sourceUrl: "https://example.com/a",
    filename: "stardust.opus",
    addedBy: "preview",
    addedAt: 1_700_000_000_000,
  },
  {
    id: "trk-b",
    title: "Night of Nights",
    author: "COOL&CREATE",
    album: "Patchwork",
    duration: 232,
    sizeBytes: 6_200_000,
    coverUrl: "/preview-covers/b.svg",
    sourceUrl: "https://example.com/b",
    filename: "night.opus",
    addedBy: "preview",
    addedAt: 1_700_000_000_000,
  },
  {
    id: "trk-c",
    title: "Bad Apple!! feat. nomico",
    author: "Alstroemeria Records",
    album: "Lovelight",
    duration: 219,
    sizeBytes: 5_900_000,
    sourceUrl: "https://example.com/c",
    filename: "badapple.opus",
    addedBy: "preview",
    addedAt: 1_700_000_000_000,
  },
];

// Inline SVGs as data URIs for the seed covers so the preview is fully
// self-contained.
const inlineCover = (text: string, color: string): string =>
  `data:image/svg+xml;utf8,` +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 96 96'>
      <rect width='96' height='96' fill='${color}'/>
      <text x='50%' y='55%' text-anchor='middle' font-size='14' fill='white' font-family='sans-serif'>${text}</text>
    </svg>`,
  );

const coverFor: Record<string, string> = {
  "/preview-covers/a.svg": inlineCover("A", "#5865f2"),
  "/preview-covers/b.svg": inlineCover("B", "#047857"),
};
for (const t of tracks) {
  if (t.coverUrl && coverFor[t.coverUrl]) t.coverUrl = coverFor[t.coverUrl];
}

// Seed a few playlists so the Playlists tab has something to render.
const playlists: Playlist[] = [
  {
    id: "pl-1",
    name: "Late night",
    description: "Slow-burn picks for after midnight",
    entries: ["trk-a", "trk-b", "https://example.com/external"],
    createdBy: "preview",
    createdAt: 1_700_000_000_000,
    updatedAt: 1_700_000_000_000,
  },
];
let nextPlaylistId = 2;

const originalFetch = window.fetch.bind(window);
window.fetch = async (input: RequestInfo | URL, init?: RequestInit) => {
  const url =
    typeof input === "string"
      ? input
      : input instanceof URL
      ? input.toString()
      : input.url;
  const method = (init?.method || "GET").toUpperCase();

  const json = (body: unknown, status = 200): Response =>
    new Response(JSON.stringify(body), {
      status,
      headers: { "Content-Type": "application/json" },
    });

  if (url.includes("/api/tracks") && method === "GET") {
    return json({ tracks });
  }
  const patchMatch = url.match(/\/api\/tracks\/([^/]+)$/);
  if (patchMatch && method === "PATCH") {
    const id = decodeURIComponent(patchMatch[1]);
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const t = tracks.find((x) => x.id === id);
    if (t) Object.assign(t, body);
    return json({ track: t });
  }
  const uploadMatch = url.match(/\/api\/tracks\/([^/]+)\/cover$/);
  if (uploadMatch && method === "POST") {
    const id = decodeURIComponent(uploadMatch[1]);
    const t = tracks.find((x) => x.id === id);
    if (t) {
      // Pretend we received the file and now serve it under a fresh URL.
      t.coverUrl = inlineCover("NEW", "#b91c1c") + `#${Date.now()}`;
    }
    return json({ track: t });
  }
  if (url.endsWith("/api/tracks/download") && method === "POST") {
    return json({ alreadyExisted: false });
  }

  // ── Playlists ───────────────────────────────────────────────────────
  if (url.endsWith("/api/playlists") && method === "GET") {
    return json({ playlists });
  }
  if (url.endsWith("/api/playlists") && method === "POST") {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const name = String(body.name ?? "").trim();
    if (!name) return json({ error: "name is required" }, 400);
    if (playlists.some((p) => p.name.toLowerCase() === name.toLowerCase())) {
      return json({ error: `A playlist named "${name}" already exists` }, 400);
    }
    const now = Date.now();
    const playlist: Playlist = {
      id: `pl-${nextPlaylistId++}`,
      name,
      ...(body.description ? { description: String(body.description) } : {}),
      entries: Array.isArray(body.entries)
        ? body.entries.map(String).filter((s: string) => s.trim())
        : [],
      createdBy: "preview",
      createdAt: now,
      updatedAt: now,
    };
    playlists.push(playlist);
    return json({ playlist });
  }
  const plIdMatch = url.match(/\/api\/playlists\/([^/]+)$/);
  if (plIdMatch && method === "PATCH") {
    const id = decodeURIComponent(plIdMatch[1]);
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const p = playlists.find((x) => x.id === id);
    if (!p) return json({ error: "Not found" }, 404);
    if (body.name !== undefined) p.name = String(body.name).trim();
    if (body.description !== undefined) {
      const d = String(body.description ?? "").trim();
      if (d) p.description = d;
      else delete p.description;
    }
    if (body.entries !== undefined) {
      p.entries = Array.isArray(body.entries)
        ? body.entries.map(String).filter((s: string) => s.trim())
        : [];
    }
    p.updatedAt = Date.now();
    return json({ playlist: p });
  }
  if (plIdMatch && method === "DELETE") {
    const id = decodeURIComponent(plIdMatch[1]);
    const idx = playlists.findIndex((x) => x.id === id);
    if (idx === -1) return json({ error: "Not found" }, 404);
    playlists.splice(idx, 1);
    return json({ ok: true });
  }
  if (url.endsWith("/api/playlists/lookup-entry") && method === "POST") {
    const body = init?.body ? JSON.parse(init.body as string) : {};
    const source = String(body.source ?? "").trim();
    const lib = tracks.find((t) => t.id === source);
    if (lib) {
      const info: PlaylistEntryInfo = {
        kind: "library",
        trackId: lib.id,
        label: lib.title,
        ...(lib.author ? { author: lib.author } : {}),
        ...(lib.album ? { album: lib.album } : {}),
        ...(lib.coverUrl ? { coverUrl: lib.coverUrl } : {}),
      };
      return json(info);
    }
    if (/^https?:\/\//.test(source)) {
      return json({ kind: "url", label: source });
    }
    return json({ kind: "unknown", label: source });
  }

  // Fallback: pass through (shouldn't normally happen in preview).
  return originalFetch(input, init);
};

createApp({
  setup() {
    return () =>
      h("div", { class: "app-wrap" }, [
        h("header", { class: "app-header" }, [
          h("h1", "📻 Karyl Radio"),
          h("span", { class: "mode" }, "admin · library · preview"),
        ]),
        h(ManageView),
        h(AppToast),
      ]);
  },
}).mount("#app");
