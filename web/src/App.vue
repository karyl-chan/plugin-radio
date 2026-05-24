<script setup lang="ts">
import { computed, ref } from "vue";
import AppToast from "./components/AppToast.vue";
import DeniedView from "./views/DeniedView.vue";
import ManageView from "./views/ManageView.vue";
import SessionView from "./views/SessionView.vue";
import {
  decodeJwt,
  exchangeManageJwt,
  getStoredSessionToken,
  loadStoredAuth,
  onAccessDenied,
  readTokenFromUrl,
  setManageTokens,
  setSessionToken,
} from "./api";

const PLUGIN_KEY = "karyl-radio";

type View = "loading" | "denied" | "session" | "manage";
const view = ref<View>("loading");
const deniedMessage = ref<string | null>(null);
// When the SPA boots into session mode, the JWT we read from the URL
// (or sessionStorage) carries the guildId — we still need it for the
// session view's `:guild-id` prop. Manage mode doesn't keep claims
// around: the plugin's access token is opaque to the SPA.
const sessionGuildId = ref<string | null>(null);

onAccessDenied((msg) => {
  deniedMessage.value = msg || "Access denied — re-open the link / ask an admin.";
  view.value = "denied";
});

function isManageClaims(claims: { capabilities?: unknown } | null): boolean {
  const caps = Array.isArray(claims?.capabilities)
    ? (claims!.capabilities as string[])
    : [];
  return (
    caps.includes("admin") || caps.includes(`plugin:${PLUGIN_KEY}:manage`)
  );
}

async function bootstrap(): Promise<void> {
  const urlToken = readTokenFromUrl();
  if (urlToken) {
    const claims = decodeJwt(urlToken);
    if (!claims) {
      deniedMessage.value = "Token couldn't be decoded.";
      view.value = "denied";
      return;
    }
    // Session: guildId-scoped JWT, used as-is for every /api/session/*
    // call until it expires. No exchange step.
    if (typeof claims.guildId === "string") {
      setSessionToken(urlToken);
      sessionGuildId.value = claims.guildId;
      view.value = "session";
      return;
    }
    // Manage: trade the bot JWT for a plugin access+refresh pair. The
    // bot JWT then disappears (not stored anywhere).
    if (isManageClaims(claims)) {
      const tokens = await exchangeManageJwt(urlToken);
      if (!tokens) {
        deniedMessage.value =
          "Couldn't start a manage session — your link may have expired. Re-run /radio manage.";
        view.value = "denied";
        return;
      }
      setManageTokens(tokens);
      view.value = "manage";
      return;
    }
    deniedMessage.value = "This link doesn't grant access to the admin panel.";
    view.value = "denied";
    return;
  }
  // No URL token: maybe this is a tab reload — restore from storage.
  const stored = loadStoredAuth();
  if (stored === "manage") {
    view.value = "manage";
    return;
  }
  if (stored === "session") {
    const raw = getStoredSessionToken();
    const claims = raw ? decodeJwt(raw) : null;
    if (claims && typeof claims.guildId === "string") {
      sessionGuildId.value = claims.guildId;
      view.value = "session";
      return;
    }
  }
  deniedMessage.value =
    "No valid token. Run /radio manage or use a play/queue response button.";
  view.value = "denied";
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
