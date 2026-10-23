import { createSignal, onCleanup } from "solid-js";

export const zh = {
  "terminal.selectSession": "选择一个会话以打开交互式终端",
  "terminal.ownerHuman": "人工控制",
  "terminal.ownerModel": "模型控制",
  "terminal.takeover": "接管",
  "terminal.takeoverTitle": "接管终端",
  "terminal.release": "交还模型",
  "terminal.releaseTitle": "交还模型控制",
  "terminal.secureStart": "安全输入",
  "terminal.secureStartTitle": "开始安全输入",
  "terminal.secureEnd": "结束安全输入",
  "terminal.secureEndTitle": "结束安全输入",
  "terminal.searchPlaceholder": "搜索终端",
  "terminal.nextMatch": "下一个匹配",
  "terminal.prevMatch": "上一个匹配",
  "terminal.refresh": "刷新",
  "terminal.refreshTitle": "刷新/重连当前终端",
  "terminal.clear": "清空",
  "terminal.copy": "复制",
  "terminal.paste": "粘贴",
  "terminal.zoomOut": "缩小字体",
  "terminal.zoomIn": "放大字体",
  "terminal.splitVertical": "分屏↕",
  "terminal.splitVerticalTitle": "纵向分屏",
  "terminal.splitHorizontal": "分屏↔",
  "terminal.splitHorizontalTitle": "横向分屏",
  "terminal.tabTitle": "终端 {n}",
  "terminal.closeTab": "关闭 {title}",
  "terminal.newTab": "新建终端",
  "terminal.limitError": "每个会话最多 {max} 个终端",
} satisfies Record<string, string>;

export type TerminalLocaleKey = keyof typeof zh;

export const en: Record<TerminalLocaleKey, string> = {
  "terminal.selectSession": "Select a session to open an interactive terminal",
  "terminal.ownerHuman": "Human control",
  "terminal.ownerModel": "Model control",
  "terminal.takeover": "Take over",
  "terminal.takeoverTitle": "Take over terminal",
  "terminal.release": "Return to model",
  "terminal.releaseTitle": "Return control to model",
  "terminal.secureStart": "Secure input",
  "terminal.secureStartTitle": "Start secure input",
  "terminal.secureEnd": "End secure input",
  "terminal.secureEndTitle": "End secure input",
  "terminal.searchPlaceholder": "Search terminal",
  "terminal.nextMatch": "Next match",
  "terminal.prevMatch": "Previous match",
  "terminal.refresh": "Refresh",
  "terminal.refreshTitle": "Refresh / reconnect terminal",
  "terminal.clear": "Clear",
  "terminal.copy": "Copy",
  "terminal.paste": "Paste",
  "terminal.zoomOut": "Zoom out",
  "terminal.zoomIn": "Zoom in",
  "terminal.splitVertical": "Split ↕",
  "terminal.splitVerticalTitle": "Split vertically",
  "terminal.splitHorizontal": "Split ↔",
  "terminal.splitHorizontalTitle": "Split horizontally",
  "terminal.tabTitle": "Terminal {n}",
  "terminal.closeTab": "Close {title}",
  "terminal.newTab": "New terminal",
  "terminal.limitError": "Up to {max} terminals per session",
};

export const TERMINAL_LOCALES: Record<string, Record<string, string>> = {
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

export function bindTerminalLocale(extra?: unknown) {
  const hostLocale = (extra as { locale?: HostLocaleLike } | undefined)?.locale;
  if (hostLocale?.ensureRegistered) {
    hostLocale.ensureRegistered("terminal", TERMINAL_LOCALES);
  } else if (hostLocale?.register) {
    try {
      hostLocale.register("terminal", TERMINAL_LOCALES);
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
  const bound = hostLocale?.bind?.("terminal");
  return (key: TerminalLocaleKey, params?: Record<string, unknown>): string => {
    tick();
    if (bound) return bound(key, params);
    const active =
      hostLocale?.getLocale?.().active ??
      (typeof document !== "undefined" && document.documentElement.lang === "en"
        ? "en"
        : "zh-CN");
    const dict = TERMINAL_LOCALES[active] ?? zh;
    const template = dict[key] ?? zh[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/gu, (m, name: string) =>
      name in params ? String(params[name]) : m,
    );
  };
}
