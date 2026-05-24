<script setup lang="ts">
import { computed, onBeforeUnmount, ref, watch } from "vue";
import AppButton from "./AppButton.vue";
import AppModal from "./AppModal.vue";
import { api, apiUpload } from "../api";
import { useToast } from "../composables/use-toast";
import type { LibraryTrack } from "../types";

const props = defineProps<{
  track: LibraryTrack | null;
  visible: boolean;
}>();

const emit = defineEmits<{
  (e: "close"): void;
  (e: "saved"): void;
}>();

const { ok, error } = useToast();

const title = ref("");
const author = ref("");
const album = ref("");
const coverUrl = ref("");
/** Local file selected for upload — staged until Save (no standalone upload button). */
const coverFile = ref<File | null>(null);
/** Object URL for the staged file; revoked when replaced or on unmount. */
const localPreview = ref<string | null>(null);
const saving = ref(false);
const fileInput = ref<HTMLInputElement | null>(null);

const previewSrc = computed(() => localPreview.value || coverUrl.value || "");

function clearLocalPreview() {
  if (localPreview.value) {
    URL.revokeObjectURL(localPreview.value);
    localPreview.value = null;
  }
}

// Re-initialise on every visible: false → true edge rather than on
// `props.track` changes. Watching the track alone misses re-opens of the
// *same* track — Vue skips the callback when the ref points at the same
// object — so stale local edits (e.g. cleared cover from a previous
// cancel) leaked into the next open. Resetting on the open edge is
// independent of which track the parent is targeting.
watch(
  () => props.visible,
  (now) => {
    if (!now) return;
    const t = props.track;
    if (!t) return;
    title.value = t.title || "";
    author.value = t.author || "";
    album.value = t.album || "";
    coverUrl.value = t.coverUrl || "";
    coverFile.value = null;
    clearLocalPreview();
    if (fileInput.value) fileInput.value.value = "";
  },
);

onBeforeUnmount(clearLocalPreview);

function pickFile() {
  fileInput.value?.click();
}

function onFile(e: Event) {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0] ?? null;
  // Always clear the input value so the same path can be re-selected
  // later — without this, picking the same file twice in a row fires no
  // `change` event the second time.
  input.value = "";
  if (!f) return;
  if (f.size > 5 * 1024 * 1024) {
    error("Image must be ≤ 5 MB");
    return;
  }
  clearLocalPreview();
  coverFile.value = f;
  localPreview.value = URL.createObjectURL(f);
}

function removeCover() {
  coverFile.value = null;
  coverUrl.value = "";
  clearLocalPreview();
  if (fileInput.value) fileInput.value.value = "";
}

async function save() {
  const t = props.track;
  if (!t) return;
  saving.value = true;
  try {
    // If the user staged a file, upload it first — server saves to disk
    // and sets coverUrl to the served /cover/<id>.<ext> path. Then PATCH
    // the remaining metadata (omitting coverUrl so we don't overwrite
    // the freshly-uploaded URL with whatever was in the input field).
    if (coverFile.value) {
      await apiUpload(
        `/api/tracks/${encodeURIComponent(t.id)}/cover`,
        coverFile.value,
      );
      await api("PATCH", `/api/tracks/${encodeURIComponent(t.id)}`, {
        title: title.value,
        author: author.value,
        album: album.value,
      });
    } else {
      await api("PATCH", `/api/tracks/${encodeURIComponent(t.id)}`, {
        title: title.value,
        author: author.value,
        album: album.value,
        coverUrl: coverUrl.value,
      });
    }
    ok("Saved");
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
  <AppModal :visible="visible" title="Edit metadata" @close="emit('close')">
    <form class="edit-form" @submit.prevent="save">
      <div class="field">
        <label>Title</label>
        <input v-model="title" />
      </div>
      <div class="field">
        <label>Author / artist</label>
        <input v-model="author" />
      </div>
      <div class="field">
        <label>Album</label>
        <input v-model="album" />
      </div>

      <div class="field">
        <label>Cover image</label>
        <div class="cover-row">
          <button
            type="button"
            class="cover-preview"
            :title="coverFile ? coverFile.name : 'Click to pick a new image'"
            @click="pickFile"
          >
            <img v-if="previewSrc" :src="previewSrc" alt="" />
            <span v-else class="cover-placeholder">🎵</span>
            <span class="cover-hover-hint">Pick file</span>
          </button>
          <div class="cover-controls">
            <input
              v-model="coverUrl"
              :disabled="!!coverFile"
              :placeholder="
                coverFile
                  ? '(file ready to upload on save)'
                  : 'https://… image URL'
              "
            />
            <div class="cover-help">
              <span>jpg / png / webp / gif · ≤ 5 MB</span>
              <button
                v-if="coverFile || coverUrl"
                type="button"
                class="cover-clear"
                @click="removeCover"
              >Remove cover</button>
            </div>
          </div>
          <input
            ref="fileInput"
            type="file"
            class="cover-file-hidden"
            accept="image/jpeg,image/png,image/webp,image/gif"
            @change="onFile"
          />
        </div>
      </div>

      <div class="foot">
        <AppButton variant="ghost" @click="emit('close')">Cancel</AppButton>
        <AppButton type="submit" :loading="saving">Save</AppButton>
      </div>
    </form>
  </AppModal>
</template>

<style scoped>
.edit-form { display: flex; flex-direction: column; gap: 0.85rem; }
.field { display: flex; flex-direction: column; gap: 0.3rem; }
.field label {
  font-size: 0.78rem;
  color: var(--text-muted);
  font-weight: 550;
}
.foot {
  display: flex;
  justify-content: flex-end;
  gap: 0.5rem;
  margin-top: 0.25rem;
}

.cover-row {
  display: flex;
  gap: 0.75rem;
  align-items: flex-start;
}

.cover-preview {
  position: relative;
  width: 96px;
  height: 96px;
  flex-shrink: 0;
  padding: 0;
  border: 1px solid var(--border);
  border-radius: var(--radius);
  background: var(--bg-surface-2);
  cursor: pointer;
  overflow: hidden;
  display: flex;
  align-items: center;
  justify-content: center;
  transition: border-color var(--transition-fast);
}
.cover-preview:hover { border-color: var(--accent); }
.cover-preview img {
  width: 100%;
  height: 100%;
  object-fit: cover;
  display: block;
}
.cover-placeholder {
  color: var(--text-faint);
  font-size: 2rem;
}
.cover-hover-hint {
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  color: #fff;
  font-size: 0.78rem;
  font-weight: 550;
  opacity: 0;
  transition: opacity var(--transition-fast);
  pointer-events: none;
}
.cover-preview:hover .cover-hover-hint,
.cover-preview:focus-visible .cover-hover-hint {
  opacity: 1;
}

.cover-controls {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 0.35rem;
}
.cover-controls input:disabled {
  opacity: 0.55;
  cursor: not-allowed;
}
.cover-help {
  display: flex;
  justify-content: space-between;
  align-items: center;
  gap: 0.5rem;
  font-size: 0.75rem;
  color: var(--text-muted);
}
.cover-clear {
  background: none;
  border: none;
  color: var(--danger);
  font: inherit;
  font-size: 0.75rem;
  cursor: pointer;
  padding: 0;
}
.cover-clear:hover { text-decoration: underline; }

.cover-file-hidden { display: none; }
</style>
