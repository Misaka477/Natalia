/**
 * Host-input bindings — runtime/plugin-input-bindings.ts.
 *
 * The framework's host inputs (skills, MCP, local tools, the terminal, the
 * composition profile) are rebuilt from the resolved config on every config
 * reload. They used to be rebound as a dispose-then-provide pair, and the
 * disposer made the service briefly ABSENT: the plugin registry reads that as a
 * missing requirement and deactivates every plugin that requires it — killing
 * the terminal controller's panes along with them — before the provide brings
 * them back. A settings write, a model selection, a permission switch or the
 * provider check a turn runs before it starts therefore reloaded the whole
 * host-input plugin set for a reload in which nothing the plugins observe had
 * changed (the 2026-10-13 terminal-reload defect).
 *
 * A binding is now replaced only when the built input actually differs, and it
 * is replaced by a fresh provide, never by an absence. The inputs are data plus
 * live read faces: two builds over the same config close over the same runtime
 * ports and the same captured data, so functions are compared as equal and only
 * the data decides (`sameInputData`). Nothing a plugin can observe changed ⇒
 * nothing is rebound ⇒ no plugin is re-armed.
 */
import type { ServiceDirectory, ServiceToken } from "@anthelia/runtime-services";

/**
 * Whether two builds of one host input are interchangeable.
 *
 * Data is compared structurally; functions are the input's live read faces and
 * are treated as equal whenever both sides have one. A value this function
 * cannot compare (a class instance, a Map, a Date) is reported as CHANGED, so
 * the fallback is the conservative rebind rather than a stale binding.
 */
export function sameInputData(left: unknown, right: unknown): boolean {
  if (Object.is(left, right)) return true;
  if (typeof left === "function" || typeof right === "function")
    return typeof left === "function" && typeof right === "function";
  if (left === null || right === null) return false;
  if (typeof left !== "object" || typeof right !== "object") return false;
  if (Array.isArray(left) || Array.isArray(right)) {
    if (!Array.isArray(left) || !Array.isArray(right)) return false;
    if (left.length !== right.length) return false;
    return left.every((entry, index) => sameInputData(entry, right[index]));
  }
  const leftPrototype = Object.getPrototypeOf(left) as unknown;
  // Only plain records are compared key-wise; anything richer carries behaviour
  // this comparison cannot see, so it counts as changed.
  if (leftPrototype !== Object.getPrototypeOf(right)) return false;
  if (leftPrototype !== Object.prototype && leftPrototype !== null) return false;
  const leftRecord = left as Record<string, unknown>;
  const rightRecord = right as Record<string, unknown>;
  const leftKeys = Object.keys(leftRecord);
  if (leftKeys.length !== Object.keys(rightRecord).length) return false;
  return leftKeys.every(
    (key) =>
      Object.prototype.hasOwnProperty.call(rightRecord, key) &&
      sameInputData(leftRecord[key], rightRecord[key]),
  );
}

export type PluginInputBindings = {
  /**
   * Binds `value` to `token`, or — when the binding already carries an
   * equivalent value — leaves the existing one in place. Answers whether the
   * directory was touched, which is what decides whether the plugins
   * requiring the token are reconciled.
   */
  rebind<T>(token: ServiceToken<T>, value: T | undefined): boolean;
  /** Releases every binding (runtime shutdown). */
  disposeAll(): void;
  /** The token ids currently bound, in binding order. */
  boundIDs(): string[];
};

export function createPluginInputBindings(
  directory: Pick<ServiceDirectory, "provide">,
): PluginInputBindings {
  const bound = new Map<
    string,
    { value: unknown; dispose: () => void }
  >();
  return {
    rebind<T>(token: ServiceToken<T>, value: T | undefined): boolean {
      const current = bound.get(token.id);
      if (value === undefined) {
        if (!current) return false;
        current.dispose();
        bound.delete(token.id);
        return true;
      }
      if (current && sameInputData(current.value, value)) return false;
      current?.dispose();
      bound.set(token.id, {
        value,
        dispose: directory.provide(token, value),
      });
      return true;
    },
    disposeAll() {
      for (const entry of [...bound.values()].reverse()) entry.dispose();
      bound.clear();
    },
    boundIDs: () => [...bound.keys()],
  };
}
