<script setup lang="ts">
import { computed, onBeforeUnmount, onMounted, ref } from "vue";
import { AppButton, AppTabs, Stack, type TabDef } from "@karyl-chan/ui";
import EditPlaylistModal from "../components/EditPlaylistModal.vue";
import { api } from "../api";
import { useToast } from "../composables/use-toast";
import { useApiKeys } from "../composables/use-api-keys";
import type { UserPlaylist, VoiceMatch } from "../types";

const { ok, error } = useToast();

type Tab = "playlists" | "keys";
const activeTab = ref<Tab>("playlists");
const tabs: TabDef[] = [
  { key: "playlists", label: "My Playlists" },
  { key: "keys", label: "API Keys" },
];
function pickTab(key: string): void {
  if (key === "playlists" || key === "keys") activeTab.value = key;
}

// ── voice presence ─────────────────────────────────────────────────
// Polls where the viewing member is currently sitting so the Play button
// knows which channel to start in. `selectedGuildId` is the resolved
// target — the sole match, or the one picked when they're in voice on
// more than one server. Sending it explicitly to /play means the server
// never has to disambiguate (so no 409-candidate handling on the client).
const voiceMatches = ref<VoiceMatch[]>([]);
const selectedGuildId = ref<string | null>(null);
let locateTimer: ReturnType<typeof setInterval> | null = null;

function channelLabel(m: VoiceMatch): string {
  const ch = m.channelName ? `#${m.channelName}` : "your channel";
  return m.guildName ? `${ch} · ${m.guildName}` : ch;
}

async function pollLocate(): Promise<void> {
  try {
    const r = await api<{ matches: VoiceMatch[] }>("GET", "/api/me/locate");
    voiceMatches.value = r.matches || [];
    // Keep the selection valid: clear when out of voice, default to the
    // first match when unset or the previous pick has gone away.
    if (voiceMatches.value.length === 0) {
      selectedGuildId.value = null;
    } else if (
      !selectedGuildId.value ||
      !voiceMatches.value.some((m) => m.guildId === selectedGuildId.value)
    ) {
      selectedGuildId.value = voiceMatches.value[0].guildId;
    }
  } catch {
    // best-effort — keep the last known presence on a transient failure
  }
}

const canPlay = computed(() => selectedGuildId.value !== null);
const voiceStatusText = computed(() => {
  const n = voiceMatches.value.length;
  if (n === 0) return "Join a voice channel to play a playlist here.";
  if (n === 1) return `Ready to play in ${channelLabel(voiceMatches.value[0])}`;
  return "You're in voice on more than one server — pick where to play:";
});

// ── playlists ──────────────────────────────────────────────────────
const playlists = ref<UserPlaylist[]>([]);
type PlaylistEditState = UserPlaylist | "new" | null;
const playlistEditing = ref<PlaylistEditState>(null);
const playlistEditVisible = computed(() => playlistEditing.value !== null);
const playlistEditingTarget = computed<UserPlaylist | null>(() =>
  playlistEditing.value === "new" || playlistEditing.value === null
    ? null
    : playlistEditing.value,
);
const playingId = ref<string | null>(null);

async function loadPlaylists(): Promise<void> {
  try {
    const r = await api<{ playlists: UserPlaylist[] }>(
      "GET",
      "/api/me/playlists",
    );
    playlists.value = r.playlists || [];
  } catch (e: any) {
    error(e.message);
  }
}

function openCreatePlaylist(): void {
  playlistEditing.value = "new";
}
function openEditPlaylist(p: UserPlaylist): void {
  playlistEditing.value = p;
}
function closePlaylistEdit(): void {
  playlistEditing.value = null;
}

async function removePlaylist(p: UserPlaylist): Promise<void> {
  if (!confirm(`Delete playlist "${p.name}"?`)) return;
  try {
    await api("DELETE", "/api/me/playlists/" + encodeURIComponent(p.id));
    ok("Playlist deleted");
    loadPlaylists();
  } catch (e: any) {
    error(e.message);
  }
}

async function playPlaylist(p: UserPlaylist): Promise<void> {
  const guildId = selectedGuildId.value;
  if (!guildId) {
    error("Join a voice channel first");
    return;
  }
  playingId.value = p.id;
  try {
    await api("POST", `/api/me/playlists/${encodeURIComponent(p.id)}/play`, {
      guildId,
    });
    ok(`Playing "${p.name}"`);
  } catch (e: any) {
    error(e.message || "Couldn't start playback");
  } finally {
    playingId.value = null;
  }
}

function entryCountText(n: number): string {
  return n === 1 ? "1 entry" : `${n} entries`;
}

// ── API keys (self-service) — shared CRUD (see use-api-keys) ────────
const {
  apiKeys,
  newKeyLabel,
  creatingKey,
  freshKey,
  loadKeys,
  createKey,
  revokeKey,
  copyFreshKey,
  keySubText,
} = useApiKeys("/api/me/keys");

onMounted(() => {
  loadPlaylists();
  loadKeys();
  pollLocate();
  locateTimer = setInterval(pollLocate, 10_000);
});
onBeforeUnmount(() => {
  if (locateTimer) clearInterval(locateTimer);
});
</script>

<template>
  <Stack gap="4">
  <div class="card voice-card">
    <div class="voice-status">
      <span
        class="voice-dot"
        :class="{ 'voice-dot--on': voiceMatches.length > 0 }"
      />
      <span class="grow">{{ voiceStatusText }}</span>
    </div>
    <select
      v-if="voiceMatches.length > 1"
      v-model="selectedGuildId"
      class="voice-picker"
    >
      <option v-for="m in voiceMatches" :key="m.guildId" :value="m.guildId">
        {{ channelLabel(m) }}
      </option>
    </select>
  </div>

  <AppTabs
    :model-value="activeTab"
    :tabs="tabs"
    @update:model-value="pickTab"
  />

  <template v-if="activeTab === 'playlists'">
    <div class="card">
      <div class="row">
        <span class="grow muted intro">
          Your private playlists — only you can see them. <strong>Play</strong>
          starts one in the voice channel you're in.
        </span>
        <AppButton @click="openCreatePlaylist">+ New playlist</AppButton>
      </div>
    </div>

    <section class="section">
      <div class="section-title">My playlists</div>
      <ul class="list">
        <li v-if="playlists.length === 0" class="empty">No playlists yet.</li>
        <li v-for="p in playlists" :key="p.id" class="item">
          <div class="thumb thumb--sm thumb--placeholder">🎵</div>
          <div class="info">
            <div class="name">{{ p.name }}</div>
            <div class="dim">
              {{ entryCountText(p.entries.length) }}{{ p.description ? " · " + p.description : "" }}
            </div>
          </div>
          <div class="actions">
            <AppButton
              size="sm"
              :loading="playingId === p.id"
              :disabled="!canPlay || p.entries.length === 0"
              @click="playPlaylist(p)"
            >▶ Play</AppButton>
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

  <template v-else>
    <div class="card">
      <div class="row">
        <span class="grow muted intro">
          Keys let an external app (e.g. the browser extension) make the bot
          join <strong>your</strong> voice channel and control playback.
          Treat a key like a password.
        </span>
      </div>
      <form class="row" @submit.prevent="createKey">
        <input
          v-model="newKeyLabel"
          class="grow"
          placeholder="Label (e.g. “Chrome extension”)"
        />
        <AppButton type="submit" :loading="creatingKey">+ New key</AppButton>
      </form>
      <div v-if="freshKey" class="fresh-key">
        <div class="fresh-key__label">
          Copy this now — it won't be shown again:
        </div>
        <div class="fresh-key__row">
          <code class="fresh-key__value">{{ freshKey }}</code>
          <AppButton variant="ghost" size="sm" @click="copyFreshKey">
            ⧉ Copy
          </AppButton>
          <AppButton variant="ghost" size="sm" @click="freshKey = null">
            Dismiss
          </AppButton>
        </div>
      </div>
    </div>

    <section class="section">
      <div class="section-title">API keys</div>
      <ul class="list">
        <li v-if="apiKeys.length === 0" class="empty">No API keys.</li>
        <li v-for="k in apiKeys" :key="k.id" class="item">
          <div class="thumb thumb--sm thumb--placeholder">🔑</div>
          <div class="info">
            <div class="name">{{ k.label || "Unlabelled key" }}</div>
            <div class="dim">{{ keySubText(k) }}</div>
          </div>
          <div class="actions">
            <AppButton variant="danger" size="sm" @click="revokeKey(k)">
              Revoke
            </AppButton>
          </div>
        </li>
      </ul>
    </section>
  </template>
  </Stack>

  <EditPlaylistModal
    :playlist="playlistEditingTarget"
    :visible="playlistEditVisible"
    mode="personal"
    @close="closePlaylistEdit"
    @saved="loadPlaylists"
  />
</template>

<style scoped>
/* Vertical rhythm is owned by the <Stack gap="4"> wrapper. Neutralize the
   global .section top margin so it doesn't double up on the stack gap. */
.section { margin-top: 0; }

.voice-card {
  display: flex;
  flex-direction: column;
  gap: 0.5rem;
}
.voice-status {
  display: flex;
  align-items: center;
  gap: 0.55rem;
  font-size: 0.88rem;
}
.voice-dot {
  flex-shrink: 0;
  width: 9px;
  height: 9px;
  border-radius: 50%;
  background: var(--text-faint);
}
.voice-dot--on {
  background: #43b581;
  box-shadow: 0 0 0 3px color-mix(in srgb, #43b581 25%, transparent);
}
.voice-picker {
  width: 100%;
}

/* The list-row + fresh-key + intro styles below mirror ManageView's scoped
   styles (Vue scoped CSS can't be shared) — keep the two in sync. */
.intro code {
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--bg-surface-2);
  padding: 0.05rem 0.3rem;
  border-radius: 4px;
  font-size: 0.82rem;
}

.fresh-key {
  margin-top: 0.6rem;
  padding: 0.6rem 0.7rem;
  border: 1px solid var(--accent, #5865f2);
  border-radius: 6px;
  background: var(--bg-surface-2);
}
.fresh-key__label {
  font-size: 0.8rem;
  margin-bottom: 0.4rem;
  color: var(--text-dim, #aaa);
}
.fresh-key__row {
  display: flex;
  align-items: center;
  gap: 0.5rem;
}
.fresh-key__value {
  flex: 1;
  font-family: ui-monospace, SFMono-Regular, Menlo, monospace;
  font-size: 0.82rem;
  word-break: break-all;
  user-select: all;
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
