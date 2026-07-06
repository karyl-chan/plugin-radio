<script setup lang="ts">
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { AppButton } from "@karyl-chan/ui";
import NowPlayingCard from "../components/NowPlayingCard.vue";
import PlaylistList from "../components/PlaylistList.vue";
import Thumb from "../components/Thumb.vue";
import { api } from "../api";
import { useToast } from "../composables/use-toast";
import { useFavorites } from "../composables/use-favorites";
import { useBusy } from "../composables/use-busy";
import { trackKey } from "../composables/use-format";
import type {
  LoopMode,
  QueueSuggestion,
  SessionSnapshot,
  Track,
} from "../types";

const props = defineProps<{ guildId: string; loggedIn?: boolean }>();
const { ok, error } = useToast();

// Favorites (login-gated): drives the ☆ toggle on queue rows (membership +
// star/unstar). Identity resolves async, so load when loggedIn flips true.
const {
  sourceSet: favoriteSources,
  load: loadFavorites,
  toggle: toggleFavoriteSource,
} = useFavorites();
watch(
  () => props.loggedIn,
  (v) => {
    if (v) void loadFavorites();
  },
  { immediate: true },
);

const snap = ref<SessionSnapshot | null>(null);
const pendingAdds = ref<string[]>([]);
const addText = ref("");
const showSuggestions = ref(false);
const savingPlaylist = ref(false);
// The + Add button spins whenever any enqueue is in flight — exactly when the
// pending-add list is non-empty, so derive it rather than hand-syncing a flag.
const adding = computed(() => pendingAdds.value.length > 0);

// Per-button transition state (press → API response). `controlBusy` keys the
// NowPlayingCard buttons (prev/pause/…); `favToggleBusy` keys the ☆ toggles
// by source; `jumpingQid` is the row whose /jump is in flight. Destructured
// so the busy sets are top-level refs (auto-unwrapped in the template).
const { busyKeys: controlBusy, run: runControl } = useBusy();
const { busyKeys: favToggleBusy, run: runFavToggle } = useBusy();
const jumpingQid = ref<number | null>(null);

const pendingRemoveQids = ref<Set<number>>(new Set());

function addPendingQid(qid: number): void {
  const next = new Set(pendingRemoveQids.value);
  next.add(qid);
  pendingRemoveQids.value = next;
}
function dropPendingQids(qids: Iterable<number>): void {
  const next = new Set(pendingRemoveQids.value);
  for (const q of qids) next.delete(q);
  pendingRemoveQids.value = next;
}

const sessionPath = (suffix = "") =>
  "/api/session/" + encodeURIComponent(props.guildId) + suffix;

let timer: number | undefined;

async function refresh() {
  try {
    snap.value = await api<SessionSnapshot>("GET", sessionPath());
  } catch {
    // Auth errors handled globally; transient network errors stay quiet.
  }
}

async function act(
  method: string,
  path: string,
  body?: unknown,
  busyKey?: string,
) {
  const call = async () => {
    try {
      snap.value = await api<SessionSnapshot>(method, path, body);
    } catch (e: any) {
      error(e.message);
    }
  };
  if (busyKey) await runControl(busyKey, call);
  else await call();
}

// Shared "adding…" placeholder lifecycle: shows `shown` as a pending row and
// keeps the + Add button spinning while the enqueue is in flight. `shown` is
// a display label (not the raw source), so a picked library track reads as
// its title rather than a bare id.
async function withPendingAdd(
  shown: string,
  run: () => Promise<void>,
): Promise<void> {
  addText.value = "";
  showSuggestions.value = false;
  pendingAdds.value.push(shown);
  try {
    await run();
  } finally {
    const i = pendingAdds.value.indexOf(shown);
    if (i !== -1) pendingAdds.value.splice(i, 1);
  }
}

async function addSource(raw: string, displayLabel?: string): Promise<void> {
  const v = raw.trim();
  if (!v) return;
  await withPendingAdd(displayLabel ?? v, async () => {
    try {
      snap.value = await api<SessionSnapshot>(
        "POST",
        sessionPath("/queue"),
        { source: v },
      );
      ok("Queued");
    } catch (e: any) {
      error(e.message || "Add failed");
    }
  });
}
function add(): void {
  void addSource(addText.value);
}

// ── add-to-queue autocomplete: server-merged suggestions (top 10) ────
// One priority-ordered list across the viewer's playlists → favorites →
// public playlists → library, filtered server-side by the current input.
const suggestions = ref<QueueSuggestion[]>([]);
let suggestTimer: number | undefined;
// Monotonic request id — a slower earlier fetch must not clobber a newer
// one's results (responses can arrive out of order across keystroke bursts).
let suggestSeq = 0;

async function fetchSuggestions(): Promise<void> {
  const seq = ++suggestSeq;
  try {
    const r = await api<{ suggestions: QueueSuggestion[] }>(
      "GET",
      sessionPath("/queue-suggestions") +
        "?q=" +
        encodeURIComponent(addText.value.trim()),
    );
    if (seq !== suggestSeq) return; // superseded by a newer fetch
    suggestions.value = r.suggestions || [];
  } catch {
    if (seq === suggestSeq) suggestions.value = [];
  }
}
function scheduleSuggest(): void {
  if (suggestTimer !== undefined) window.clearTimeout(suggestTimer);
  suggestTimer = window.setTimeout(fetchSuggestions, 150);
}
watch(addText, () => {
  if (showSuggestions.value) scheduleSuggest();
});

const SUGGEST_HEADER: Record<QueueSuggestion["type"], string> = {
  "user-playlist": "Your playlists",
  favorite: "★ Favorites",
  "public-playlist": "Public playlists",
  library: "Library",
};
function suggestIcon(type: QueueSuggestion["type"]): string {
  return type === "favorite" ? "★" : "🎵";
}
// Group the (already priority-ordered) list into contiguous type sections so
// the dropdown can show a header per source. Headers don't count toward the 10.
const groupedSuggestions = computed(() => {
  const groups: {
    type: QueueSuggestion["type"];
    header: string;
    items: QueueSuggestion[];
  }[] = [];
  for (const s of suggestions.value) {
    let g = groups[groups.length - 1];
    if (!g || g.type !== s.type) {
      g = { type: s.type, header: SUGGEST_HEADER[s.type], items: [] };
      groups.push(g);
    }
    g.items.push(s);
  }
  return groups;
});

function pickSuggestion(item: QueueSuggestion): void {
  if (item.playlistId) {
    const id = item.playlistId;
    void withPendingAdd(item.label, async () => {
      try {
        await api(
          "POST",
          "/api/me/playlists/" + encodeURIComponent(id) + "/queue",
          { guildId: props.guildId },
        );
        ok(`Queued "${item.label}"`);
        await refresh();
      } catch (e: any) {
        error(e.message || "Couldn't queue that playlist");
      }
    });
  } else if (item.source) {
    void addSource(item.source, item.label);
  }
}
function onAddFocus(): void {
  showSuggestions.value = true;
  void fetchSuggestions();
}
function hideSuggestionsSoon(): void {
  // Delay so a suggestion mousedown/click registers before the blur hides it.
  window.setTimeout(() => {
    showSuggestions.value = false;
  }, 120);
}

// ── ☆ toggle from a queue row (PlaylistList emits the Track) ─────────
function onToggleFavorite(t: Track): void {
  const source = trackKey(t);
  if (!source) return;
  // The ☆ only flips once the server confirms membership, so mark the row
  // busy for the round-trip (drives the pulsing pending star).
  void runFavToggle(source, () =>
    toggleFavoriteSource(source, t.label, t.coverUrl),
  );
}

// ── save the current queue as a personal playlist ───────────────────
// Reuses POST /api/me/playlists; the session token (real user) is accepted.
async function saveAsPlaylist(): Promise<void> {
  // Capture each track's cached title + cover alongside its source key, so
  // the saved playlist shows real meta (not the raw URL) when re-queued or
  // previewed. Tracks without a stable key (no trackId/sourceUrl) are dropped.
  const entries = playlist.value
    .map((t) => {
      const source = trackKey(t);
      if (!source) return null;
      const entry: { source: string; label?: string; coverUrl?: string } = {
        source,
      };
      if (t.label) entry.label = t.label;
      if (t.coverUrl) entry.coverUrl = t.coverUrl;
      return entry;
    })
    .filter((e): e is { source: string; label?: string; coverUrl?: string } => !!e);
  if (entries.length === 0) {
    error("Nothing in the playlist to save.");
    return;
  }
  const name = window.prompt("Save the current playlist as — name:")?.trim();
  if (!name) return;
  savingPlaylist.value = true;
  try {
    await api("POST", "/api/me/playlists", { name, entries });
    ok(`Saved "${name}" to your playlists`);
  } catch (e: any) {
    error(e.message || "Couldn't save the playlist");
  } finally {
    savingPlaylist.value = false;
  }
}

function setLoop(mode: LoopMode) {
  act("POST", sessionPath("/loop"), { mode }, "loop");
}
function setAutoplay(on: boolean) {
  act("POST", sessionPath("/autoplay"), { on }, "autoplay");
}
function setShuffle(on: boolean) {
  act("POST", sessionPath("/shuffle"), { on }, "shuffle");
}

// ── dequeue (batched + optimistic — see PlaylistList ✕ click) ─────
let removeBatch: number[] = [];
let removeFlushTimer: number | undefined;
const DEQUEUE_FLUSH_MS = 90;

function scheduleDequeue(qid: number): void {
  addPendingQid(qid);
  if (!removeBatch.includes(qid)) removeBatch.push(qid);
  if (removeFlushTimer !== undefined) window.clearTimeout(removeFlushTimer);
  removeFlushTimer = window.setTimeout(flushDequeue, DEQUEUE_FLUSH_MS);
}

async function flushDequeue(): Promise<void> {
  removeFlushTimer = undefined;
  const qids = removeBatch;
  removeBatch = [];
  if (qids.length === 0) return;
  try {
    snap.value = await api<SessionSnapshot>(
      "POST",
      sessionPath("/dequeue"),
      { qids },
    );
  } catch (e: any) {
    error(e.message);
    await refresh();
  } finally {
    if (snap.value) {
      const present = new Set(snap.value.playlist.map((t) => t.qid));
      dropPendingQids(qids.filter((q) => !present.has(q)));
    }
  }
}

// ── jump (click any played or upcoming track) ───────────────────
async function jumpTo(qid: number): Promise<void> {
  jumpingQid.value = qid;
  try {
    await act("POST", sessionPath("/jump"), { qid });
  } finally {
    if (jumpingQid.value === qid) jumpingQid.value = null;
  }
}

// ── reorder (drag handle) ───────────────────────────────────────
async function reorder(payload: {
  qid: number;
  beforeQid: number | null;
}): Promise<void> {
  await act("POST", sessionPath("/reorder"), payload);
}

const playlist = computed<Track[]>(() => snap.value?.playlist ?? []);
const cursorQid = computed<number | null>(() => snap.value?.cursorQid ?? null);
const currentTrack = computed<Track | null>(() => {
  if (cursorQid.value === null) return null;
  return playlist.value.find((t) => t.qid === cursorQid.value) ?? null;
});
onMounted(() => {
  refresh();
  timer = window.setInterval(refresh, 5000);
});
onUnmounted(() => {
  if (timer !== undefined) clearInterval(timer);
  if (suggestTimer !== undefined) window.clearTimeout(suggestTimer);
});
</script>

<template>
  <div v-if="snap" class="session-layout">
    <NowPlayingCard
      :snap="snap"
      :current="currentTrack"
      :busy="controlBusy"
      @prev="act('POST', sessionPath('/prev'), undefined, 'prev')"
      @pause="(paused: boolean) => act('POST', sessionPath('/pause'), { paused }, 'pause')"
      @next="act('POST', sessionPath('/next'), undefined, 'next')"
      @stop="act('POST', sessionPath('/stop'), undefined, 'stop')"
      @loop="setLoop"
      @autoplay="setAutoplay"
      @shuffle="setShuffle"
    />

    <div class="card">
      <form class="row" @submit.prevent="add">
        <div class="add-wrap grow">
          <input
            v-model="addText"
            class="add-input"
            placeholder="Add to queue — station key / library title / http(s) URL"
            @focus="onAddFocus"
            @blur="hideSuggestionsSoon"
          />
          <ul
            v-if="showSuggestions && suggestions.length > 0"
            class="suggestions"
          >
            <template v-for="g in groupedSuggestions" :key="g.type">
              <li class="suggestions-head">{{ g.header }}</li>
              <li
                v-for="(item, i) in g.items"
                :key="g.type + ':' + (item.source ?? item.playlistId ?? i)"
                class="suggestion"
                @mousedown.prevent="pickSuggestion(item)"
              >
                <Thumb :src="item.coverUrl" :placeholder="suggestIcon(item.type)" />
                <div class="suggestion-info">
                  <span class="suggestion-label">{{ item.label }}</span>
                  <span v-if="item.sub" class="suggestion-sub">{{ item.sub }}</span>
                </div>
              </li>
            </template>
          </ul>
        </div>
        <AppButton type="submit" :loading="adding">+ Add</AppButton>
      </form>
    </div>

    <div class="topbar topbar-tracks">
      <span class="muted">{{ playlist.length }} track{{ playlist.length === 1 ? "" : "s" }} in playlist</span>
      <AppButton
        v-if="loggedIn && playlist.length > 0"
        variant="ghost"
        size="sm"
        :loading="savingPlaylist"
        @click="saveAsPlaylist"
      >Save as playlist</AppButton>
    </div>

    <div class="playlist-scroll">
      <PlaylistList
        :playlist="playlist"
        :cursor-qid="cursorQid"
        :pending-remove-qids="pendingRemoveQids"
        :pending-adds="pendingAdds"
        :can-favorite="!!loggedIn"
        :favorite-sources="favoriteSources"
        :busy-jump-qid="jumpingQid"
        :busy-fav-keys="favToggleBusy"
        @dequeue="scheduleDequeue"
        @jump="jumpTo"
        @reorder="reorder"
        @toggle-favorite="onToggleFavorite"
      />
    </div>
  </div>
</template>

<style scoped>
/* Fill the viewport beneath the app header — NowPlayingCard, the add
   box, and the tracks topbar take their natural heights; the playlist
   takes the remainder and scrolls internally when it overflows. */
.session-layout {
  flex: 1;
  display: flex;
  flex-direction: column;
  min-height: 0;
}
.topbar-tracks {
  margin: 0.75rem 0 0.5rem;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 0.5rem;
}

/* Add-to-queue box + favorites autocomplete dropdown. */
.add-wrap { position: relative; }
.add-input { width: 100%; }
.suggestions {
  position: absolute;
  top: calc(100% + 4px);
  left: 0;
  right: 0;
  z-index: 20;
  margin: 0;
  padding: 0.25rem;
  list-style: none;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  box-shadow: 0 6px 20px rgba(0, 0, 0, 0.18);
  max-height: 320px;
  overflow-y: auto;
}
.suggestions-head {
  font-size: 0.7rem;
  text-transform: uppercase;
  letter-spacing: 0.07em;
  color: var(--text-muted);
  padding: 0.2rem 0.4rem 0.35rem;
}
.suggestion {
  display: flex;
  align-items: center;
  gap: 0.5rem;
  padding: 0.35rem 0.4rem;
  border-radius: var(--radius-sm);
  cursor: pointer;
}
.suggestion:hover { background: var(--bg-surface-hover); }
.suggestion-info {
  min-width: 0;
  flex: 1;
  display: flex;
  flex-direction: column;
}
.suggestion-label {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.9rem;
}
.suggestion-sub {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  font-size: 0.75rem;
  color: var(--text-muted);
}
.playlist-scroll {
  flex: 1;
  overflow-y: auto;
  min-height: 0;
  /* Padding keeps the focus / hover ring on the last row from being
     clipped by the scroll container. */
  padding: 2px;
  margin: -2px;
}
</style>
