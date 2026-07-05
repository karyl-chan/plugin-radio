import { ref } from "vue";
import { api } from "../api";
import { useToast } from "./use-toast";
import type { ApiKey } from "../types";

/**
 * External-control API key management, shared by the manager library page
 * (ManageView) and the personal page (PersonalView). The two differ only in
 * the route prefix (`/api/keys` vs `/api/me/keys`) — everything else (the
 * one-time-plaintext reveal, the revoke confirm, the last-used formatting)
 * is identical, so it lives here rather than being copied per view.
 */
export function useApiKeys(baseUrl: string) {
  const { ok, error } = useToast();

  const apiKeys = ref<ApiKey[]>([]);
  const newKeyLabel = ref("");
  const creatingKey = ref(false);
  // One-time plaintext returned by a create call — shown in a reveal banner
  // until dismissed, since it's unrecoverable afterwards.
  const freshKey = ref<string | null>(null);

  async function loadKeys(): Promise<void> {
    try {
      const r = await api<{ keys: ApiKey[] }>("GET", baseUrl);
      apiKeys.value = r.keys || [];
    } catch (e: any) {
      error(e.message);
    }
  }

  async function createKey(): Promise<void> {
    creatingKey.value = true;
    try {
      const r = await api<{ key: ApiKey; plaintext: string }>("POST", baseUrl, {
        label: newKeyLabel.value.trim() || undefined,
      });
      freshKey.value = r.plaintext;
      newKeyLabel.value = "";
      ok("API key created — copy it now");
      await loadKeys();
    } catch (e: any) {
      error(e.message);
    } finally {
      creatingKey.value = false;
    }
  }

  async function revokeKey(k: ApiKey): Promise<void> {
    if (
      !confirm(`Revoke API key "${k.label || k.id}"? Integrations using it stop working.`)
    )
      return;
    try {
      await api("DELETE", `${baseUrl}/${encodeURIComponent(k.id)}`);
      ok("Revoked");
      await loadKeys();
    } catch (e: any) {
      error(e.message);
    }
  }

  async function copyFreshKey(): Promise<void> {
    if (!freshKey.value) return;
    try {
      await navigator.clipboard.writeText(freshKey.value);
      ok("Copied to clipboard");
    } catch {
      error("Couldn't copy — select and copy manually");
    }
  }

  function keySubText(k: ApiKey): string {
    const used = k.lastUsedAt
      ? `last used ${new Date(k.lastUsedAt).toLocaleString()}`
      : "never used";
    return `${k.scopes.join(", ")} · ${used}`;
  }

  return {
    apiKeys,
    newKeyLabel,
    creatingKey,
    freshKey,
    loadKeys,
    createKey,
    revokeKey,
    copyFreshKey,
    keySubText,
  };
}
