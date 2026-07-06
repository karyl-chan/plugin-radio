import { ref } from "vue";

/**
 * Tracks in-flight async actions by key, for per-button transition states.
 * `run(key, fn)` marks `key` busy for the duration of `fn` (clearing it even
 * if `fn` throws); `isBusy(key)` / the reactive `busyKeys` set drive a
 * button's `:loading`. Concurrent actions with distinct keys stay
 * independent, so two rows can each spin without blocking the other.
 *
 * A fresh Set is assigned on every mutation so Vue's reactivity fires (an
 * in-place `add`/`delete` on a `ref<Set>` wouldn't trigger dependents).
 */
export function useBusy() {
  const busyKeys = ref<Set<string>>(new Set());

  function isBusy(key: string): boolean {
    return busyKeys.value.has(key);
  }

  async function run<T>(key: string, fn: () => Promise<T>): Promise<T> {
    const on = new Set(busyKeys.value);
    on.add(key);
    busyKeys.value = on;
    try {
      return await fn();
    } finally {
      const off = new Set(busyKeys.value);
      off.delete(key);
      busyKeys.value = off;
    }
  }

  return { busyKeys, isBusy, run };
}
