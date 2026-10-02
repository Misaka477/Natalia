import type { RuntimeEvent } from "@anthelia/contracts";
import type { UiEventBus, UiEventPattern } from "./protocol";

export function eventMatches(
  type: string,
  patterns: readonly UiEventPattern[] | undefined,
): boolean {
  if (!patterns || patterns.length === 0) return true;
  return patterns.some((pattern) => matchPattern(type, pattern));
}

function matchPattern(type: string, pattern: string): boolean {
  if (pattern === "*" || pattern === "runtime.*") return true;
  const normalized = pattern.startsWith("runtime.")
    ? pattern.slice("runtime.".length)
    : pattern;
  if (normalized === "*" || normalized === "") return true;
  if (normalized.endsWith(".*")) {
    const prefix = normalized.slice(0, -1);
    const exact = normalized.slice(0, -2);
    return type === exact || type.startsWith(prefix);
  }
  return type === pattern || type === normalized;
}

export function createUiEventBus(): UiEventBus {
  const listeners = new Set<{
    listener: (event: RuntimeEvent) => void;
    filter?: readonly UiEventPattern[];
  }>();
  return {
    emit(event) {
      for (const entry of listeners)
        if (eventMatches(event.type, entry.filter)) entry.listener(event);
    },
    subscribe(listener, filter) {
      const entry = { listener, filter };
      listeners.add(entry);
      return () => {
        listeners.delete(entry);
      };
    },
  };
}
