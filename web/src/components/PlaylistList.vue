<script setup lang="ts">
import { computed, nextTick, onBeforeUnmount, onMounted, ref, watch } from "vue";
import Sortable from "sortablejs";
import AppButton from "./AppButton.vue";
import Thumb from "./Thumb.vue";
import TrackLink from "./TrackLink.vue";
import { trackMeta } from "../composables/use-format";
import type { Track } from "../types";

/**
 * Unified playlist view. Renders the full cursor-based `playlist[]` as a
 * single ordered list with no played / upcoming split — the currently-
 * playing track is marked inline with an accent border and a ▶ glyph.
 * Every row (including the cursor row) is draggable; non-cursor rows
 * also show a hover-only ▶ jump button left of the ✕ remove button. The
 * cursor row has neither (you can't jump to what's already playing,
 * and removing a row that's streaming is confusing).
 */
const props = defineProps<{
  playlist: Track[];
  cursorQid: number | null;
  /** qids the user clicked ✕ on; rendered as locally-hidden so the
   *  list reacts immediately before the server confirms. */
  pendingRemoveQids: Set<number>;
  /** qids the user just queued via the Add box that the server hasn't
   *  echoed back yet. Rendered as muted "adding…" placeholders. */
  pendingAdds: string[];
}>();

const emit = defineEmits<{
  (e: "dequeue", qid: number): void;
  (e: "jump", qid: number): void;
  (e: "reorder", payload: { qid: number; beforeQid: number | null }): void;
}>();

/** Visible rows = playlist minus optimistically-removed qids; each row
 *  carries its own `isCursor` flag so the template doesn't re-check
 *  cursorQid for every cell in every row. */
interface Row {
  t: Track;
  isCursor: boolean;
}
const rows = computed<Row[]>(() =>
  props.playlist
    .filter((t) => !props.pendingRemoveQids.has(t.qid))
    .map((t) => ({
      t,
      isCursor: props.cursorQid !== null && t.qid === props.cursorQid,
    })),
);

function sub(t: Track): string {
  const meta = trackMeta(t);
  const who = t.queuedByName || t.queuedBy;
  const queued = who ? "queued by " + who : "";
  return [meta, queued].filter(Boolean).join(" · ");
}

// ── drag-reorder wiring ─────────────────────────────────────────────
// One SortableJS instance over the unified `<ul>`. The cursor row IS
// draggable (the backend's `reorderByQid` re-anchors the cursor by qid
// after the splice, so moving the currently-playing track to a new
// position keeps it playing). Only pending-add placeholders are
// excluded via `.no-drag` — they have no qid yet and can't take part
// in a reorder.

const listEl = ref<HTMLElement | null>(null);
let sortable: Sortable | null = null;

function bindSortable() {
  if (!listEl.value || sortable) return;
  sortable = Sortable.create(listEl.value, {
    handle: ".drag-handle",
    filter: ".no-drag",
    preventOnFilter: false,
    animation: 150,
    ghostClass: "drag-ghost",
    chosenClass: "drag-chosen",
    dragClass: "drag-active",
    onEnd: (evt) => {
      const item = evt.item as HTMLElement;
      const movedQid = Number(item.dataset.qid);
      if (!movedQid) return;
      // Skip pending-add placeholders (no `data-qid`) when looking for
      // the drop anchor; they aren't real entries.
      let nextItem = item.nextElementSibling as HTMLElement | null;
      while (nextItem && !nextItem.dataset.qid) {
        nextItem = nextItem.nextElementSibling as HTMLElement | null;
      }
      const beforeQid = nextItem ? Number(nextItem.dataset.qid) : null;
      emit("reorder", { qid: movedQid, beforeQid });
    },
  });
}

onMounted(bindSortable);
// The `<ul>` is v-if-gated on having any rows; it (re)mounts when the
// playlist transitions empty ↔ non-empty. Tear down and rebind so the
// Sortable instance always points at the live element.
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

// ── keep the cursor row visible across track advances ───────────────
// `immediate: true` so the initial cursor (from the first snapshot
// poll) is also scrolled into view at page-load time without a track
// change — `onMounted` runs before `refresh()` resolves and would find
// an empty list.
function scrollCursorIntoView(behavior: ScrollBehavior): void {
  const el = listEl.value?.querySelector<HTMLElement>('[data-cursor="true"]');
  if (!el) return;
  el.scrollIntoView({ behavior, block: "nearest" });
}
let firstScroll = true;
watch(
  () => props.cursorQid,
  () => {
    const behavior: ScrollBehavior = firstScroll ? "auto" : "smooth";
    firstScroll = false;
    nextTick(() => scrollCursorIntoView(behavior));
  },
  { immediate: true },
);
</script>

<template>
  <ul
    v-if="rows.length > 0 || pendingAdds.length > 0"
    ref="listEl"
    class="list"
  >
    <li
      v-for="({ t, isCursor }, i) in rows"
      :key="t.qid"
      :data-qid="t.qid"
      :data-cursor="isCursor ? 'true' : null"
      class="item track-item"
      :class="{ 'cursor-item': isCursor }"
      :title="isCursor ? 'Currently playing' : t.label"
    >
      <span class="drag-handle" title="Drag to reorder" @click.stop>⋮⋮</span>

      <!-- idx slot doubles as the play-this-track affordance on
           non-cursor rows: number by default, ▶ glyph on hover/focus
           (matches the cursor row's static ▶ in colour + weight). The
           cursor row renders a plain span. -->
      <span v-if="isCursor" class="idx idx--cursor">▶</span>
      <button
        v-else
        type="button"
        class="idx idx--jump"
        title="Play this track"
        @click.stop="emit('jump', t.qid)"
      >
        <span class="idx-num">{{ i + 1 }}</span>
      </button>

      <Thumb :src="t.coverUrl" />

      <div class="info">
        <div class="name">
          <TrackLink :label="t.label" :url="t.sourceUrl" />
        </div>
        <div class="dim" v-if="sub(t)">{{ sub(t) }}</div>
      </div>

      <div class="actions">
        <AppButton
          v-if="!isCursor"
          variant="ghost"
          size="sm"
          class="row-action row-action--remove"
          title="Remove"
          @click.stop="emit('dequeue', t.qid)"
        >✕</AppButton>
      </div>
    </li>

    <li
      v-for="src in pendingAdds"
      :key="'add-' + src"
      class="item track-item pending no-drag"
    >
      <span class="drag-handle drag-handle--ghost" aria-hidden="true">⋮⋮</span>
      <span class="idx" />
      <Thumb placeholder="⏳" />
      <div class="info">
        <div class="name">{{ src }}</div>
        <div class="dim">adding…</div>
      </div>
    </li>
  </ul>
  <div v-else class="empty">Playlist is empty.</div>
</template>

<style scoped>
.item {
  display: flex;
  gap: 0.6rem;
  align-items: center;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.55rem 0.7rem;
  transition: background var(--transition-fast),
    border-color var(--transition-fast);
}

.track-item:hover { background: var(--bg-surface-hover); }
.track-item.pending {
  opacity: 0.55;
}

/* Currently-playing row: accent left-border + accent idx glyph. The
   drag handle is the only interactive bit (the controls for prev/pause/
   next live in NowPlayingCard). */
.cursor-item {
  border-color: var(--accent);
  box-shadow: inset 3px 0 0 var(--accent);
  padding-left: calc(0.7rem + 3px);
}
.cursor-item:hover { background: var(--bg-surface); }

/* Row-level action buttons (▶ jump / ✕ remove) — present in the DOM so
   the row's height stays stable, revealed only on hover. Keyboard focus
   also reveals them so they remain reachable without a pointer. */
.row-action {
  opacity: 0;
  transition: opacity var(--transition-fast);
}
.track-item:hover .row-action,
.row-action:focus-visible {
  opacity: 1;
}

.idx {
  color: var(--text-faint);
  font-variant-numeric: tabular-nums;
  width: 1.6em;
  text-align: right;
  flex-shrink: 0;
  line-height: 1.2;
}
.idx--cursor {
  color: var(--accent);
  font-weight: 600;
}
/* Idx slot rendered as a frameless button on non-cursor rows: shows the
   track number by default, swaps to a ▶ glyph styled identically to the
   cursor row's static ▶ on row hover / keyboard focus. The ::before
   carries the ▶ so the number can fade out in-place without a layout
   shift. */
.idx--jump {
  position: relative;
  background: transparent;
  border: 0;
  padding: 0;
  margin: 0;
  font: inherit;
  cursor: pointer;
}
.idx--jump::before {
  content: "▶";
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: flex-end;
  /* Standard control-button colour — distinct from the accent-tinted
     ▶ on the cursor row, so the hover affordance reads as a button
     rather than another playing marker. */
  color: var(--text);
  font-weight: 600;
  opacity: 0;
  transition: opacity var(--transition-fast);
}
.idx-num {
  display: inline-block;
  transition: opacity var(--transition-fast);
}
.track-item:hover .idx--jump .idx-num,
.idx--jump:focus-visible .idx-num {
  opacity: 0;
}
.track-item:hover .idx--jump::before,
.idx--jump:focus-visible::before {
  opacity: 1;
}

.info { min-width: 0; flex: 1; }
.name {
  font-weight: 550;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.dim {
  color: var(--text-muted);
  font-size: 0.8rem;
  margin-top: 0.1rem;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.actions {
  display: flex;
  gap: 0.35rem;
  flex-shrink: 0;
  align-items: center;
  /* Just the ✕ remove button now (▶ moved to the idx slot). Reserved
     so a hover-reveal doesn't shift the row's other contents. */
  min-width: 1.8rem;
  justify-content: flex-end;
}

/* drag */
.drag-handle {
  flex-shrink: 0;
  cursor: grab;
  color: var(--text-faint);
  font-size: 1rem;
  user-select: none;
  padding: 0 0.2rem;
  letter-spacing: -0.15em;
  line-height: 1;
  transition: color var(--transition-fast);
}
.drag-handle:hover { color: var(--text); }
.drag-handle:active { cursor: grabbing; }
.drag-handle--ghost { visibility: hidden; cursor: default; }
.drag-ghost {
  opacity: 0.4;
  background: var(--bg-surface-2);
}
.drag-chosen { box-shadow: 0 0 0 1px var(--accent); }
.drag-active {
  background: var(--bg-surface) !important;
  cursor: grabbing;
}
</style>
