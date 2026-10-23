import { createSignal, onCleanup } from "solid-js";

export const zh = {
  "skills.title": "Skill 配置",
  "skills.empty": "暂无技能",
  "skills.emptyHint": "点击下方添加技能",
  "skills.sourcePlugin": "插件内置",
  "skills.sourceRemote": "远程索引",
  "skills.enabled": "已启用",
  "skills.disabled": "已停用",
  "skills.enable": "启用",
  "skills.disable": "停用",
  "skills.delete": "删除",
  "skills.sourcePlaceholder": "技能 URL 或本地路径",
  "skills.cancel": "取消",
  "skills.add": "添加",
  "skills.submitting": "提交中…",
  "skills.addSkill": "添加技能",
  "skills.installSubmitted": "已提交安装，技能安装完成后会自动刷新列表",
  "skills.installFailed": "安装失败：{error}",
  "skills.toggleFailed": "{name} 切换失败：{error}",
  "skills.removed": "已删除 {name}",
  "skills.removeFailed": "{name} 删除失败：{error}",
} satisfies Record<string, string>;

export type SkillsLocaleKey = keyof typeof zh;

export const en: Record<SkillsLocaleKey, string> = {
  "skills.title": "Skills Configuration",
  "skills.empty": "No skills",
  "skills.emptyHint": "Click below to add a skill",
  "skills.sourcePlugin": "Built-in",
  "skills.sourceRemote": "Remote",
  "skills.enabled": "Enabled",
  "skills.disabled": "Disabled",
  "skills.enable": "Enable",
  "skills.disable": "Disable",
  "skills.delete": "Remove",
  "skills.sourcePlaceholder": "Skill URL or local path",
  "skills.cancel": "Cancel",
  "skills.add": "Add",
  "skills.submitting": "Submitting…",
  "skills.addSkill": "Add Skill",
  "skills.installSubmitted":
    "Install submitted; the list refreshes once installation finishes",
  "skills.installFailed": "Install failed: {error}",
  "skills.toggleFailed": "{name} toggle failed: {error}",
  "skills.removed": "Removed {name}",
  "skills.removeFailed": "{name} remove failed: {error}",
};

export const SKILLS_LOCALES: Record<string, Record<string, string>> = {
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

export function bindSkillsLocale(extra?: unknown) {
  const hostLocale = (extra as { locale?: HostLocaleLike } | undefined)?.locale;
  if (hostLocale?.ensureRegistered) {
    hostLocale.ensureRegistered("skills", SKILLS_LOCALES);
  } else if (hostLocale?.register) {
    try {
      hostLocale.register("skills", SKILLS_LOCALES);
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
  const bound = hostLocale?.bind?.("skills");
  return (key: SkillsLocaleKey, params?: Record<string, unknown>): string => {
    tick();
    if (bound) return bound(key, params);
    const active =
      hostLocale?.getLocale?.().active ??
      (typeof document !== "undefined" && document.documentElement.lang === "en"
        ? "en"
        : "zh-CN");
    const dict = SKILLS_LOCALES[active] ?? zh;
    const template = dict[key] ?? zh[key] ?? key;
    if (!params) return template;
    return template.replace(/\{(\w+)\}/gu, (m, name: string) =>
      name in params ? String(params[name]) : m,
    );
  };
}
