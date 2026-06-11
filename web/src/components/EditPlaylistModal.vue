<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import Sortable from "sortablejs";
import { AppButton, AppModal } from "@karyl-chan/ui";
import Thumb from "./Thumb.vue";
import { api } from "../api";
import { useToast } from "../composables/use-toast";
import type {
  LibraryTrack,
  Playlist,
  PlaylistEntryInfo,
} from "../types";

const props = defineProps<{
  /** The playlist being edited; null = "create new". */
  playlist: Playlist | null;
  visible: boolean;
  /** Library snapshot — passed in instead of re-fetched per modal open
   *  so the "+ from library" picker is instant. */
  library: LibraryTrack[];
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "saved"): void;
}>();

const { ok, error } = useToast();

// ── form state ────────────────────────────────────────────────────────
// Each row carries a per-modal-instance `uid` independent of `src` so
// SortableJS reorders can use stable :key values. With `:key="i"` Vue
// would patch content in place (the keys 0..n match before/after the
// splice) while leaving the post-drag DOM order set by SortableJS —
// the visual result was the dragged row appearing at the wrong index.
let nextEntryUid = 1;
interface EntryRow { uid: number; src: string }
function wrapEntries(srcs: readonly string[]): EntryRow[] {
  return srcs.map((src) => ({ uid: nextEntryUid++, src }));
}

const name = ref("");
const description = ref("");
const entries = ref<EntryRow[]>([]);
const previews = ref<Record<string, PlaylistEntryInfo>>({});
const saving = ref(false);

// "+ paste source" inline input — non-empty means the input row is open.
const pasteOpen = ref(false);
const pasteText = ref("");

// "+ from library" picker — non-null means the picker overlay is open.
const pickerOpen = ref(false);
const pickerSearch = ref("");

const isCreate = computed(() => props.playlist === null);

const libraryById = computed(() => {
  const m = new Map<string, LibraryTrack>();
  for (const t of props.library) m.set(t.id, t);
  return m;
});

/** Library tracks that aren't already in `entries` (we only filter by
 *  exact id match — pasting a sourceUrl that resolves to a library
 *  track is still allowed; that's a deliberate user choice). */
const pickerCandidates = computed(() => {
  const have = new Set(entries.value.map((e) => e.src));
  const q = pickerSearch.value.trim().toLowerCase();
  return props.library.filter((t) => {
    if (have.has(t.id)) return false;
    if (!q) return true;
    return (
      t.title.toLowerCase().includes(q) ||
      (t.author ?? "").toLowerCase().includes(q) ||
      (t.album ?? "").toLowerCase().includes(q)
    );
  });
});

// ── reset on every open ───────────────────────────────────────────────
// Same idiom as EditTrackModal: re-init on visible: false → true so
// the form picks up the *current* props.playlist even when the parent
// re-opens the modal with the same object reference.
watch(
  () => props.visible,
  (now) => {
    if (!now) return;
    const p = props.playlist;
    name.value = p?.name ?? "";
    description.value = p?.description ?? "";
    entries.value = wrapEntries(p?.entries ?? []);
    previews.value = {};
    pasteOpen.value = false;
    pasteText.value = "";
    pickerOpen.value = false;
    pickerSearch.value = "";
    saving.value = false;
    // Prime previews for everything we just loaded.
    for (const e of entries.value) primePreview(e.src);
  },
);

// ── lookup helpers ────────────────────────────────────────────────────
/** Resolve an entry into a human-friendly preview. Library hits are
 *  filled in locally (no network) so the common case stays instant;
 *  URL / unknown strings fall through to the server endpoint. */
async function primePreview(source: string): Promise<void> {
  if (previews.value[source]) return;
  const lib = libraryById.value.get(source);
  if (lib) {
    previews.value = {
      ...previews.value,
      [source]: {
        kind: "library",
        trackId: lib.id,
        label: lib.title,
        ...(lib.author ? { author: lib.author } : {}),
        ...(lib.album ? { album: lib.album } : {}),
        ...(lib.coverUrl ? { coverUrl: lib.coverUrl } : {}),
      },
    };
    return;
  }
  try {
    const info = await api<PlaylistEntryInfo>(
      "POST",
      "/api/playlists/lookup-entry",
      { source },
    );
    previews.value = { ...previews.value, [source]: info };
  } catch {
    // Network/validation hiccup — leave it as a bare string row.
  }
}

function entryLabel(source: string): string {
  return previews.value[source]?.label ?? source;
}

function entrySub(source: string): string {
  const info = previews.value[source];
  if (!info) return "";
  if (info.kind === "library") {
    const bits = [info.author, info.album].filter(Boolean);
    return bits.length ? bits.join(" · ") : "library track";
  }
  if (info.kind === "url") return "external URL";
  return "raw source";
}

function entryCover(source: string): string | undefined {
  const info = previews.value[source];
  return info?.kind === "library" ? info.coverUrl : undefined;
}

// ── entry mutations ───────────────────────────────────────────────────
function addEntry(source: string): void {
  const s = source.trim();
  if (!s) return;
  if (entries.value.some((e) => e.src === s)) {
    error(`"${s}" is already in this playlist`);
    return;
  }
  entries.value = [...entries.value, { uid: nextEntryUid++, src: s }];
  primePreview(s);
}

function removeEntry(idx: number): void {
  const next = entries.value.slice();
  next.splice(idx, 1);
  entries.value = next;
}

function commitPaste(): void {
  const v = pasteText.value;
  pasteText.value = "";
  pasteOpen.value = false;
  if (v.trim()) addEntry(v);
}

function pickFromLibrary(t: LibraryTrack): void {
  addEntry(t.id);
}

// ── drag-reorder wiring (entries list) ─────────────────────────────────
const listEl = ref<HTMLElement | null>(null);
let sortable: Sortable | null = null;

function bindSortable(): void {
  if (!listEl.value || sortable) return;
  sortable = Sortable.create(listEl.value, {
    handle: ".drag-handle",
    animation: 150,
    ghostClass: "drag-ghost",
    onEnd: (evt) => {
      const from = evt.oldIndex ?? -1;
      const to = evt.newIndex ?? -1;
      if (from === -1 || to === -1 || from === to) return;
      // SortableJS already moved the DOM; mirror it in our reactive
      // array so the next render matches.
      const next = entries.value.slice();
      const [moved] = next.splice(from, 1);
      next.splice(to, 0, moved);
      entries.value = next;
    },
  });
}

// Bind when the list element first appears (entries.length > 0 toggles
// it via v-if), tear down when it leaves.
watch(listEl, (el) => {
  if (sortable) {
    sortable.destroy();
    sortable = null;
  }
  if (el) bindSortable();
});
onBeforeUnmount(() => {
  sortable?.destroy();
  sortable = null;
});

// ── save ──────────────────────────────────────────────────────────────
async function save(): Promise<void> {
  if (!name.value.trim()) {
    error("Name is required");
    return;
  }
  saving.value = true;
  try {
    const srcs = entries.value.map((e) => e.src);
    if (isCreate.value) {
      await api("POST", "/api/playlists", {
        name: name.value,
        description: description.value,
        entries: srcs,
      });
      ok("Playlist created");
    } else {
      await api(
        "PATCH",
        `/api/playlists/${encodeURIComponent(props.playlist!.id)}`,
        {
          name: name.value,
          description: description.value,
          entries: srcs,
        },
      );
      ok("Playlist saved");
    }
    emit("saved");
    emit("close");
  } catch (e: any) {
    error(e.message);
  } finally {
    saving.value = false;
  }
}
</script>

<template>
  <AppModal
    :visible="visible"
    :title="isCreate ? 'New playlist' : 'Edit playlist'"
    width="min(560px, 94vw)"
    @close="emit('close')"
  >
    <form class="edit-form" @submit.prevent="save">
      <div class="field">
        <label>Name</label>
        <input v-model="name" maxlength="80" placeholder="e.g. Late night" />
      </div>
      <div class="field">
        <label>Description (optional)</label>
        <input
          v-model="description"
          maxlength="500"
          placeholder="What this playlist is for"
        />
      </div>

      <div class="field">
        <label>
          Entries
          <span class="count">{{ entries.length }}</span>
        </label>

        <ul
          v-if="entries.length > 0"
          ref="listEl"
          class="entry-list"
        >
          <!-- Key by uid (per-modal-instance, stable across drags). With
               an index key Vue patches in place after SortableJS moves
               DOM nodes — the dragged row ends up at the wrong index.
               A uid lets Vue's diff line up the new array with the
               post-drag DOM. -->
          <li
            v-for="(entry, i) in entries"
            :key="entry.uid"
            class="entry"
            :class="{ 'entry--unknown': previews[entry.src]?.kind === 'unknown' }"
          >
            <span class="drag-handle" title="Drag to reorder">⋮⋮</span>
            <Thumb :src="entryCover(entry.src)" />
            <div class="entry-info">
              <div class="entry-label">{{ entryLabel(entry.src) }}</div>
              <div class="entry-sub">{{ entrySub(entry.src) || entry.src }}</div>
            </div>
            <AppButton
              variant="ghost"
              size="sm"
              title="Remove"
              @click.stop="removeEntry(i)"
            >✕</AppButton>
          </li>
        </ul>
        <div v-else class="empty">No entries yet.</div>

        <div class="add-row">
          <AppButton
            variant="ghost"
            size="sm"
            @click="pickerOpen = !pickerOpen; pasteOpen = false"
          >+ from library</AppButton>
          <AppButton
            variant="ghost"
            size="sm"
            @click="pasteOpen = !pasteOpen; pickerOpen = false"
          >+ paste source</AppButton>
        </div>

        <div v-if="pasteOpen" class="paste-row">
          <input
            v-model="pasteText"
            placeholder="Library track ID, station key, http(s) URL…"
            @keydown.enter.prevent="commitPaste"
          />
          <AppButton variant="ghost" size="sm" @click="commitPaste">Add</AppButton>
        </div>

        <div v-if="pickerOpen" class="picker">
          <input
            v-model="pickerSearch"
            placeholder="Search library…"
          />
          <ul class="picker-list">
            <li v-if="pickerCandidates.length === 0" class="picker-empty">
              {{ library.length === 0 ? "Library is empty — /radio download first." : "No matches." }}
            </li>
            <li
              v-for="t in pickerCandidates"
              :key="t.id"
              class="picker-row"
              @click="pickFromLibrary(t)"
            >
              <Thumb :src="t.coverUrl" />
              <div class="entry-info">
                <div class="entry-label">{{ t.title }}</div>
                <div class="entry-sub">
                  {{ [t.author, t.album].filter(Boolean).join(" · ") || "library track" }}
                </div>
              </div>
              <span class="picker-add">+ add</span>
            </li>
          </ul>
        </div>
      </div>

      <div class="foot">
        <AppButton variant="ghost" @click="emit('close')">Cancel</AppButton>
        <AppButton type="submit" :loading="saving">
          {{ isCreate ? "Create" : "Save" }}
        </AppButton>
      </div>
    </form>
  </AppModal>
</template>

<style scoped>
.edit-form {
  display: flex;
  flex-direction: column;
  gap: 0.85rem;
}
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.field label {
  display: flex;
  align-items: center;
  gap: 0.45rem;
  font-size: 0.78rem;
  color: var(--text-muted);
  font-weight: 550;
}
.count {
  display: inline-flex;
  align-items: center;
  padding: 0 0.45rem;
  height: 1.1rem;
  border-radius: 999px;
  background: var(--bg-surface-2);
  color: var(--text);
  font-size: 0.7rem;
  font-weight: 600;
}

.entry-list {
  list-style: none;
  margin: 0;
  padding: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
  max-height: 280px;
  overflow-y: auto;
  padding: 2px;
  margin: -2px;
}
.entry {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.5rem 0.65rem;
}
.entry--unknown { border-style: dashed; opacity: 0.85; }
.entry-info { min-width: 0; flex: 1; }
.entry-label {
  font-weight: 550;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.entry-sub {
  color: var(--text-muted);
  font-size: 0.78rem;
  margin-top: 0.1rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}

.empty {
  padding: 0.85rem;
  text-align: center;
  color: var(--text-muted);
  font-size: 0.85rem;
  border: 1px dashed var(--border);
  border-radius: var(--radius-sm);
}

.add-row {
  display: flex;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.paste-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
}
.paste-row input { flex: 1; }

.picker {
  margin-top: 0.25rem;
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.45rem;
  background: var(--bg-surface-2);
  display: flex;
  flex-direction: column;
  gap: 0.45rem;
}
.picker-list {
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 240px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 0.3rem;
}
.picker-empty {
  padding: 0.65rem;
  text-align: center;
  color: var(--text-muted);
  font-size: 0.82rem;
}
.picker-row {
  display: flex;
  gap: 0.55rem;
  align-items: center;
  padding: 0.4rem 0.55rem;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  cursor: pointer;
  transition: background var(--transition-fast);
}
.picker-row:hover { background: var(--bg-surface-hover); }
.picker-add {
  flex-shrink: 0;
  color: var(--accent);
  font-size: 0.78rem;
  font-weight: 550;
}

.drag-handle {
  flex-shrink: 0;
  cursor: grab;
  color: var(--text-faint);
  font-size: 1rem;
  user-select: none;
  padding: 0 0.15rem;
  letter-spacing: -0.15em;
  line-height: 1;
}
.drag-handle:hover { color: var(--text); }
.drag-handle:active { cursor: grabbing; }
.drag-ghost { opacity: 0.4; background: var(--bg-surface-2); }

.foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.25rem;
}
</style>
