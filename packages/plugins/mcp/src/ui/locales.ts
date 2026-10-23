import { createSignal, onCleanup } from "solid-js";

export const zh = {
  "mcp.title": "MCP 配置",
  "mcp.empty": "暂无 MCP 服务器",
  "mcp.emptyHint": "点击下方添加 MCP",
  "mcp.connected": "已连接",
  "mcp.disconnected": "未连接",
  "mcp.delete": "删除",
  "mcp.namePlaceholder": "名称（例如 my-mcp）",
  "mcp.urlPlaceholder": "MCP URL（例如 https://example.com/mcp）",
  "mcp.commandPlaceholder": "command（例如 npx）",
  "mcp.argsPlaceholder": "args（空格分隔）",
  "mcp.cancel": "取消",
  "mcp.add": "添加",
  "mcp.addServer": "添加 MCP",
} satisfies Record<string, string>;

export type McpLocaleKey = keyof typeof zh;

export const en: Record<McpLocaleKey, string> = {
  "mcp.title": "MCP Configuration",
  "mcp.empty": "No MCP servers",
  "mcp.emptyHint": "Click below to add an MCP server",
  "mcp.connected": "Connected",
  "mcp.disconnected": "Disconnected",
  "mcp.delete": "Remove",
  "mcp.namePlaceholder": "Name (e.g. my-mcp)",
  "mcp.urlPlaceholder": "MCP URL (e.g. https://example.com/mcp)",
  "mcp.commandPlaceholder": "command (e.g. npx)",
  "mcp.argsPlaceholder": "args (space-separated)",
  "mcp.cancel": "Cancel",
  "mcp.add": "Add",
  "mcp.addServer": "Add MCP",
};

export const MCP_LOCALES: Record<string, Record<string, string>> = {
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

export function bindMcpLocale(extra?: unknown) {
  const hostLocale = (extra as { locale?: HostLocaleLike } | undefined)?.locale;
  if (hostLocale?.ensureRegistered) {
    hostLocale.ensureRegistered("mcp", MCP_LOCALES);
  } else if (hostLocale?.register) {
    try {
      hostLocale.register("mcp", MCP_LOCALES);
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
  const bound = hostLocale?.bind?.("mcp");
  return (key: McpLocaleKey, params?: Record<string, unknown>): string => {
    tick();
    if (bound) return bound(key, params);
    const active =
      hostLocale?.getLocale?.().active ??
      (typeof document !== "undefined" && document.documentElement.lang === "en"
        ? "en"
        : "zh-CN");
    const dict = MCP_LOCALES[active] ?? zh;
    const template = dict[key] ?? zh[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/gu, (m, name: string) =>
      name in params ? String(params[name]) : m,
    );
  };
}
