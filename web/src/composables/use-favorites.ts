import { computed, ref } from "vue";
import { api } from "../api";
import { useToast } from "./use-toast";
import type { UserFavorite } from "../types";

/**
 * Per-user favorites, shared by the player page (the ☆ toggle on queue rows
 * + the add-to-queue autocomplete) and the /me favorites tab. `source` is
 * the WebUI's per-item key (`track.trackId ?? track.sourceUrl`), so
 * membership in `sourceSet` is exactly what drives the filled/empty ☆.
 *
 * Every consumer gets its own instance (its own list state), loaded on
 * demand — the pattern mirrors use-api-keys.
 */
export function useFavorites() {
  const { ok, error } = useToast();
  const favorites = ref<UserFavorite[]>([]);
  const sourceSet = computed(
    () => new Set(favorites.value.map((f) => f.source)),
  );

  async function load(): Promise<void> {
    try {
      const r = await api<{ favorites: UserFavorite[] }>(
        "GET",
        "/api/me/favorites",
      );
      favorites.value = r.favorites || [];
    } catch (e: any) {
      error(e.message);
    }
  }

  /** Star/unstar a source. Reconciles the local list from the server's
   *  resulting {starred, favorite} so the ☆ state flips immediately. */
  async function toggle(
    source: string,
    label?: string,
    coverUrl?: string,
  ): Promise<void> {
    if (!source) return;
    try {
      const r = await api<{ starred: boolean; favorite?: UserFavorite }>(
        "POST",
        "/api/me/favorites/toggle",
        { source, label, coverUrl },
      );
      if (r.starred && r.favorite) {
        favorites.value = [
          r.favorite,
          ...favorites.value.filter((f) => f.source !== source),
        ];
        ok("Added to favorites");
      } else {
        favorites.value = favorites.value.filter((f) => f.source !== source);
        ok("Removed from favorites");
      }
    } catch (e: any) {
      error(e.message);
    }
  }

  async function remove(id: string): Promise<void> {
    try {
      await api("DELETE", "/api/me/favorites/" + encodeURIComponent(id));
      favorites.value = favorites.value.filter((f) => f.id !== id);
      ok("Removed from favorites");
    } catch (e: any) {
      error(e.message);
    }
  }

  return { favorites, sourceSet, load, toggle, remove };
}
