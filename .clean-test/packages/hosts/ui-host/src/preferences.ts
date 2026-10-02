import type { PreferenceStore } from "./protocol";

export function createMemoryPreferenceStore(
  initial: Record<string, unknown> = {},
): PreferenceStore {
  const values = new Map<string, unknown>(Object.entries(initial));
  const listeners = new Set<(key: string, value: unknown) => void>();
  return {
    get(key) {
      return values.get(key) as never;
    },
    set(key, value) {
      values.set(key, value);
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
