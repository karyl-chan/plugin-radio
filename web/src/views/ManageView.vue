<script setup lang="ts">
import { computed, onMounted, ref } from "vue";
import { AppButton, AppTabs, type TabDef } from "@karyl-chan/ui";
import Thumb from "../components/Thumb.vue";
import TrackLink from "../components/TrackLink.vue";
import EditTrackModal from "../components/EditTrackModal.vue";
import EditPlaylistModal from "../components/EditPlaylistModal.vue";
import { api, apiUpload } from "../api";
import { useToast } from "../composables/use-toast";
import { fmtDur, fmtSize } from "../composables/use-format";
import type { LibraryTrack, Playlist } from "../types";

const { ok, error } = useToast();

type Tab = "tracks" | "playlists";
const activeTab = ref<Tab>("tracks");
const tabs: TabDef[] = [
  { key: "tracks", label: "Tracks" },
  { key: "playlists", label: "Playlists" },
];
function pickTab(key: string): void {
  if (key === "tracks" || key === "playlists") activeTab.value = key;
}

const tracks = ref<LibraryTrack[]>([]);
const searchText = ref("");
// Manager-only audio upload — picked file is staged, then `uploadSelected`
// sends it to /api/tracks/upload (multipart, with optional title field).
const uploadFile = ref<File | null>(null);
const uploadTitle = ref("");
const uploading = ref(false);
const uploadInput = ref<HTMLInputElement | null>(null);
// Single source of truth for the edit modal: non-null means "open with
// this track", null means closed. Avoids the easy-to-desync mistake of
// updating the track ref but not the visible ref (or vice versa) when
// adding new entry points.
const editing = ref<LibraryTrack | null>(null);
const editVisible = computed(() => editing.value !== null);

// Playlists tab. Single discriminated ref — the literal "new" means
// "open the modal in create mode", a Playlist means "open in edit mode
// with this row", and null means closed. Keeps "what does the modal
// show?" expressible in one piece of state (the same single-source
// invariant the edit-track modal uses).
const playlists = ref<Playlist[]>([]);
type PlaylistEditState = Playlist | "new" | null;
const playlistEditing = ref<PlaylistEditState>(null);
const playlistEditVisible = computed(() => playlistEditing.value !== null);
const playlistEditingTarget = computed<Playlist | null>(() =>
  playlistEditing.value === "new" || playlistEditing.value === null
    ? null
    : playlistEditing.value,
);

async function load() {
  try {
    const q = searchText.value.trim();
    const r = await api<{ tracks: LibraryTrack[] }>(
      "GET",
      "/api/tracks" + (q ? "?q=" + encodeURIComponent(q) : ""),
    );
    tracks.value = r.tracks || [];
  } catch (e: any) {
    error(e.message);
  }
}

function pickUpload(): void {
  uploadInput.value?.click();
}

function onUploadFile(e: Event): void {
  const input = e.target as HTMLInputElement;
  const f = input.files?.[0] ?? null;
  // Clear the input value so picking the same path twice in a row still
  // fires `change` — matches the cover-picker pattern in EditTrackModal.
  input.value = "";
  if (!f) return;
  uploadFile.value = f;
  // Default the title to the file's basename (sans extension) — the
  // server falls back to the same thing if title is blank, but showing
  // it in the field lets the manager tweak it before sending.
  if (!uploadTitle.value.trim()) {
    uploadTitle.value = f.name.replace(/\.[^.]+$/, "");
  }
}

function clearUploadSelection(): void {
  uploadFile.value = null;
  uploadTitle.value = "";
  if (uploadInput.value) uploadInput.value.value = "";
}

async function uploadSelected(): Promise<void> {
  const f = uploadFile.value;
  if (!f) return;
  uploading.value = true;
  try {
    // apiUpload's single-File signature covers the wire format we need
    // (the server defaults the title to the filename's basename). If the
    // manager edited the title field we PATCH afterwards in one extra
    // call — keeps apiUpload's signature unchanged for the cover route.
    const r = await apiUpload<{
      alreadyExisted: boolean;
      track: LibraryTrack;
    }>("/api/tracks/upload", f);
    const t = uploadTitle.value.trim();
    if (t && t !== r.track.title) {
      try {
        await api("PATCH", "/api/tracks/" + encodeURIComponent(r.track.id), {
          title: t,
        });
      } catch (e: any) {
        error(`Uploaded, but couldn't set title: ${e.message}`);
      }
    }
    ok(r.alreadyExisted ? "Already in library" : "Uploaded");
    clearUploadSelection();
    await load();
  } catch (e: any) {
    error(e.message);
  } finally {
    uploading.value = false;
  }
}

function openEdit(t: LibraryTrack) {
  editing.value = t;
}
function closeEdit() {
  editing.value = null;
}

// ── Playlists ───────────────────────────────────────────────────────
async function loadPlaylists(): Promise<void> {
  try {
    const r = await api<{ playlists: Playlist[] }>("GET", "/api/playlists");
    playlists.value = r.playlists || [];
  } catch (e: any) {
    error(e.message);
  }
}

function openCreatePlaylist(): void {
  playlistEditing.value = "new";
}
function openEditPlaylist(p: Playlist): void {
  playlistEditing.value = p;
}
function closePlaylistEdit(): void {
  playlistEditing.value = null;
}

async function removePlaylist(p: Playlist): Promise<void> {
  if (!confirm(`Delete playlist "${p.name}"?`)) return;
  try {
    await api("DELETE", "/api/playlists/" + encodeURIComponent(p.id));
    ok("Playlist deleted");
    loadPlaylists();
  } catch (e: any) {
    error(e.message);
  }
}

function entryCountText(n: number): string {
  return n === 1 ? "1 entry" : `${n} entries`;
}

async function removeTrack(t: LibraryTrack) {
  if (!confirm(`Delete "${t.title}"? This removes the audio file.`)) return;
  try {
    await api("DELETE", "/api/tracks/" + encodeURIComponent(t.id));
    ok("Deleted");
    load();
  } catch (e: any) {
    error(e.message);
  }
}

function subText(t: LibraryTrack): string {
  return [t.author, t.album, fmtDur(t.duration), fmtSize(t.sizeBytes)]
    .filter(Boolean)
    .join(" · ");
}

onMounted(() => {
  load();
  loadPlaylists();
});
</script>

<template>
  <AppTabs
    :model-value="activeTab"
    :tabs="tabs"
    class="manage-tabs"
    @update:model-value="pickTab"
  />

  <template v-if="activeTab === 'tracks'">
    <div class="card">
      <form class="upload-row" @submit.prevent="uploadSelected">
        <AppButton variant="ghost" type="button" @click="pickUpload">
          🎵 Pick audio file…
        </AppButton>
        <input
          v-model="uploadTitle"
          class="grow"
          :disabled="!uploadFile"
          :placeholder="
            uploadFile
              ? 'Title (defaults to filename if blank)'
              : 'Pick an audio file to upload to your private library'
          "
        />
        <AppButton
          v-if="uploadFile"
          variant="ghost"
          type="button"
          @click="clearUploadSelection"
        >Cancel</AppButton>
        <AppButton
          type="submit"
          :loading="uploading"
          :disabled="!uploadFile"
        >⬆ Upload</AppButton>
        <input
          ref="uploadInput"
          type="file"
          class="upload-file-hidden"
          accept="audio/*,.mp3,.m4a,.aac,.flac,.ogg,.opus,.wav,.webm"
          @change="onUploadFile"
        />
      </form>
      <div v-if="uploadFile" class="upload-staged">
        Ready to upload: <code>{{ uploadFile.name }}</code>
        ({{ fmtSize(uploadFile.size) }})
      </div>
    </div>

    <div class="card">
      <form class="row" @submit.prevent="load">
        <input
          v-model="searchText"
          class="grow"
          placeholder="Search title / album / author / URL…"
        />
        <AppButton variant="ghost" type="submit">Search</AppButton>
      </form>
    </div>

    <section class="section">
      <div class="section-title">Library</div>
      <ul class="list">
        <li v-if="tracks.length === 0" class="empty">No tracks.</li>
        <li v-for="t in tracks" :key="t.id" class="item">
          <Thumb :src="t.coverUrl" />
          <div class="info">
            <div class="name">
              <TrackLink :label="t.title" :url="t.sourceUrl" />
            </div>
            <div class="dim">{{ subText(t) || " " }}</div>
          </div>
          <div class="actions">
            <AppButton variant="ghost" size="sm" @click="openEdit(t)">
              ✎ Edit
            </AppButton>
            <AppButton variant="danger" size="sm" @click="removeTrack(t)">
              🗑
            </AppButton>
          </div>
        </li>
      </ul>
    </section>
  </template>

  <template v-else>
    <div class="card">
      <div class="row">
        <span class="grow muted intro">
          Group library tracks, stations and URLs under a name —
          <code>/radio play &lt;name&gt;</code> queues them all.
        </span>
        <AppButton @click="openCreatePlaylist">+ New playlist</AppButton>
      </div>
    </div>

    <section class="section">
      <div class="section-title">Playlists</div>
      <ul class="list">
        <li v-if="playlists.length === 0" class="empty">
          No playlists yet.
        </li>
        <li v-for="p in playlists" :key="p.id" class="item">
          <div class="thumb thumb--sm thumb--placeholder">🎼</div>
          <div class="info">
            <div class="name">{{ p.name }}</div>
            <div class="dim">
              {{ entryCountText(p.entries.length) }}{{ p.description ? " · " + p.description : "" }}
            </div>
          </div>
          <div class="actions">
            <AppButton variant="ghost" size="sm" @click="openEditPlaylist(p)">
              ✎ Edit
            </AppButton>
            <AppButton variant="danger" size="sm" @click="removePlaylist(p)">
              🗑
            </AppButton>
          </div>
        </li>
      </ul>
    </section>
  </template>

  <EditTrackModal
    :track="editing"
    :visible="editVisible"
    @close="closeEdit"
    @saved="load"
  />

  <EditPlaylistModal
    :playlist="playlistEditingTarget"
    :visible="playlistEditVisible"
    :library="tracks"
    @close="closePlaylistEdit"
    @saved="loadPlaylists"
  />
</template>

<style scoped>
/* AppTabs' scoped CSS sets `flex: 1` on its root so it fills a flex
   parent (the bot frontend pattern where the tab strip IS the page).
   ManageView uses it as a header strip above other content, so undo
   the flex grow — otherwise it consumes the remaining vertical space
   in `.app-wrap` and shoves the tracks / playlists lists to the bottom. */
.manage-tabs {
  flex: 0 0 auto;
  margin-bottom: 0.85rem;
}

.intro code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--bg-surface-2);
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
  font-size: 0.82rem;
}

.upload-row {
  display: flex;
  gap: 0.5rem;
  align-items: center;
  flex-wrap: wrap;
}
.upload-file-hidden { display: none; }
.upload-staged {
  margin-top: 0.4rem;
  font-size: 0.8rem;
  color: var(--text-muted);
}
.upload-staged code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--bg-surface-2);
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
  font-size: 0.78rem;
}

.item {
  display: flex;
  gap: 0.75rem;
  align-items: center;
  background: var(--bg-surface);
  border: 1px solid var(--border);
  border-radius: var(--radius-sm);
  padding: 0.6rem 0.75rem;
}
.thumb {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 44px;
  height: 44px;
  background: var(--bg-surface-2);
  border-radius: var(--radius-sm);
  color: var(--text-faint);
  font-size: 1.1rem;
  flex-shrink: 0;
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
.actions { display: flex; gap: 0.35rem; flex-shrink: 0; }
</style>
