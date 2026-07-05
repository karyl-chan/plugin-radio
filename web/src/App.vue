<script setup lang="ts">
import { computed, ref } from "vue";
import { bootstrapPluginSession } from "@karyl-chan/plugin-sdk/web";
import { AppToast, UserAvatar } from "@karyl-chan/ui";
import DeniedView from "./views/DeniedView.vue";
import ManageView from "./views/ManageView.vue";
import PersonalView from "./views/PersonalView.vue";
import SessionView from "./views/SessionView.vue";
import { setApi, api } from "./api";
import type { ViewerProfile } from "./types";

const PLUGIN_KEY = "karyl-radio";

type View = "loading" | "denied" | "session" | "manage" | "personal";
const view = ref<View>("loading");
const deniedMessage = ref<string | null>(null);
// When the SPA boots into session mode, the JWT we read from the URL
// (or sessionStorage) carries the guildId — we still need it for the
// session view's `:guild-id` prop. Manage mode doesn't keep claims
// around: the plugin's access token is opaque to the SPA.
const sessionGuildId = ref<string | null>(null);

// The "logged-in as" profile (name + avatar) for the top-right chip.
// Null = anonymous (the public now-playing token) or not yet resolved.
const viewer = ref<ViewerProfile | null>(null);

function deny(msg: string): void {
  deniedMessage.value = msg;
  view.value = "denied";
}

/** Resolve who's viewing (session or /me tier) for the identity chip.
 *  Best-effort: an anonymous public token or an RPC hiccup just leaves
 *  the chip off. */
async function loadViewer(
  mode: "session" | "personal",
  guildId: string | null,
  userId?: string | null,
): Promise<void> {
  // The public now-playing embed token carries a synthetic radio-np: user
  // — anonymous, no chip. (The server enforces this too.)
  if (userId && userId.startsWith("radio-np:")) return;
  try {
    const path =
      mode === "session" ? `/api/session/${guildId}/viewer` : "/api/me";
    const r = await api<{ viewer: ViewerProfile | null }>("GET", path);
    viewer.value = r.viewer ?? null;
  } catch {
    // leave the chip off
  }
}

async function bootstrap(): Promise<void> {
  // Mode is decided by PATH, not token caps: the bot admin UI links to
  // `<base>/manage` (exchange → access/refresh pair); `/radio me` links to
  // `<base>/me` (direct guildless bearer); play/queue buttons link to
  // `<base>/` (direct session bearer). Path is stable across tab reloads,
  // so the manage SPA resumes its refresh pair without re-inspecting any
  // token.
  const path = window.location.pathname.replace(/\/+$/, "");
  const wantsExchange = path.endsWith("/manage");
  const wantsPersonal = path.endsWith("/me");

  const handle = await bootstrapPluginSession({
    pluginKey: PLUGIN_KEY,
    exchangeJwt: wantsExchange,
    onAccessDenied: (msg) =>
      deny(msg || "Access denied — re-open the link / ask an admin."),
  });
  setApi(handle.api);

  if (handle.denied) {
    if (view.value !== "denied") {
      deny(handle.deniedReason ?? "Access denied — re-open the link / ask an admin.");
    }
    return;
  }

  if (!handle.isAuthenticated) {
    deny("No valid token. Run /radio manage or use a play/queue response button.");
    return;
  }

  // Personal tier (`/me`) — authenticated purely by the real userId, so any
  // real-user token works: guildless (`/radio me`) OR guild-scoped (a
  // `/radio np|play` link, incl. the one "Open player" swaps in). That's
  // what lets /me and the player page share one login. Only the synthetic
  // public now-playing user is barred (backend enforces this too).
  if (wantsPersonal) {
    if (handle.claims?.userId?.startsWith("radio-np:")) {
      deny("This link isn't valid for a personal page.");
      return;
    }
    view.value = "personal";
    void loadViewer("personal", null, handle.claims?.userId);
    return;
  }

  // Tab reload — SDK restored auth from sessionStorage but has no
  // decoded claims for us. Manage tier resumes cleanly; session tier
  // needs the guildId that lived in the original claims, so re-prompt.
  if (!handle.claims) {
    if (handle.hasRefreshPair) {
      view.value = "manage";
      return;
    }
    deny("Tab reload lost the session token claims — re-run /radio.");
    return;
  }

  if (wantsExchange) {
    view.value = "manage";
    return;
  }

  // Session tier — pull the guildId from the freshly-decoded claims so
  // SessionView can scope its requests.
  if (typeof handle.claims.guildId === "string") {
    sessionGuildId.value = handle.claims.guildId;
    view.value = "session";
    void loadViewer("session", handle.claims.guildId, handle.claims.userId);
    return;
  }
  deny("This link doesn't grant access to a playback session.");
}

void bootstrap();

const modeLabel = computed(() => {
  if (view.value === "session") return "playback session";
  if (view.value === "manage") return "admin · library";
  if (view.value === "personal") return "personal";
  return "";
});

// The identity chip links to the personal page. No ?token= needed: /me
// accepts the current real-user token from sessionStorage (guild-scoped or
// not), so navigating same-tab keeps the same login.
const meUrl = computed(() => (window.__PLUGIN_BASE__ ?? "") + "/me");
</script>

<template>
  <div class="app-wrap" :class="{ 'app-wrap--locked': view === 'session' }">
    <header class="app-header">
      <h1>📻 Karyl Radio</h1>
      <span class="mode">{{ modeLabel }}</span>
      <component
        :is="view !== 'personal' ? 'a' : 'div'"
        v-if="viewer"
        class="viewer"
        :class="{ 'viewer--link': view !== 'personal' }"
        :href="view !== 'personal' ? meUrl : undefined"
        :title="
          view !== 'personal'
            ? `${viewer.displayName} — open your personal page`
            : viewer.displayName
        "
      >
        <UserAvatar
          :src="viewer.avatarUrl"
          :name="viewer.displayName"
          :size="26"
          animate="hover"
        />
        <span class="viewer-name">{{ viewer.displayName }}</span>
      </component>
    </header>

    <div v-if="view === 'loading'" class="center-msg">Connecting…</div>
    <DeniedView
      v-else-if="view === 'denied'"
      :message="deniedMessage || 'Access denied'"
    />
    <SessionView
      v-else-if="view === 'session' && sessionGuildId"
      :guild-id="sessionGuildId"
    />
    <ManageView v-else-if="view === 'manage'" />
    <PersonalView v-else-if="view === 'personal'" />

    <AppToast />
  </div>
</template>

<style scoped>
/* Top-right "logged-in as" chip. margin-left:auto pushes it to the end of
   the flex header; align-self:center overrides the header's baseline. */
.viewer {
  margin-left: auto;
  align-self: center;
  display: inline-flex;
  align-items: center;
  gap: 0.4rem;
  min-width: 0;
}
.viewer--link {
  text-decoration: none;
  color: inherit;
  cursor: pointer;
  border-radius: var(--radius-pill, 999px);
  padding: 0.15rem 0.45rem 0.15rem 0.15rem;
  transition: background var(--transition-fast, 0.12s);
}
.viewer--link:hover { background: var(--bg-surface-2); }
.viewer--link:focus-visible {
  outline: 2px solid var(--accent, #5865f2);
  outline-offset: 2px;
}
.viewer-name {
  font-size: 0.85rem;
  font-weight: 550;
  color: var(--text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  max-width: 12rem;
}
</style>
