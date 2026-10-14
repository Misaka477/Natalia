/**
 * The settings panel's row definitions: ONE label, ONE behaviour, in one
 * place.
 *
 * This file exists because the panel used to carry the same knowledge
 * twice over, each in its own shape:
 *
 *   1. `categories` in settings-panel.tsx — a hand-written list of rows,
 *      complete with a `value` field that was FABRICATED. A fresh install
 *      with no config rendered "Opus 4" as its default model, "3" for a
 *      concurrency whose real default is 4, and "2 个" for checkpoint dirs
 *      that are empty — all indistinguishable from real settings until the
 *      runtime's own answer arrived.
 *   2. `runtimeValue(label)` — a switch on the label string that reads the
 *      real config.
 *
 * Two copies of one label is how a rename silently kills a row's
 * behaviour, and it is how fabricated values outlived the config that was
 * supposed to replace them. A row's label is now declared once, here, and
 * the row list is derived from these specs; the interactive rows still
 * match on the label where an action is wired, which is why a label edit
 * has exactly two places to touch, both in this package.
 *
 * The value rule, which is the whole point: a row's value comes from the
 * runtime's config, the preference store, or nowhere. When it has no
 * answer it renders UNSET_VALUE_LABEL. It never invents one. A default
 * that IS real (the schema's own `.default(...)`) is shown, because that
 * is what the system will actually do.
 */

/** The category a row lives in. Order here is the order rendered. */
export type SettingsCategoryId =
  | "model"
  | "security"
  | "runtime"
  | "interface"
  | "storage"
  | "system";

export type SettingsCategorySpec = {
  id: SettingsCategoryId;
  label: string;
};

export const SETTINGS_CATEGORIES: readonly SettingsCategorySpec[] = [
  { id: "model", label: "模型与 Agent" },
  { id: "security", label: "权限与安全" },
  { id: "runtime", label: "运行时与上下文" },
  { id: "interface", label: "界面" },
  { id: "storage", label: "配置保存范围" },
  { id: "system", label: "系统" },
];

export type SettingsRowSpec = {
  /** The row's label. It is declared here and in the panel's render. */
  label: string;
  description: string;
  category: SettingsCategoryId;
};

/**
 * Every row the settings panel can show.
 *
 * A row's PRESENCE here does not mean it is shown: host-only rows are
 * filtered by settings-host-rows.ts against the runtime's own host segment,
 * and rows whose backing store is absent render as UNSET_VALUE_LABEL rather
 * than disappearing. The list is the panel's whole vocabulary.
 */
export const SETTINGS_ROWS: readonly SettingsRowSpec[] = [
  // --- 模型与 Agent -----------------------------------------------------
  {
    label: "Providers & Models",
    description: "配置 provider 并导入模型",
    category: "model",
  },
  {
    label: "Default Model",
    description: "默认使用的模型",
    category: "model",
  },
  {
    label: "子 Agent 并发数",
    description: "团队子 agent 最大并发数",
    category: "model",
  },
  // --- 权限与安全 -------------------------------------------------------
  {
    label: "Permission Profile",
    description: "选择、新增、编辑权限配置",
    category: "security",
  },
  // --- 运行时与上下文 ---------------------------------------------------
  {
    label: "Max Steps",
    description: "单轮最大执行步数",
    category: "runtime",
  },
  {
    label: "Max Retry",
    description: "单步最大重试次数",
    category: "runtime",
  },
  {
    label: "Request Timeout",
    description: "模型请求超时（0 表示不设置）",
    category: "runtime",
  },
  { label: "Compaction", description: "上下文压缩", category: "runtime" },
  {
    label: "Compaction Threshold",
    description: "压缩触发阈值",
    category: "runtime",
  },
  {
    label: "Checkpoint 目录",
    description: "额外 checkpoint 目录",
    category: "runtime",
  },
  {
    label: "Terminal Window Mode",
    description: "终端窗口模式",
    category: "runtime",
  },
  // Windows-only, filtered out on every other host by settings-host-rows.ts.
  // The guard is not cosmetic: on Linux and macOS the shell IS bash and no
  // path can change that, so the resolver off Windows never reads it.
  {
    label: "Git Bash 路径",
    description:
      "Git for Windows 的 bash.exe 位置（仅 Windows 需要；Linux/macOS 默认即 bash，无需设置）。留空 = 自动搜索默认安装位置与 PATH",
    category: "runtime",
  },
  // --- 界面 -------------------------------------------------------------
  {
    label: "Theme Mode",
    description: "切换浅色 / 深色",
    category: "interface",
  },
  {
    label: "运行中发送",
    description:
      "busy 时发送默认注入当前轮（next-step），或排到下一轮（next-turn）",
    category: "interface",
  },
  // --- 配置保存范围 -----------------------------------------------------
  {
    label: "界面偏好保存范围",
    description: "主题 / 密度 / 快捷键保存位置",
    category: "storage",
  },
  {
    label: "运行时配置保存范围",
    description: "模型 / 权限 / 运行时设置保存位置",
    category: "storage",
  },
  // --- 系统 -------------------------------------------------------------
  // The exit, in its own category on purpose: it is the one setting that is
  // not a setting. A window may hide on close and the runtime keep running,
  // so a visible way to end the app has to exist — and it must not sit
  // among toggles, where a mis-aimed tap would end a session with live work.
  {
    label: "Quit Natalia",
    description: "结束 Natalia：关闭窗口并停止运行时（需确认）",
    category: "system",
  },
];

/** The rows of one category, in declaration order. */
export function rowsForCategory(
  category: SettingsCategoryId,
): readonly SettingsRowSpec[] {
  return SETTINGS_ROWS.filter((row) => row.category === category);
}

/** What a row shows when its backing store has no answer yet. */
export const UNSET_VALUE_LABEL = "未配置";
