import {
  createSignal,
  createEffect,
  createMemo,
  For,
  Show,
  onCleanup,
  onMount,
} from "solid-js";
import type { AppState } from "@natalia/view-store";
import {
  describeRuntimeCapabilities,
  type ConfigV3,
  type RuntimeClient,
  type UiPanelRequirement,
} from "@anthelia/contracts";
import { NeuSelect } from "./components/NeuSelect";
import { hostFromSegments, rowsForHost } from "./settings-host-rows";
import { useConfirmDialog } from "./components/ConfirmDialog";

const BUILTIN_PERMISSION_PROFILES = ["ask", "auto", "read_only"];

export type RegisteredToolView = Awaited<
  ReturnType<NonNullable<RuntimeClient["registeredTools"]>>
>[number];

type ToolFamilyGroup = {
  id: string;
  label: string;
  tools: string[];
};

function splitCsv(value: string): string[] {
  return value
    .split(",")
    .map((item) => item.trim())
    .filter(Boolean);
}

function buildToolFamilyGroups(
  registered: readonly RegisteredToolView[],
  selected: string,
): ToolFamilyGroup[] {
  const selectedValues = new Set(splitCsv(selected));
  const registeredNames = new Set<string>();
  const byOwner = new Map<string, Set<string>>();
  for (const tool of registered) {
    const owner = tool.owner || "未归属";
    const tools = byOwner.get(owner) ?? new Set<string>();
    tools.add(tool.name);
    byOwner.set(owner, tools);
    registeredNames.add(tool.name);
  }

  const groups = [...byOwner.entries()]
    .map(([owner, tools]) => ({
      id: owner,
      label: owner,
      tools: [...tools].sort(),
    }))
    .sort((left, right) => left.label.localeCompare(right.label));

  const missing = [...selectedValues].filter(
    (name) => !registeredNames.has(name),
  );
  if (missing.length)
    groups.push({
      id: "__configured__",
      label: "已配置（未注册）",
      tools: missing.sort(),
    });
  return groups;
}

function ToolFamilyChecklist(props: {
  registered: readonly RegisteredToolView[];
  selected: string;
  onToggle(tools: readonly string[], selected: boolean): void;
}) {
  const selectedSet = createMemo(() => new Set(splitCsv(props.selected)));
  const groups = createMemo(() =>
    buildToolFamilyGroups(props.registered, props.selected),
  );
  return (
    <Show
      when={groups().length}
      fallback={<div class="neu-tool-family-empty">暂无可选工具</div>}
    >
      <div class="neu-tool-family-list">
        <For each={groups()}>
          {(group) =>
            group.id === "__configured__" ? (
              <div class="neu-tool-family">
                <div class="neu-tool-family-title">{group.label}</div>
                <div class="neu-tool-select-grid">
                  <For each={group.tools}>
                    {(tool) => (
                      <label class="neu-form-checkbox neu-tool-check">
                        <input
                          type="checkbox"
                          checked={selectedSet().has(tool)}
                          onChange={() =>
                            props.onToggle([tool], !selectedSet().has(tool))
                          }
                        />
                        <span>{tool}</span>
                      </label>
                    )}
                  </For>
                </div>
              </div>
            ) : (
              <ToolFamilyRow
                group={group}
                selectedSet={selectedSet()}
                onToggle={props.onToggle}
              />
            )
          }
        </For>
      </div>
    </Show>
  );
}

function ToolFamilyRow(props: {
  group: ToolFamilyGroup;
  selectedSet: ReadonlySet<string>;
  onToggle(tools: readonly string[], selected: boolean): void;
}) {
  let checkbox: HTMLInputElement | undefined;
  const selectedCount = createMemo(
    () =>
      props.group.tools.filter((tool) => props.selectedSet.has(tool)).length,
  );
  const allSelected = createMemo(
    () =>
      props.group.tools.length > 0 &&
      selectedCount() === props.group.tools.length,
  );
  const partiallySelected = createMemo(
    () => selectedCount() > 0 && !allSelected(),
  );
  createEffect(() => {
    if (checkbox) checkbox.indeterminate = partiallySelected();
  });
  return (
    <label class="neu-form-checkbox neu-tool-family-check">
      <input
        ref={checkbox}
        type="checkbox"
        checked={allSelected()}
        onChange={() => props.onToggle(props.group.tools, !allSelected())}
      />
      <span class="neu-tool-family-name">{props.group.label}</span>
      <span class="neu-tool-family-count">
        {selectedCount()}/{props.group.tools.length}
      </span>
    </label>
  );
}

type CategoryId =
  | "model"
  | "security"
  | "runtime"
  | "interface"
  | "storage"
  // The exit is not a setting, but it needs a home that is not among them: a
  // window may hide on close while the runtime keeps running, so a visible way
  // OUT has to exist.
  | "system"
  | "plugin";

/**
 * The product's academic name, shown under the wordmark in the settings
 * footer. Seven words for seven letters, and each one names a fact this
 * codebase can be held to:
 *
 *   Native — a compiled artifact running on the host (native terminal,
 *     Rust native crates)
 *   Agent — a multi-agent runtime (Natalia/Navi/Nia), not a single chatbot
 *   Toolkit — the product's real shape: a tool registry plus a plugin host
 *   Accountable — every action has an owner, an event, and an approval
 *     record; growth proposals never self-authorize
 *   Ledger — the event-sourced session journal is the single source of
 *     truth (append-only, content-addressed, rollback-able)
 *   Instrumented — runtime invariants are published as events, the doctor
 *     and the guard suite read them; self-observation is first-class
 *   Architecture — the layered engine (contracts / plugins / hosts /
 *     @anthelia/*)
 *
 * It replaced a backronym that filled letters with words we do not stand
 * behind. Do not re-introduce them:
 *   "Autonomous"       — the approval posture is ask/auto/read_only and the
 *                        growth lane never self-authorizes; this is the
 *                        opposite of what we ship
 *   "Local Intelligence" — the models are remote providers; local-first is
 *                        about data, not about where the model runs
 *   "Terminal"          — the web shell is a first-class app, not a
 *                        fallback
 * "Neural" said nothing at all.
 */
const ACADEMIC_NAME =
  "Native Agent Toolkit: Accountable Ledger, Instrumented Architecture";

type SettingItem = {
  label: string;
  description: string;
  value: string;
};

type Category = {
  id: CategoryId;
  label: string;
  items: SettingItem[];
};

const categories: Category[] = [
  {
    id: "model",
    label: "模型与 Agent",
    items: [
      {
        label: "Providers & Models",
        description: "配置 provider 并导入模型",
        value: "",
      },
      {
        label: "Default Model",
        description: "默认使用的模型",
        value: "Opus 4",
      },
      {
        label: "子 Agent 并发数",
        description: "团队子 agent 最大并发数",
        value: "3",
      },
    ],
  },
  {
    id: "security",
    label: "权限与安全",
    items: [
      {
        label: "Permission Profile",
        description: "选择、新增、编辑权限配置",
        value: "ask",
      },
    ],
  },
  {
    id: "runtime",
    label: "运行时与上下文",
    items: [
      {
        label: "Max Steps",
        description: "单轮最大执行步数",
        value: "unlimited",
      },
      { label: "Max Retry", description: "单步最大重试次数", value: "3" },
      {
        label: "Request Timeout",
        description: "模型请求超时（0 表示不设置）",
        value: "不设置",
      },
      { label: "Compaction", description: "上下文压缩", value: "开启" },
      {
        label: "Compaction Threshold",
        description: "压缩触发阈值",
        value: "85%",
      },
      {
        label: "Checkpoint 目录",
        description: "额外 checkpoint 目录",
        value: "2 个",
      },
      {
        label: "Terminal Window Mode",
        description: "终端窗口模式",
        value: "auto",
      },
      {
        // Windows-only, and the guard is not cosmetic: on Linux and macOS
        // the shell IS bash and no path can change that, so the resolver
        // off Windows never reads this setting (see resolveBashExecutable's
        // platform guard). A row that does nothing on two of three hosts
        // is noise, so it is filtered out rather than shown-disabled.
        label: "Git Bash 路径",
        description:
          "Git for Windows 的 bash.exe 位置（仅 Windows 需要；Linux/macOS 默认即 bash，无需设置）。留空 = 自动搜索默认安装位置与 PATH",
        value: "",
      },
    ],
  },
  {
    // The exit, in its own category on purpose: it is the one setting that is
    // not a setting. A window may hide on close (the minimise policy) and the
    // runtime keep running, so a visible way to end the app has to exist — and
    // it must not sit among toggles, where a mis-aimed tap would end a session
    // with live work in it.
    id: "system",
    label: "系统",
    items: [
      {
        label: "Quit Natalia",
        description: "结束 Natalia：关闭窗口并停止运行时（需确认）",
        value: "",
      },
    ],
  },
  {
    id: "interface",
    label: "界面",
    items: [
      { label: "Theme Mode", description: "切换浅色 / 深色", value: "浅色" },
      {
        label: "运行中发送",
        description:
          "busy 时发送默认注入当前轮（next-step），或排到下一轮（next-turn）",
        value: "注入当前轮",
      },
    ],
  },
  {
    id: "storage",
    label: "配置保存范围",
    items: [
      {
        label: "界面偏好保存范围",
        description: "主题 / 密度 / 快捷键保存位置",
        value: "项目",
      },
      {
        label: "运行时配置保存范围",
        description: "模型 / 权限 / 运行时设置保存位置",
        value: "全局",
      },
    ],
  },
];

export function SettingsPanel(props: {
  open: boolean;
  onClose: () => void;
  onOpenModels?: () => void;
  themeMode?: string;
  onCycleThemeMode?: () => void;
  /**
   * Shut the application down. Optional: a surface without it (an embedded host,
   * a read-only integration) simply does not render the row, rather than
   * rendering a button that cannot answer.
   */
  onQuit?: () => void;
  state?: AppState;
  config?: ConfigV3;
  preferences?: {
    get<T>(key: string): T | undefined;
    set<T>(key: string, value: T): void;
  };
  registeredTools?: RegisteredToolView[];
  onUpdateConfig?: (patch: Record<string, unknown>) => unknown;
  /**
   * The runtime's own answer after a write. The panel's `config` prop is a
   * snapshot; a write that changes the live runtime (a compose-time row versus
   * this process) makes the snapshot stale, and re-reading puts the value cell
   * back on what IS rather than what was passed in.
   */
  onConfig?: (config: Record<string, unknown>) => void;
  runtime?: RuntimeClient;
  host?: import("@natalia/ui-host").UiPluginContext["host"];
}) {
  const [activeCategory, setActiveCategory] = createSignal<CategoryId>("model");
  /**
   * The panel's own view of the runtime config.
   *
   * `props.config` is a snapshot the app holds, and it is undefined until the
   * app's own load finishes — which can easily be AFTER the panel is opened.
   * While it is undefined every row falls back to the category's static value
   * (Compaction's is a literal "开启"), and the rows that gate on `props.config`
   * do not render as buttons at all: the panel looks alive and does nothing.
   * So the panel reads the runtime itself and prefers its own answer, while
   * still tracking the app's snapshot for everything it does not re-read.
   */
  const [ownConfig, setOwnConfig] = createSignal<
    Record<string, unknown> | undefined
  >();
  const effectiveConfig = (): ConfigV3 | undefined =>
    (ownConfig() as ConfigV3 | undefined) ?? props.config;
  // The config writer. The app mounts this panel without one (it passes only
  // the runtime), which left EVERY row that writes config — compaction, the
  // threshold, the terminal mode, max steps, max retry — rendering as a plain
  // span: clickable-looking, and dead. The runtime already carries the face
  // (`config.update`), so the panel derives its writer instead of trusting a
  // callback that was never passed. A panel with neither (no callback and no
  // runtime) has no writer, and its config rows stay inert — honestly so.
  const updateConfig:
    | ((patch: Record<string, unknown>) => unknown)
    | undefined =
    props.onUpdateConfig ??
    (props.runtime?.updateConfig
      ? (patch: Record<string, unknown>) =>
          props.runtime?.updateConfig?.(patch as never)
      : undefined);
  /** A config write's failure, shown in the panel rather than swallowed. */
  const [configError, setConfigError] = createSignal<string>();
  /**
   * The one config write path. A refused or failed patch reports itself: the
   * row shows the reason and the panel re-reads the runtime's own answer,
   * because a local config object and the live runtime can disagree (the
   * compose-time row versus this process) and the value cell must show what IS.
   */
  async function writeConfig(patch: Record<string, unknown>) {
    console.log("[settings] config write ->", patch);
    try {
      await updateConfig?.(patch);
      const next = await props.runtime?.configGet?.();
      console.log("[settings] config write <-", next);
      // Our own view first (the rows read it), then the app's snapshot.
      if (next) setOwnConfig(next as never);
      if (next) props.onConfig?.(next as never);
    } catch (error) {
      console.log("[settings] config write FAILED", error);
      setConfigError(
        `写入失败：${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }
  createEffect(() => {
    // Opening is the read: `props.config` is the app's snapshot and may still be
    // undefined, which leaves every row on its static value with the config
    // gates closed. Reading the runtime here makes the panel self-sufficient.
    if (!props.open) return;
    void props.runtime?.configGet?.().then((next) => {
      if (next) setOwnConfig(next as never);
    });
  });

  const { alert, confirm, dialog } = useConfirmDialog();
  const [uiWriteScope, setUiWriteScope] = createSignal(
    props.preferences?.get<string>("uiWriteScope") ?? "project",
  );
  const [busySendDelivery, setBusySendDelivery] = createSignal<
    "next-step" | "next-turn"
  >(
    props.preferences?.get<"next-step" | "next-turn">("busySendDelivery") ??
      "next-step",
  );

  const [settingsPanel, setSettingsPanel] = createSignal<{
    pluginId: string;
    panelId: string;
  } | null>(null);
  let settingsPanelRef: HTMLDivElement | undefined;
  const [panelRevision, setPanelRevision] = createSignal(0);
  const [availablePluginIds, setAvailablePluginIds] = createSignal<Set<string>>(
    new Set(),
  );
  const [availableCapabilities, setAvailableCapabilities] = createSignal<
    Set<string>
  >(new Set());
  onMount(() => {
    const unsubscribe = props.host?.subscribePanels(() =>
      setPanelRevision((revision) => revision + 1),
    );
    onCleanup(() => unsubscribe?.());
    const runtime = props.runtime;
    if (!runtime) return;
    void (async () => {
      const [plugins, report] = await Promise.all([
        runtime.plugins?.(),
        Promise.resolve(describeRuntimeCapabilities(runtime)),
      ]);
      setAvailablePluginIds(
        new Set((plugins ?? []).map((plugin) => plugin.id)),
      );
      setAvailableCapabilities(
        new Set(
          report.groups
            .filter((group) => group.available)
            .map((group) => group.name),
        ),
      );
    })();
  });
  function panelSatisfies(requirements?: UiPanelRequirement[]) {
    if (!requirements?.length) return true;
    return requirements.every((requirement) => {
      if (requirement.type === "plugin")
        return availablePluginIds().has(requirement.id);
      if (requirement.type === "capability")
        return availableCapabilities().has(requirement.id);
      if (requirement.type === "method")
        return (
          typeof (props.runtime as unknown as Record<string, unknown>)[
            requirement.name
          ] === "function"
        );
      return false;
    });
  }
  const settingsPanels = () => {
    panelRevision();
    return (
      props.host
        ?.listPanels()
        .filter(
          (item) =>
            item.panel.region === "settings" &&
            panelSatisfies(item.panel.requires),
        ) ?? []
    );
  };
  const groupedSettingsPanels = () => {
    const groups = new Map<string, ReturnType<typeof settingsPanels>>();
    for (const item of settingsPanels()) {
      const group = item.panel.group ?? "插件设置";
      const list = groups.get(group) ?? [];
      list.push(item);
      groups.set(group, list);
    }
    return [...groups.entries()];
  };
  const categoriesWithPlugins = (): Category[] =>
    settingsPanels().length
      ? [
          ...categories,
          {
            id: "plugin" as CategoryId,
            label: "插件配置",
            items: [] as Category["items"],
          },
        ]
      : categories;

  const [runtimeWriteScope, setRuntimeWriteScope] = createSignal(
    props.preferences?.get<string>("runtimeWriteScope") ?? "global",
  );
  /**
   * The host platform, as the RUNTIME named it in its status snapshot. The
   * settings panel cannot know it from the browser: navigator describes the
   * browser, not the host the runtime runs on (a Linux laptop can drive a
   * Windows host). An absent segment means "unknown", and unknown is not
   * Windows, so host-only rows stay hidden rather than shown on a guess.
   * The filter itself lives in settings-host-rows.ts, tested there.
   */
  const current = () => {
    const category =
      categoriesWithPlugins().find(
        (category) => category.id === activeCategory(),
      ) ?? categoriesWithPlugins()[0]!;
    return {
      ...category,
      items: rowsForHost(
        category.items,
        hostFromSegments(props.state?.statusSegments),
      ),
    };
  };

  function modelLabel(config: ConfigV3): string {
    const model = config.defaultModel;
    if (!model) return "未设置";
    if (typeof model === "string") return model;
    return `${model.provider}/${model.model}`;
  }

  function cyclePreference(
    key: string,
    current: string,
    values: string[],
    setter: (value: string) => void,
  ) {
    const next = values[(values.indexOf(current) + 1) % values.length]!;
    props.preferences?.set(key, next);
    setter(next);
  }

  const [editFieldLabel, setEditFieldLabel] = createSignal<
    string | undefined
  >();
  const [editFieldValue, setEditFieldValue] = createSignal("");
  let editFieldAction: ((value: string) => void) | undefined;
  const [permissionEditorOpen, setPermissionEditorOpen] = createSignal(false);
  const [permissionListOpen, setPermissionListOpen] = createSignal(false);
  const [permissionName, setPermissionName] = createSignal("ask");
  const [permissionDescription, setPermissionDescription] = createSignal("");
  const [permissionApproval, setPermissionApproval] = createSignal("ask");
  const [permissionAllowedTools, setPermissionAllowedTools] = createSignal("");
  const [permissionExcludedTools, setPermissionExcludedTools] =
    createSignal("");
  const [permissionCommandMode, setPermissionCommandMode] =
    createSignal("none");
  const [permissionCommandRules, setPermissionCommandRules] = createSignal("");
  const [permissionInteractiveAny, setPermissionInteractiveAny] =
    createSignal(false);
  const [permissionInteractiveAllow, setPermissionInteractiveAllow] =
    createSignal("");

  function openEdit(
    label: string,
    current: string,
    apply: (value: string) => void,
  ) {
    setEditFieldLabel(label);
    setEditFieldValue(current);
    editFieldAction = apply;
  }

  function openPermissionEditorFor(name: string) {
    const config = effectiveConfig();
    const profile = config?.agentModes?.[name];
    setPermissionName(name);
    setPermissionDescription(profile?.description ?? "");
    setPermissionApproval(profile?.approval ?? "ask");
    setPermissionAllowedTools((profile?.allowedTools ?? []).join(", "));
    setPermissionExcludedTools((profile?.excludedTools ?? []).join(", "));
    setPermissionCommandMode(profile?.commandRules?.mode ?? "none");
    setPermissionCommandRules((profile?.commandRules?.rules ?? []).join(", "));
    setPermissionInteractiveAny(
      Boolean(profile?.interactivePrograms?.allowAny),
    );
    setPermissionInteractiveAllow(
      (profile?.interactivePrograms?.allow ?? [])
        .map((entry) => entry.command)
        .join(", "),
    );
    setPermissionEditorOpen(true);
  }

  function openNewPermissionEditor() {
    setPermissionName("");
    setPermissionDescription("");
    setPermissionApproval("ask");
    setPermissionAllowedTools("");
    setPermissionExcludedTools("");
    setPermissionCommandMode("none");
    setPermissionCommandRules("");
    setPermissionInteractiveAny(false);
    setPermissionInteractiveAllow("");
    setPermissionEditorOpen(true);
  }

  const editableActions: Record<string, () => void> = {
    "Git Bash 路径": () => {
      const current = effectiveConfig()?.runtime?.shell?.bashPath ?? "";
      openEdit(
        "Git Bash 路径 (bash.exe 全路径，留空自动探测)",
        current,
        (raw) => {
          const path = raw.trim();
          updateConfig?.({
            runtime: {
              ...effectiveConfig()?.runtime,
              // An empty string means "discover" — the resolver's configured
              // path is cleared, not set to a blank.
              shell: { bashPath: path },
            },
          });
        },
      );
    },
    "子 Agent 并发数": () => {
      const current = String(effectiveConfig()?.team?.maxConcurrent ?? 4);
      openEdit("子 Agent 最大并发数", current, (raw) => {
        const value = Number(raw);
        if (Number.isInteger(value) && value >= 1 && value <= 32)
          updateConfig?.({
            team: { ...effectiveConfig()?.team, maxConcurrent: value },
          });
      });
    },
    "Permission Profile": () => {
      setPermissionListOpen(true);
    },
    "Max Steps": () => {
      const steps = effectiveConfig()?.runtime?.maxStepsPerTurn;
      const current = steps ? String(steps) : "";
      openEdit("单轮最大执行步数", current, (raw) => {
        updateConfig?.({
          runtime: {
            ...effectiveConfig()?.runtime,
            maxStepsPerTurn: raw.trim() ? Number(raw) : undefined,
          },
        });
      });
    },
    "Max Retry": () => {
      const effective =
        effectiveConfig()?.runtime?.maxAttemptsPerStep ??
        effectiveConfig()?.runtime?.retry?.maxAttemptsPerStep;
      const current =
        effective === null || effective === undefined ? "" : String(effective);
      openEdit("单步最大重试次数", current, (raw) => {
        const value = Number(raw);
        if (Number.isInteger(value) && value > 0)
          updateConfig?.({
            runtime: {
              ...effectiveConfig()?.runtime,
              maxAttemptsPerStep: value,
            },
          });
      });
    },
    "Request Timeout": () => {
      const current = String(
        effectiveConfig()?.runtime?.timeouts?.requestSec ?? 0,
      );
      openEdit("请求超时（秒，0 表示不设置）", current, (raw) => {
        const value = Number(raw);
        if (Number.isInteger(value) && value >= 0)
          updateConfig?.({
            runtime: {
              ...effectiveConfig()?.runtime,
              timeouts: {
                ...effectiveConfig()?.runtime?.timeouts,
                requestSec: value,
              },
            },
          });
      });
    },
    "Compaction Threshold": () => {
      const current = String(
        effectiveConfig()?.context?.compactionThresholdPercent ?? 85,
      );
      openEdit("Compaction 阈值（%）", current, (raw) => {
        const value = Number(raw);
        if (Number.isInteger(value) && value > 0 && value <= 100)
          updateConfig?.({
            context: {
              ...effectiveConfig()?.context,
              compactionThresholdPercent: value,
            },
          });
      });
    },
    "Checkpoint 目录": () => {
      const current = (
        effectiveConfig()?.checkpoint?.additionalDirs ?? []
      ).join(",");
      openEdit("额外 checkpoint 目录（逗号分隔）", current, (raw) => {
        updateConfig?.({
          checkpoint: {
            ...effectiveConfig()?.checkpoint,
            additionalDirs: raw
              .split(",")
              .map((entry) => entry.trim())
              .filter(Boolean),
          },
        });
      });
    },
    界面偏好保存范围: () => {
      cyclePreference(
        "uiWriteScope",
        uiWriteScope(),
        ["project", "global"],
        setUiWriteScope,
      );
    },
    运行时配置保存范围: () => {
      cyclePreference(
        "runtimeWriteScope",
        runtimeWriteScope(),
        ["project", "global"],
        setRuntimeWriteScope,
      );
    },
  };

  function toggleCsv(
    current: string,
    value: string,
    setter: (next: string) => void,
  ) {
    const items = current
      .split(",")
      .map((item) => item.trim())
      .filter(Boolean);
    const next = items.includes(value)
      ? items.filter((item) => item !== value)
      : [...items, value];
    setter(next.join(", "));
  }

  function toggleFamily(
    current: string,
    tools: readonly string[],
    selected: boolean,
    setter: (next: string) => void,
  ) {
    const next = new Set(splitCsv(current));
    for (const tool of tools) {
      if (selected) next.add(tool);
      else next.delete(tool);
    }
    setter([...next].join(", "));
  }

  const toolChecklist = (selected: string, setter: (next: string) => void) => (
    <ToolFamilyChecklist
      registered={props.registeredTools ?? []}
      selected={selected}
      onToggle={(tools, select) =>
        toggleFamily(selected, tools, select, setter)
      }
    />
  );

  function runtimeValue(label: string): string | undefined {
    const config = effectiveConfig() as ConfigV3 | undefined;
    if (!config) return undefined;
    switch (label) {
      case "Default Model":
        return modelLabel(config);
      case "子 Agent 并发数":
        return String(config.team?.maxConcurrent ?? 4);
      case "Permission Profile":
        return config.defaultAgentMode ?? "ask";
      case "Max Steps":
        return String(config.runtime?.maxStepsPerTurn ?? "unlimited");
      case "Max Retry":
        const retryCap =
          config.runtime?.maxAttemptsPerStep ??
          config.runtime?.retry?.maxAttemptsPerStep;
        return retryCap === null || retryCap === undefined
          ? "不限制"
          : String(retryCap);
      case "Request Timeout": {
        const seconds = config.runtime?.timeouts?.requestSec ?? 0;
        return seconds > 0 ? `${seconds}s` : "不设置";
      }
      case "Compaction":
        return config.context?.compactionEnabled ? "开启" : "关闭";
      case "Compaction Threshold":
        return `${config.context?.compactionThresholdPercent ?? 85}%`;
      case "Checkpoint 目录":
        return `${(config.checkpoint?.additionalDirs ?? []).length} 个`;
      case "Terminal Window Mode":
        return String(config.runtime?.terminal?.windowMode ?? "auto");
      case "Git Bash 路径":
        return config.runtime?.shell?.bashPath || "自动探测";
      case "界面偏好保存范围":
        return uiWriteScope();
      case "运行时配置保存范围":
        return runtimeWriteScope();
    }
    return undefined;
  }

  return (
    <Show when={props.open}>
      <div class="neu-settings-backdrop" onClick={props.onClose}>
        <div
          class="neu-settings-window"
          onClick={(event) => event.stopPropagation()}
        >
          <div class="neu-settings-header">
            <span class="neu-settings-title">设置</span>
            <button
              type="button"
              class="neu-settings-close"
              onClick={props.onClose}
              aria-label="关闭设置"
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 3l10 10M13 3L3 13"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>
          <div class="neu-settings-body">
            <nav class="neu-settings-categories">
              <For each={categoriesWithPlugins()}>
                {(category) => (
                  <button
                    type="button"
                    class="neu-settings-category"
                    data-active={activeCategory() === category.id}
                    onClick={() => {
                      setActiveCategory(category.id);
                      if (
                        category.id === "plugin" &&
                        settingsPanel() &&
                        props.host
                      ) {
                        const selected = settingsPanel()!;
                        requestAnimationFrame(() => {
                          if (settingsPanelRef && props.host) {
                            void props.host.mountPanel(
                              selected.pluginId,
                              selected.panelId,
                              settingsPanelRef,
                            );
                          }
                        });
                      }
                    }}
                  >
                    {category.label}
                  </button>
                )}
              </For>
            </nav>
            <section class="neu-settings-content">
              <Show when={current().id === "plugin"}>
                <div class="neu-settings-content-title">插件配置</div>
                <For each={groupedSettingsPanels()}>
                  {([group, panels]) => (
                    <>
                      <Show when={group}>
                        <div class="neu-settings-content-title">{group}</div>
                      </Show>
                      <For each={panels}>
                        {(panel) => (
                          <div class="neu-settings-plugin-panel">
                            <button
                              type="button"
                              class="neu-settings-item neu-settings-item-button"
                              data-active={
                                settingsPanel()?.pluginId === panel.pluginId &&
                                settingsPanel()?.panelId === panel.panel.id
                              }
                              onClick={() => {
                                setSettingsPanel({
                                  pluginId: panel.pluginId,
                                  panelId: panel.panel.id,
                                });
                                requestAnimationFrame(() => {
                                  if (settingsPanelRef && props.host) {
                                    void props.host.mountPanel(
                                      panel.pluginId,
                                      panel.panel.id,
                                      settingsPanelRef,
                                    );
                                  }
                                });
                              }}
                            >
                              <div class="neu-settings-item-main">
                                <span class="neu-settings-item-label">
                                  {panel.panel.title}
                                </span>
                                <span class="neu-settings-item-description">
                                  {panel.panel.group ?? "插件设置"}
                                </span>
                              </div>
                            </button>
                            <Show
                              when={
                                settingsPanel()?.pluginId === panel.pluginId &&
                                settingsPanel()?.panelId === panel.panel.id
                              }
                            >
                              <div
                                ref={settingsPanelRef}
                                class="neu-settings-item neu-plugin-panel-body"
                              />
                            </Show>
                          </div>
                        )}
                      </For>
                    </>
                  )}
                </For>
              </Show>
              <Show when={current().id !== "plugin"}>
                <>
                  <div class="neu-settings-content-title">
                    {current().label}
                  </div>
                  <For each={current().items}>
                    {(item) => {
                      // A GETTER, not a const: `{value()}` in JSX is static
                      // text, so a const computed once freezes the cell at its
                      // first render — the write succeeded and the re-read
                      // answered the new value, and the row still showed the
                      // old one because nothing re-ran this expression. The
                      // getter re-runs whenever the config it reads changes.
                      const value = () =>
                        runtimeValue(item.label) ?? item.value;
                      if (
                        item.label === "Providers & Models" &&
                        props.onOpenModels
                      ) {
                        return (
                          <button
                            type="button"
                            class="neu-settings-item neu-settings-item-button"
                            onClick={() => props.onOpenModels?.()}
                          >
                            <div class="neu-settings-item-main">
                              <span class="neu-settings-item-label">
                                {item.label}
                              </span>
                              <span class="neu-settings-item-description">
                                {item.description}
                              </span>
                            </div>
                          </button>
                        );
                      }
                      // The exit row. A running app must have a visible way
                      // OUT: this is what makes "close the window but keep
                      // running" acceptable rather than a trap. It asks first —
                      // one stray click should not end a session with live work.
                      // A button, not a toggle: the row is an ACTION, and it
                      // asks first through the panel's own confirm dialog —
                      // ending a session with live work must take two deliberate
                      // clicks, not one stray tap among the toggles.
                      if (item.label === "Quit Natalia" && props.onQuit) {
                        return (
                          <button
                            type="button"
                            class="neu-settings-item neu-settings-item-button neu-settings-item-danger"
                            onClick={async () => {
                              const ok = await confirm({
                                title: "退出 Natalia？",
                                message:
                                  "窗口会关闭，运行时与所有会话一起停止。当前未落盘的进度会丢失。",
                                confirmLabel: "退出",
                                cancelLabel: "取消",
                                danger: true,
                              });
                              if (ok) props.onQuit?.();
                            }}
                          >
                            <div class="neu-settings-item-main">
                              <span class="neu-settings-item-label">
                                {item.label}
                              </span>
                              <span class="neu-settings-item-description">
                                {item.description}
                              </span>
                            </div>
                          </button>
                        );
                      }
                      if (
                        item.label === "Theme Mode" &&
                        props.onCycleThemeMode
                      ) {
                        return (
                          <button
                            type="button"
                            class="neu-settings-item neu-settings-item-button"
                            onClick={() => props.onCycleThemeMode?.()}
                          >
                            <div class="neu-settings-item-main">
                              <span class="neu-settings-item-label">
                                {item.label}
                              </span>
                              <span class="neu-settings-item-description">
                                {item.description}
                              </span>
                            </div>
                            <span class="neu-settings-item-value">
                              {props.themeMode === "dark" ? "深色" : "浅色"}
                            </span>
                          </button>
                        );
                      }
                      if (item.label === "运行中发送" && props.preferences) {
                        return (
                          <button
                            type="button"
                            class="neu-settings-item neu-settings-item-button"
                            onClick={() => {
                              const value =
                                busySendDelivery() === "next-step"
                                  ? ("next-turn" as const)
                                  : ("next-step" as const);
                              setBusySendDelivery(value);
                              props.preferences?.set("busySendDelivery", value);
                            }}
                          >
                            <div class="neu-settings-item-main">
                              <span class="neu-settings-item-label">
                                {item.label}
                              </span>
                              <span class="neu-settings-item-description">
                                {item.description}
                              </span>
                            </div>
                            <span class="neu-settings-item-value">
                              {busySendDelivery() === "next-step"
                                ? "注入当前轮"
                                : "排到下一轮"}
                            </span>
                          </button>
                        );
                      }
                      if (
                        item.label === "Compaction" &&
                        updateConfig &&
                        effectiveConfig()
                      ) {
                        return (
                          <button
                            type="button"
                            class="neu-settings-item neu-settings-item-button"
                            onClick={() => {
                              const next =
                                !effectiveConfig()?.context?.compactionEnabled;
                              setConfigError("");
                              void writeConfig({
                                context: {
                                  ...effectiveConfig()?.context,
                                  compactionEnabled: next,
                                },
                              });
                            }}
                          >
                            <div class="neu-settings-item-main">
                              <span class="neu-settings-item-label">
                                {item.label}
                              </span>
                              <span class="neu-settings-item-description">
                                {item.description}
                              </span>
                            </div>
                            <span class="neu-settings-item-value">
                              {value()}
                            </span>
                          </button>
                        );
                      }
                      if (
                        item.label === "Terminal Window Mode" &&
                        updateConfig &&
                        effectiveConfig()
                      ) {
                        return (
                          <button
                            type="button"
                            class="neu-settings-item neu-settings-item-button"
                            onClick={() => {
                              const modes = [
                                "auto",
                                "windowless",
                                "window",
                              ] as const;
                              const current =
                                effectiveConfig()?.runtime?.terminal
                                  ?.windowMode ?? "auto";
                              const index = modes.indexOf(
                                current as (typeof modes)[number],
                              );
                              const next = modes[(index + 1) % modes.length];
                              updateConfig?.({
                                runtime: {
                                  ...effectiveConfig()?.runtime,
                                  terminal: { windowMode: next },
                                },
                              });
                            }}
                          >
                            <div class="neu-settings-item-main">
                              <span class="neu-settings-item-label">
                                {item.label}
                              </span>
                              <span class="neu-settings-item-description">
                                {item.description}
                              </span>
                            </div>
                            <span class="neu-settings-item-value">
                              {value()}
                            </span>
                          </button>
                        );
                      }
                      if (editableActions[item.label] && updateConfig) {
                        return (
                          <button
                            type="button"
                            class="neu-settings-item neu-settings-item-button"
                            onClick={editableActions[item.label]}
                          >
                            <div class="neu-settings-item-main">
                              <span class="neu-settings-item-label">
                                {item.label}
                              </span>
                              <span class="neu-settings-item-description">
                                {item.description}
                              </span>
                            </div>
                            <span class="neu-settings-item-value">
                              {value()}
                            </span>
                          </button>
                        );
                      }
                      return (
                        <div class="neu-settings-item">
                          <div class="neu-settings-item-main">
                            <span class="neu-settings-item-label">
                              {item.label}
                            </span>
                            <span class="neu-settings-item-description">
                              {item.description}
                            </span>
                          </div>
                          <span class="neu-settings-item-value">{value()}</span>
                        </div>
                      );
                    }}
                  </For>
                </>
              </Show>
            </section>
          </div>
          <div class="neu-settings-footer">
            <span class="neu-settings-footer-title">Natalia</span>
            <span class="neu-settings-footer-sub">{ACADEMIC_NAME}</span>
            <span class="neu-settings-footer-quote">
              “Computation can carry what time cannot. Not metaphor.
              Mathematics.”
            </span>
          </div>
        </div>
      </div>
      <Show when={permissionListOpen()}>
        <div
          class="neu-settings-backdrop"
          onClick={() => setPermissionListOpen(false)}
        >
          <div
            class="neu-settings-window neu-edit-window"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="neu-settings-header">
              <span class="neu-settings-title">权限配置</span>
              <button
                type="button"
                class="neu-settings-close"
                onClick={() => setPermissionListOpen(false)}
                aria-label="关闭"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M3 3l10 10M13 3L3 13"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </div>
            <div class="neu-settings-body neu-edit-body">
              <Show
                when={
                  Object.entries(effectiveConfig()?.agentModes ?? {}).filter(
                    ([name]) => !BUILTIN_PERMISSION_PROFILES.includes(name),
                  ).length
                }
                fallback={
                  <div class="neu-settings-item">
                    <div class="neu-settings-item-main">
                      <span class="neu-settings-item-label">
                        暂无自定义权限配置
                      </span>
                      <span class="neu-settings-item-description">
                        点击下方“新增权限配置”创建
                      </span>
                    </div>
                  </div>
                }
              >
                <For
                  each={Object.entries(
                    effectiveConfig()?.agentModes ?? {},
                  ).filter(
                    ([name]) => !BUILTIN_PERMISSION_PROFILES.includes(name),
                  )}
                >
                  {([name, profile]) => (
                    <div class="neu-permission-row">
                      <button
                        type="button"
                        class="neu-settings-item neu-settings-item-button"
                        onClick={() => {
                          updateConfig?.({
                            defaultAgentMode: name,
                            defaultPermission: name,
                          });
                        }}
                      >
                        <div class="neu-settings-item-main">
                          <span class="neu-settings-item-label">
                            {name}
                            {effectiveConfig()?.defaultAgentMode === name
                              ? "（默认）"
                              : ""}
                          </span>
                          <span class="neu-settings-item-description">
                            {profile.description || profile.approval}
                          </span>
                        </div>
                        <span class="neu-settings-item-value">
                          {profile.approval}
                        </span>
                      </button>
                      <button
                        type="button"
                        class="neu-permission-edit"
                        onClick={() => {
                          setPermissionListOpen(false);
                          openPermissionEditorFor(name);
                        }}
                      >
                        编辑
                      </button>
                    </div>
                  )}
                </For>
              </Show>
              <div class="neu-extension-actions">
                <button
                  type="button"
                  class="neu-extension-add"
                  onClick={() => {
                    setPermissionListOpen(false);
                    openNewPermissionEditor();
                  }}
                >
                  新增权限配置
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>
      <Show when={permissionEditorOpen()}>
        <div
          class="neu-settings-backdrop"
          onClick={() => setPermissionEditorOpen(false)}
        >
          <div
            class="neu-settings-window neu-edit-window"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="neu-settings-header">
              <span class="neu-settings-title">
                权限配置（Permission Profile）
              </span>
              <button
                type="button"
                class="neu-settings-close"
                onClick={() => setPermissionEditorOpen(false)}
                aria-label="关闭"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M3 3l10 10M13 3L3 13"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </div>
            <div class="neu-settings-body neu-edit-body">
              <div class="neu-form-field">
                <label class="neu-form-label">Profile 名称</label>
                <input
                  class="neu-form-input"
                  value={permissionName()}
                  onInput={(e) => setPermissionName(e.currentTarget.value)}
                />
              </div>
              <div class="neu-form-field">
                <label class="neu-form-label">描述</label>
                <input
                  class="neu-form-input"
                  value={permissionDescription()}
                  onInput={(e) =>
                    setPermissionDescription(e.currentTarget.value)
                  }
                />
              </div>
              <div class="neu-form-field">
                <label class="neu-form-label">Approval Mode</label>
                <NeuSelect
                  value={permissionApproval()}
                  options={[
                    { value: "ask", label: "ask" },
                    { value: "auto", label: "auto" },
                    { value: "read_only", label: "read_only" },
                  ]}
                  onChange={(value) => setPermissionApproval(value)}
                />
              </div>
              <div class="neu-form-field">
                <label class="neu-form-label">
                  Allowed Tools（允许列表，留空不限制）
                </label>
                {toolChecklist(
                  permissionAllowedTools(),
                  setPermissionAllowedTools,
                )}
              </div>
              <div class="neu-form-field">
                <label class="neu-form-label">Excluded Tools（黑名单）</label>
                {toolChecklist(
                  permissionExcludedTools(),
                  setPermissionExcludedTools,
                )}
              </div>
              <div class="neu-form-field">
                <label class="neu-form-label">Command Rules Mode</label>
                <NeuSelect
                  value={permissionCommandMode()}
                  options={[
                    { value: "none", label: "none" },
                    { value: "blacklist", label: "blacklist" },
                    { value: "whitelist", label: "whitelist" },
                  ]}
                  onChange={(value) => setPermissionCommandMode(value)}
                />
              </div>
              <div class="neu-form-field">
                <label class="neu-form-label">Command Rules（逗号分隔）</label>
                <input
                  class="neu-form-input"
                  value={permissionCommandRules()}
                  onInput={(e) =>
                    setPermissionCommandRules(e.currentTarget.value)
                  }
                />
              </div>
              <div class="neu-form-field">
                <label class="neu-form-label">
                  Interactive Programs（高风险启动命令）
                </label>
                <div class="neu-checkbox-list">
                  <label class="neu-form-checkbox">
                    <input
                      type="checkbox"
                      checked={permissionInteractiveAny()}
                      onChange={() => setPermissionInteractiveAny((v) => !v)}
                    />
                    <span>allowAny（任意启动命令）</span>
                  </label>
                </div>
                <input
                  class="neu-form-input"
                  value={permissionInteractiveAllow()}
                  placeholder="允许的交互程序，逗号分隔"
                  onInput={(e) =>
                    setPermissionInteractiveAllow(e.currentTarget.value)
                  }
                />
              </div>
              <div class="neu-form-actions">
                <button
                  type="button"
                  class="neu-form-btn neu-form-cancel"
                  onClick={() => setPermissionEditorOpen(false)}
                >
                  取消
                </button>
                <button
                  type="button"
                  class="neu-form-btn neu-form-primary"
                  onClick={() => {
                    const name = permissionName().trim();
                    if (!name) return;
                    const previousMode = effectiveConfig()?.agentModes?.[name];
                    const split = (value: string) =>
                      value
                        .split(",")
                        .map((item) => item.trim())
                        .filter(Boolean);
                    updateConfig?.({
                      agentModes: {
                        ...effectiveConfig()?.agentModes,
                        [name]: {
                          description: permissionDescription(),
                          approval: permissionApproval(),
                          // Not edited here; retain existing main-agent fields.
                          systemPrompt: previousMode?.systemPrompt ?? "",
                          model: previousMode?.model,
                          allowedTools: split(permissionAllowedTools()),
                          excludedTools: split(permissionExcludedTools()),
                          commandRules: {
                            mode: permissionCommandMode() as
                              | "none"
                              | "blacklist"
                              | "whitelist",
                            rules: split(permissionCommandRules()),
                          },
                          interactivePrograms: {
                            allowAny: permissionInteractiveAny(),
                            allow: split(permissionInteractiveAllow()).map(
                              (command) => ({ command }),
                            ),
                          },
                          mcpServers: previousMode?.mcpServers ?? [],
                          skills: previousMode?.skills ?? true,
                        },
                      },
                      defaultAgentMode: name,
                      defaultPermission: name,
                    });
                    setPermissionEditorOpen(false);
                  }}
                >
                  保存
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>
      <Show when={editFieldLabel()}>
        <div
          class="neu-settings-backdrop"
          onClick={() => setEditFieldLabel(undefined)}
        >
          <div
            class="neu-settings-window neu-edit-window"
            onClick={(event) => event.stopPropagation()}
          >
            <div class="neu-settings-header">
              <span class="neu-settings-title">{editFieldLabel()}</span>
              <button
                type="button"
                class="neu-settings-close"
                onClick={() => setEditFieldLabel(undefined)}
                aria-label="关闭"
              >
                <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                  <path
                    d="M3 3l10 10M13 3L3 13"
                    stroke="currentColor"
                    stroke-width="1.4"
                    stroke-linecap="round"
                  />
                </svg>
              </button>
            </div>
            <div class="neu-settings-body neu-edit-body">
              <input
                class="neu-form-input"
                value={editFieldValue()}
                onInput={(event) =>
                  setEditFieldValue(event.currentTarget.value)
                }
                onKeyDown={(event) => {
                  if (event.key === "Enter") {
                    editFieldAction?.(editFieldValue());
                    setEditFieldLabel(undefined);
                  }
                }}
              />
              <div class="neu-form-actions">
                <button
                  type="button"
                  class="neu-form-btn neu-form-cancel"
                  onClick={() => setEditFieldLabel(undefined)}
                >
                  取消
                </button>
                <button
                  type="button"
                  class="neu-form-btn neu-form-primary"
                  onClick={() => {
                    editFieldAction?.(editFieldValue());
                    setEditFieldLabel(undefined);
                  }}
                >
                  确定
                </button>
              </div>
            </div>
          </div>
        </div>
      </Show>
      {dialog}
    </Show>
  );
}
