import { createSignal, onCleanup } from "solid-js";

export const zh = {
  "todo.title": "任务",
  "todo.progress.done": "{done} 已完成",
  "todo.progress.active": "{active} 进行中",
  "todo.progress.pending": "{pending} 待处理",
  "todo.pending": "{count} 待处理",
  "todo.done": "{done}/{total} 完成",
  "todo.inProgress": "进行中",
  "todo.pendingStatus": "待处理",
  "todo.completedHeader": "已完成（{count}）",
} satisfies Record<string, string>;

export type TodoLocaleKey = keyof typeof zh;

export const en: Record<TodoLocaleKey, string> = {
  "todo.title": "Tasks",
  "todo.progress.done": "{done} done",
  "todo.progress.active": "{active} in progress",
  "todo.progress.pending": "{pending} pending",
  "todo.pending": "{count} pending",
  "todo.done": "{done}/{total} done",
  "todo.inProgress": "in progress",
  "todo.pendingStatus": "pending",
  "todo.completedHeader": "Completed ({count})",
};

export const TODO_LOCALES: Record<string, Record<string, string>> = {
  "zh-CN": zh,
  en,
};

interface HostLocaleLike {
  getLocale?: () => { active: string };
  subscribe?: (listener: () => void) => () => void;
  ensureRegistered?: (
    ns: string,
    dicts: Record<string, Record<string, string>>,
  ) => void;
  register?: (
    ns: string,
    dicts: Record<string, Record<string, string>>,
  ) => () => void;
  bind?: (
    ns: string,
  ) => (key: string, params?: Record<string, unknown>) => string;
}

export function bindTodoLocale(extra?: unknown) {
  const hostLocale = (extra as { locale?: HostLocaleLike } | undefined)?.locale;
  if (hostLocale?.ensureRegistered) {
    hostLocale.ensureRegistered("todo", TODO_LOCALES);
  } else if (hostLocale?.register) {
    try {
      hostLocale.register("todo", TODO_LOCALES);
    } catch {
      // already registered
    }
  }
  const [tick, setTick] = createSignal(0);
  if (hostLocale?.subscribe) {
    const off = hostLocale.subscribe(() => setTick((n) => n + 1));
    onCleanup(off);
  }
  if (typeof window !== "undefined") {
    const onEvent = () => setTick((n) => n + 1);
    window.addEventListener("natalia:locale-change", onEvent);
    onCleanup(() =>
      window.removeEventListener("natalia:locale-change", onEvent),
    );
  }
  const bound = hostLocale?.bind?.("todo");
  return (key: string, params?: Record<string, unknown>): string => {
    tick();
    if (bound) return bound(key, params);
    const active =
      hostLocale?.getLocale?.().active ??
      (typeof document !== "undefined" && document.documentElement.lang === "en"
        ? "en"
        : "zh-CN");
    const dict = TODO_LOCALES[active] ?? zh;
    const template = dict[key] ?? (zh as Record<string, string>)[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/gu, (m, name: string) =>
      name in params ? String(params[name]) : m,
    );
  };
}
