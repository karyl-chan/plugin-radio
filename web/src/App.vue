<script setup lang="ts">
import { computed, ref } from "vue";
import { bootstrapPluginSession } from "@karyl-chan/plugin-sdk/web";
import { AppToast } from "@karyl-chan/ui";
import DeniedView from "./views/DeniedView.vue";
import ManageView from "./views/ManageView.vue";
import SessionView from "./views/SessionView.vue";
import { setApi } from "./api";

const PLUGIN_KEY = "karyl-radio";

type View = "loading" | "denied" | "session" | "manage";
const view = ref<View>("loading");
const deniedMessage = ref<string | null>(null);
// When the SPA boots into session mode, the JWT we read from the URL
// (or sessionStorage) carries the guildId — we still need it for the
// session view's `:guild-id` prop. Manage mode doesn't keep claims
// around: the plugin's access token is opaque to the SPA.
const sessionGuildId = ref<string | null>(null);

function deny(msg: string): void {
  deniedMessage.value = msg;
  view.value = "denied";
}

async function bootstrap(): Promise<void> {
  // Mode is decided by PATH, not token caps: the bot admin UI links to
  // `<base>/manage` (exchange → access/refresh pair); play/queue buttons
  // link to `<base>/` (direct session bearer). Path is stable across tab
  // reloads, so the manage SPA resumes its refresh pair without
  // re-inspecting any token.
  const wantsExchange = window.location.pathname
    .replace(/\/+$/, "")
    .endsWith("/manage");

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
    return;
  }
  deny("This link doesn't grant access to a playback session.");
}

void bootstrap();

const modeLabel = computed(() => {
  if (view.value === "session") return "playback session";
  if (view.value === "manage") return "admin · library";
  return "";
});
</script>

<template>
  <div class="app-wrap" :class="{ 'app-wrap--locked': view === 'session' }">
    <header class="app-header">
      <h1>📻 Karyl Radio</h1>
      <span class="mode">{{ modeLabel }}</span>
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

    <AppToast />
  </div>
</template>
