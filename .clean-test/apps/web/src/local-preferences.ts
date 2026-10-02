import type { PreferenceStore } from "@natalia/ui-host";

/**
 * Persists UI preferences in localStorage so theme and other UI settings
 * survive page reloads and dev-server restarts.
 */
export function createLocalPreferenceStore(
  prefix = "natalia:ui:",
): PreferenceStore {
  const values = new Map<string, unknown>();
  const listeners = new Set<(key: string, value: unknown) => void>();

  function readAll() {
    if (typeof localStorage === "undefined") return;
    for (let index = 0; index < localStorage.length; index++) {
      const key = localStorage.key(index);
      if (!key?.startsWith(prefix)) continue;
      const raw = localStorage.getItem(key);
      if (raw === null) continue;
      try {
        values.set(key.slice(prefix.length), JSON.parse(raw));
      } catch {
        // Ignore malformed stored values.
      }
    }
  }
  readAll();

  return {
    get(key) {
      if (values.has(key)) return values.get(key) as never;
      if (typeof localStorage === "undefined") return undefined;
      const raw = localStorage.getItem(prefix + key);
      if (raw === null) return undefined;
      try {
        const value = JSON.parse(raw);
        values.set(key, value);
        return value as never;
      } catch {
        return undefined;
      }
    },
    set(key, value) {
      values.set(key, value);
      if (typeof localStorage !== "undefined") {
        localStorage.setItem(prefix + key, JSON.stringify(value));
      }
      for (const listener of listeners) listener(key, value);
    },
    subscribe(listener) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
  };
}
