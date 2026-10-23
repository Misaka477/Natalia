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
  | "storage";

export type SettingsCategorySpec = {
  id: SettingsCategoryId;
  label: string;
  /** The dictionary key for the label's display text. */
  labelKey: string;
};

// "系统" used to hold the only row in it, a Quit button. It is gone: the exit
// lives in the tray, which is the one affordance that survives a hidden
// window, and a category with no rows is a nav entry that renders nothing.
export const SETTINGS_CATEGORIES: readonly SettingsCategorySpec[] = [
  { id: "model", label: "模型与 Agent", labelKey: "settings.cat.model" },
  { id: "security", label: "权限与安全", labelKey: "settings.cat.security" },
  { id: "runtime", label: "运行时与上下文", labelKey: "settings.cat.runtime" },
  { id: "interface", label: "界面", labelKey: "settings.cat.interface" },
  { id: "storage", label: "配置保存范围", labelKey: "settings.cat.storage" },
];

export type SettingsRowSpec = {
  /** The row's label. It is declared here and in the panel's render. */
  label: string;
  /** The dictionary key for the label's display text. */
  labelKey: string;
  description: string;
  /** The dictionary key for the description's display text. */
  descKey: string;
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
    labelKey: "settings.row.providers",
    description: "配置 provider 并导入模型",
    descKey: "settings.rowDesc.providers",
    category: "model",
  },
  {
    label: "Default Model",
    labelKey: "settings.row.defaultModel",
    description: "默认使用的模型",
    descKey: "settings.rowDesc.defaultModel",
    category: "model",
  },
  {
    label: "子 Agent 并发数",
    labelKey: "settings.row.subConcurrency",
    description: "团队子 agent 最大并发数",
    descKey: "settings.rowDesc.subConcurrency",
    category: "model",
  },
  // --- 权限与安全 -------------------------------------------------------
  {
    label: "Permission Profile",
    labelKey: "settings.row.permissionProfile",
    description: "选择、新增、编辑权限配置",
    descKey: "settings.rowDesc.permissionProfile",
    category: "security",
  },
  // --- 运行时与上下文 ---------------------------------------------------
  {
    label: "Max Steps",
    labelKey: "settings.row.maxSteps",
    description: "单轮最大执行步数",
    descKey: "settings.rowDesc.maxSteps",
    category: "runtime",
  },
  {
    label: "Max Retry",
    labelKey: "settings.row.maxRetry",
    description: "单步最大重试次数",
    descKey: "settings.rowDesc.maxRetry",
    category: "runtime",
  },
  {
    label: "Request Timeout",
    labelKey: "settings.row.requestTimeout",
    description: "模型请求超时（0 表示不设置）",
    descKey: "settings.rowDesc.requestTimeout",
    category: "runtime",
  },
  {
    label: "Compaction",
    labelKey: "settings.row.compaction",
    description: "上下文压缩",
    descKey: "settings.rowDesc.compaction",
    category: "runtime",
  },
  {
    label: "Compaction Threshold",
    labelKey: "settings.row.compactionThreshold",
    description: "压缩触发阈值",
    descKey: "settings.rowDesc.compactionThreshold",
    category: "runtime",
  },
  {
    label: "Checkpoint 目录",
    labelKey: "settings.row.checkpointDirs",
    description: "额外 checkpoint 目录",
    descKey: "settings.rowDesc.checkpointDirs",
    category: "runtime",
  },
  // WHICH shell runs a command, as distinct from the two path rows below that
  // say WHERE each one lives. A row here is what makes the choice reachable:
  // `editableActions` holds the behaviour, and a label with no row is a
  // setting that exists in the code and nowhere on screen.
  {
    label: "Shell 类型",
    labelKey: "settings.row.shellType",
    description:
      "命令在哪个 shell 里执行：pwsh（PowerShell 7）、bash（Git Bash / WSL）或 zsh。选「自动」= 跟随平台默认（Windows 用 pwsh，其他用 bash）",
    descKey: "settings.rowDesc.shellType",
    category: "runtime",
  },
  // Windows-only, filtered out on every other host by settings-host-rows.ts.
  // The guard is not cosmetic: on Linux and macOS the shell IS bash and no
  // path can change that, so the resolver off Windows never reads it.
  {
    label: "Git Bash 路径",
    labelKey: "settings.row.gitBashPath",
    description:
      "Git for Windows 的 bash.exe 位置（仅 Windows 需要；Linux/macOS 默认即 bash，无需设置）。留空 = 自动搜索默认安装位置与 PATH",
    descKey: "settings.rowDesc.gitBashPath",
    category: "runtime",
  },
  // The PowerShell twin, with the same host guard and the same reason: the
  // resolver probes the well-known install roots and PATH, and a pwsh 7 outside
  // both (a per-user install the runtime's inherited PATH does not carry) left
  // the pane on Windows PowerShell 5.1.
  {
    label: "PowerShell 路径",
    labelKey: "settings.row.psPath",
    description:
      "pwsh.exe 的全路径（仅 Windows 需要）。留空 = 依次搜索 Program Files、当前用户安装目录、PATH，最后退回系统自带的 Windows PowerShell 5.1",
    descKey: "settings.rowDesc.psPath",
    category: "runtime",
  },
  // --- 界面 -------------------------------------------------------------
  {
    label: "Theme Mode",
    labelKey: "settings.row.themeMode",
    description: "切换浅色 / 深色",
    descKey: "settings.rowDesc.themeMode",
    category: "interface",
  },
  {
    label: "Language",
    labelKey: "settings.row.language",
    description: "切换界面与插件语言（自动探测已注册语言包）",
    descKey: "settings.rowDesc.language",
    category: "interface",
  },
  {
    label: "运行中发送",
    labelKey: "settings.row.busySend",
    description:
      "busy 时发送默认注入当前轮（next-step），或排到下一轮（next-turn）",
    descKey: "settings.rowDesc.busySend",
    category: "interface",
  },
  // --- 配置保存范围 -----------------------------------------------------
  {
    label: "界面偏好保存范围",
    labelKey: "settings.row.uiPrefScope",
    description: "主题 / 密度 / 快捷键保存位置",
    descKey: "settings.rowDesc.uiPrefScope",
    category: "storage",
  },
  {
    label: "运行时配置保存范围",
    labelKey: "settings.row.runtimePrefScope",
    description: "模型 / 权限 / 运行时设置保存位置",
    descKey: "settings.rowDesc.runtimePrefScope",
    category: "storage",
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
