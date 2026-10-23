import styles from "./styles/settings-panel.module.css";
import {
  createSignal,
  createEffect,
  createMemo,
  For,
  Show,
  onCleanup,
  onMount,
} from "solid-js";
import { SlotMount } from "./slots/mount";
import type { AppState } from "@natalia/view-store";
import {
  describeRuntimeCapabilities,
  type ConfigV4,
  type RuntimeClient,
  type UiPanelRequirement,
} from "@anthelia/contracts";
import { NeuSelect } from "./components/NeuSelect";
import { PathBrowseButton } from "./path-browse-button";
import { hostFromSegments, rowsForHost } from "./settings-host-rows";
import {
  SETTINGS_CATEGORIES,
  SETTINGS_ROWS,
  rowsForCategory,
  UNSET_VALUE_LABEL,
  type SettingsRowSpec,
} from "./settings-rows";
import { useConfirmDialog } from "./components/ConfirmDialog";
import type { LocaleRuntime } from "./locale/runtime";

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
  t: (key: string) => string,
): ToolFamilyGroup[] {
  const selectedValues = new Set(splitCsv(selected));
  const registeredNames = new Set<string>();
  const byOwner = new Map<string, Set<string>>();
  for (const tool of registered) {
    const owner = tool.owner || t("settingsDlg.unownedOwner");
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
      label: t("settingsDlg.configuredUnregistered"),
      tools: missing.sort(),
    });
  return groups;
}

function ToolFamilyChecklist(props: {
  t: (key: string) => string;
  registered: readonly RegisteredToolView[];
  selected: string;
  onToggle(tools: readonly string[], selected: boolean): void;
}) {
  const selectedSet = createMemo(() => new Set(splitCsv(props.selected)));
  const groups = createMemo(() =>
    buildToolFamilyGroups(props.registered, props.selected, props.t),
  );
  return (
    <Show
      when={groups().length}
      fallback={
        <div class={styles.familyEmpty}>{props.t("settingsDlg.noTools")}</div>
      }
    >
      <div class={styles.familyList}>
        <For each={groups()}>
          {(group) =>
            group.id === "__configured__" ? (
              <div class={styles.family}>
                <div class={styles.familyTitle}>{group.label}</div>
                <div class={styles.selectGrid}>
                  <For each={group.tools}>
                    {(tool) => (
                      <label class={`neu-form-checkbox ${styles.check}`}>
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
    <label class={`neu-form-checkbox ${styles.familyCheck}`}>
      <input
        ref={checkbox}
        type="checkbox"
        checked={allSelected()}
        onChange={() => props.onToggle(props.group.tools, !allSelected())}
      />
      <span class={styles.familyName}>{props.group.label}</span>
      <span class={styles.familyCount}>
        {selectedCount()}/{props.group.tools.length}
      </span>
    </label>
  );
}

export type CategoryId =
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

/**
 * A rendered category: the active one and the rows it shows. The rows come
 * from settings-rows.ts; the panel's own pseudo-category ("插件配置") is
 * built at render time and carries no spec rows of its own.
 */
type Category = {
  id: CategoryId;
  label: string;
  labelKey: string;
  items: readonly SettingsRowSpec[];
};

/**
 * A nav entry. The category list carries no rows — rows are a property of
 * the ACTIVE category, computed by current(); putting them in the list is
 * what let the fabricated static values live there in the first place.
 */
type CategoryNavItem = {
  id: CategoryId;
  label: string;
  labelKey: string;
};

/**
 * The panel's own verbose gate — the browser console is the operator's.
 */
function verboseLog(...args: unknown[]) {
  if (
    (globalThis as { __NATALIA_PERF_VERBOSE?: number })
      .__NATALIA_PERF_VERBOSE === 1
  )
    console.log(...args);
}

export function SettingsPanel(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  slots: any;
  open: boolean;
  /** Fill the viewport instead of floating a window. */
  fullscreen?: boolean;
  /** Offered only when the host wires the toggle. */
  onToggleFullscreen?: () => void;
  onClose: () => void;
  /**
   * The category to show when the panel is opened by a caller that names one.
   *
   * The panel keeps the category the user last visited, which is right for the
   * settings button and wrong for a link that says "the model page": the model
   * controls send a user who has no model there directly, and landing them on
   * whatever they visited last would send them somewhere that does not answer
   * the click. Left unset, the panel behaves exactly as before.
   */
  category?: CategoryId;
  onOpenModels?: () => void;
  themeMode?: string;
  onCycleThemeMode?: () => void;
  /**
   * Shut the application down. REMOVED from the panel: the exit lives in the
   * tray, which is where a user who closed the window can actually reach it.
   * A settings row could not be the way out — it sat among toggles, and the
   * whole point of a tray exit is that it is the one affordance that survives
   * a hidden window.
   */
  state?: AppState;
  config?: ConfigV4;
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
  locale?: LocaleRuntime;
}) {
  const t = props.t;
  const slots = props.slots;
  const [activeCategory, setActiveCategory] = createSignal<CategoryId>("model");
  // Applied on OPENING: the remembered category stays the default for the
  // settings button, and a caller that named one gets it. Reading `props.open`
  // makes this fire on the closed -> open edge, not while the panel is open.
  createEffect(() => {
    const requested = props.category;
    if (props.open && requested) setActiveCategory(requested);
  });
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
  const effectiveConfig = (): ConfigV4 | undefined =>
    (ownConfig() as ConfigV4 | undefined) ?? props.config;
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
    props.onUpdateConfig || props.runtime?.updateConfig
      ? async (patch: Record<string, unknown>) => {
          // The app's writer when mounted with one — the app keeps its own
          // snapshot honest through it — else the runtime's own face. EITHER
          // WAY the panel re-reads afterwards, and the re-read is not optional:
          // `ownConfig` shadows `props.config` (the merge prefers the panel's
          // own view), so a write that leaves it stale keeps every row showing
          // its old value until the panel is closed and reopened — measured as
          // exactly that: the shell row still said 自动 after the human picked
          // bash, and only the open effect's re-read made it honest. The app's
          // callback updates the APP's snapshot; nothing updated the PANEL's.
          if (props.onUpdateConfig) await props.onUpdateConfig(patch);
          else
            await props.runtime?.updateConfig?.({
              patch,
              // The panel's OWN write scope, which every row used to drop: a
              // write without it defaults to "project", so a 自动 that deleted
              // the PROJECT's shell key left the human's choice sitting in the
              // GLOBAL file to show straight through — measured: the row said
              // 自动, the merged config still said bash, the pane still said
              // PS. The preference defaults to "global" because this panel is
              // the user's own settings, and the shell row's 自动 now deletes
              // the key where the choice actually lives.
              scope: runtimeWriteScope() as "project" | "global",
            });
          const next = await props.runtime?.configGet?.();
          // Our own view first (the rows read it), then the app's snapshot.
          if (next) setOwnConfig(next as never);
          if (next) props.onConfig?.(next as never);
        }
      : undefined;
  /** A config write's failure, shown in the panel rather than swallowed. */
  const [configError, setConfigError] = createSignal<string>();
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
  function localizePanelTitle(panel: { id: string; title?: string }): string {
    const key = `panel.${panel.id}`;
    const translated = t(key);
    return translated !== key ? translated : (panel.title ?? panel.id);
  }

  function localizePanelGroup(group?: string): string {
    if (!group) return t("settingsDlg.pluginGroup");
    const key = `panelGroup.${group}`;
    const translated = t(key);
    return translated !== key ? translated : group;
  }

  const groupedSettingsPanels = () => {
    const groups = new Map<string, ReturnType<typeof settingsPanels>>();
    for (const item of settingsPanels()) {
      const group = localizePanelGroup(item.panel.group);
      const list = groups.get(group) ?? [];
      list.push(item);
      groups.set(group, list);
    }
    return [...groups.entries()];
  };
  // The categories come from settings-rows.ts, which is also where each
  // row's label, description and value source live. The panel used to carry
  // its own `categories` array here — a second copy of every label, plus a
  // `value` field that was fabricated ("Opus 4", "3", "2 个"). Deriving the
  // list leaves one source of truth, and no place for an invented value to
  // live.
  const categoriesWithPlugins = (): CategoryNavItem[] =>
    settingsPanels().length
      ? [
          ...SETTINGS_CATEGORIES,
          {
            id: "plugin",
            label: "插件配置",
            labelKey: "settings.pluginCategory",
          },
        ]
      : [...SETTINGS_CATEGORIES];

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
  const current = (): Category => {
    const active = activeCategory();
    // The plugin pseudo-category has no rows in SETTINGS_ROWS; its rows come
    // from the plugin panels themselves.
    if (active === "plugin") {
      return {
        id: "plugin",
        label: "插件配置",
        labelKey: "settings.pluginCategory",
        items: [],
      };
    }
    const spec = SETTINGS_CATEGORIES.find((item) => item.id === active);
    if (!spec)
      return {
        id: SETTINGS_CATEGORIES[0]!.id,
        label: SETTINGS_CATEGORIES[0]!.label,
        labelKey: SETTINGS_CATEGORIES[0]!.labelKey,
        items: [],
      };
    return {
      id: spec.id,
      label: spec.label,
      labelKey: spec.labelKey,
      items: rowsForHost(rowsForCategory(spec.id), hostPlatform()),
    };
  };

  function modelLabel(config: ConfigV4): string {
    const model = config.defaultModel;
    if (!model) return t("settingsDlg.modelUnset");
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
  /**
   * The fixed answers this field accepts, when it has any. Absent means the
   * editor is a text box; present means it is that list — one dialog, two
   * input shapes, chosen by whether the value has a known set.
   */
  const [editFieldOptions, setEditFieldOptions] = createSignal<
    Array<{ value: string; label: string }> | undefined
  >(undefined);
  /**
   * Whether this field's editor offers a platform chooser, and which kind.
   * Absent means the value is typed; present means a path the runtime can pick,
   * and the text box stays beside the button so a path the chooser cannot
   * express is still enterable.
   */
  const [editFieldBrowse, setEditFieldBrowse] = createSignal<
    "directory" | "file" | undefined
  >(undefined);
  /**
   * A row-specific browse action, when filling the field is not the whole job.
   *
   * A comma-separated LIST appends the picked directory instead of replacing
   * the list with one entry, so it installs its own action and the default
   * "put the answer in the box" does not apply. Cleared whenever an editor
   * opens, so one row's action cannot leak into the next.
   */
  let browseFieldAction: (() => Promise<void>) | undefined;
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
    browse?: "directory" | "file",
  ) {
    setEditFieldLabel(label);
    setEditFieldValue(current);
    editFieldAction = apply;
    setEditFieldOptions(undefined);
    setEditFieldBrowse(browse);
    browseFieldAction = undefined;
  }

  /**
   * The same editor for a value that has a fixed set of answers.
   *
   * A text box for "which shell" invites a typo the runtime must then refuse,
   * and the legal answers are known right here. The options ride the same
   * dialog, so there is one editor rather than two shapes of one thing.
   */
  function openSelect(
    label: string,
    options: Array<{ value: string; label: string }>,
    current: string,
    apply: (value: string) => void,
  ) {
    setEditFieldLabel(label);
    setEditFieldValue(current);
    editFieldAction = apply;
    setEditFieldOptions(options);
    setEditFieldBrowse(undefined);
    browseFieldAction = undefined;
  }

  /**
   * The row-specific browse action, when filling the field is not the whole job.
   *
   * The shared `PathBrowseButton` calls this instead of writing the field, for a
   * comma-separated LIST that must APPEND the picked directory rather than
   * replace the list with one entry.
   */
  function installBrowseAction(action: () => Promise<void>) {
    browseFieldAction = action;
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
        t("settingsDlg.gitBashTitle"),
        current,
        (raw) => {
          const path = raw.trim();
          updateConfig?.({
            runtime: {
              ...effectiveConfig()?.runtime,
              // An empty string means "discover" — the resolver's configured
              // path is cleared, not set to a blank. The rest of the shell
              // section rides along: writing one row's value must not wipe the
              // other row's (both settings live in this one object).
              shell: { ...effectiveConfig()?.runtime?.shell, bashPath: path },
            },
          });
        },
        // A FILE, not a directory: the row names bash.exe. The text box stays
        // beside the chooser so a path the dialog cannot express (a wrapper
        // script, a path with a space the picker mangles) is still enterable.
        "file",
      );
    },
    "PowerShell 路径": () => {
      const current = effectiveConfig()?.runtime?.shell?.pwshPath ?? "";
      openEdit(
        t("settingsDlg.psPathTitle"),
        current,
        (raw) => {
          const path = raw.trim();
          updateConfig?.({
            runtime: {
              ...effectiveConfig()?.runtime,
              // Same rule as the Git Bash row, and the same reason: the section
              // holds both shell paths.
              shell: { ...effectiveConfig()?.runtime?.shell, pwshPath: path },
            },
          });
        },
        // A FILE, for the same reason as the Git Bash row: the row names
        // pwsh.exe.
        "file",
      );
    },
    "Shell 类型": () => {
      // WHICH shell runs a command, as distinct from WHERE each one lives (the
      // two path rows above).
      //
      // A choice here is SESSION-scoped and takes effect immediately: the
      // runtime moves the session's shell, projects it onto the environment the
      // executor seam reads, and tells the model through the
      // `context.instructions {kind: "shell_switch"}` record. It is not a
      // config write, because a workspace's own config outranks the global file
      // (so a global write was a silent no-op wherever the workspace pinned
      // one) and because a config write reloads the whole runtime — the user
      // would see a reload notice without anything moving.
      //
      // "自动" is a real answer, not a blank: it means the deployment's own
      // default, and it is what clearing the session's choice restores.
      const current = effectiveConfig()?.runtime?.shell?.executable ?? "auto";
      // PowerShell is a Windows shell. On Linux and macOS it is not offered at
      // all: `selectExecutor` answers bash there regardless, so a row that let a
      // human pick it would advertise a choice the runtime does not honour.
      // zsh is not offered anywhere: the runtime has no zsh support, and a
      // choice the product cannot honour reads as a choice (the UI-honesty
      // rule) — measured as "I picked zsh and got a bash".
      const isWindows = hostPlatform() === "win32";
      openSelect(
        t("settingsDlg.shellTitle"),
        [
          { value: "auto", label: t("settingsDlg.shellAuto") },
          ...(isWindows
            ? [{ value: "pwsh", label: "pwsh（PowerShell 7）" }]
            : []),
          { value: "bash", label: t("settingsDlg.bashWsl") },
        ],
        current,
        (value) => {
          // BOTH halves, because they answer different questions. The config
          // write is what the ROW reads, so without it the human switches the
          // shell and the row still shows the old value — which reads as "the
          // click did nothing". The session switch is what makes it HOT: it
          // records the choice in the slot the executor seam reads per call,
          // so the next command uses the new shell without a restart.
          //
          // 自动 sends `null`, not `undefined`: this patch crosses the RPC as
          // JSON, and `JSON.stringify` DROPS a key whose value is undefined —
          // the runtime then merged `{shell:{}}`, deleted nothing, and the
          // reload that follows re-pinned the previous choice (measured: the
          // row said 自动, the config still said bash, the pane still said
          // PS). `null` survives the wire; the runtime's updateConfig turns
          // it into the delete the merge understands.
          updateConfig?.({
            runtime: {
              ...effectiveConfig()?.runtime,
              shell: {
                ...effectiveConfig()?.runtime?.shell,
                ...(value === "auto"
                  ? { executable: null }
                  : { executable: value as "bash" | "pwsh" | "zsh" }),
              } as Record<string, unknown>,
            },
          });
          // EVERY value, 自动 included. The hot half used to be gated on
          // `value !== "auto"` while the route's whitelist rejected `auto`
          // anyway — so picking 自动 wrote the config and left the slot on the
          // old shell until the next start, which is exactly the restart the
          // row's title promises is not needed. `auto` is a real answer to the
          // contract: it clears the session's choice and the slot, and the
          // executor falls back to the platform's own shell.
          void props.runtime?.setSessionShell?.({
            shell: value as "bash" | "pwsh" | "zsh" | "auto",
          });
        },
      );
    },
    "子 Agent 并发数": () => {
      const current = String(effectiveConfig()?.team?.maxConcurrent ?? 4);
      openEdit(t("settingsDlg.subConcurrencyTitle"), current, (raw) => {
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
      openEdit(t("settingsDlg.maxStepsTitle"), current, (raw) => {
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
      openEdit(t("settingsDlg.maxRetryTitle"), current, (raw) => {
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
      openEdit(t("settingsDlg.timeoutTitle"), current, (raw) => {
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
      openEdit(t("settingsDlg.compactionThresholdTitle"), current, (raw) => {
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
      openEdit(
        t("settingsDlg.checkpointDirsTitle"),
        current,
        (raw) => {
          updateConfig?.({
            checkpoint: {
              ...effectiveConfig()?.checkpoint,
              additionalDirs: raw
                .split(",")
                .map((entry) => entry.trim())
                .filter(Boolean),
            },
          });
        },
        // A LIST, not one path. The chooser APPENDS rather than replacing, so
        // browsing for a second directory cannot silently drop the first —
        // which is what a shared "apply the text box" action would do, since
        // the box holds the whole comma-separated list and the picker returns
        // one entry. The two actions are therefore separate: 确定 writes the
        // list as typed, 浏览… adds one picked directory to it.
        "directory",
      );
      installBrowseAction(async () => {
        const picked = await props.runtime?.pickDirectory?.();
        if (typeof picked !== "string" || !picked) return;
        const existing = (
          effectiveConfig()?.checkpoint?.additionalDirs ?? []
        ).filter((entry) => entry && entry !== picked);
        updateConfig?.({
          checkpoint: {
            ...effectiveConfig()?.checkpoint,
            additionalDirs: [...existing, picked],
          },
        });
        setEditFieldLabel(undefined);
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
      t={props.t}
      registered={props.registeredTools ?? []}
      selected={selected}
      onToggle={(tools, select) =>
        toggleFamily(selected, tools, select, setter)
      }
    />
  );

  /**
   * The host platform, from the runtime's own status segment.
   *
   * `undefined` means the runtime never published one — and an unknown host is
   * not Windows, so a Windows-only choice stays hidden rather than shown on a
   * guess.
   */
  const [detectedHost, setDetectedHost] = createSignal<string | undefined>();
  createEffect(() => {
    if (!props.open || detectedHost()) return;
    void props.runtime
      ?.runtimeStatus?.()
      .then((snap) => {
        if (snap?.platform) setDetectedHost(snap.platform);
      })
      .catch(() => undefined);
  });

  function hostPlatform(): string | undefined {
    return hostFromSegments(props.state?.statusSegments) ?? detectedHost();
  }

  /**
   * The shell row's displayed value. 自动 is a REAL answer — the platform
   * default — not an absent one, so it must never fall through to
   * UNSET_VALUE_LABEL and read 「未配置」 as though nobody had decided.
   */
  function shellLabel(
    executable: "bash" | "pwsh" | "zsh" | "auto" | undefined,
  ): string {
    switch (executable) {
      case "pwsh":
        return "pwsh";
      case "bash":
        return "bash";
      case "zsh":
        return "zsh";
      default:
        return t("settingsDlg.auto");
    }
  }

  function runtimeValue(label: string): string | undefined {
    const config = effectiveConfig() as ConfigV4 | undefined;
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
          ? t("settingsDlg.unlimited")
          : String(retryCap);
      case "Request Timeout": {
        const seconds = config.runtime?.timeouts?.requestSec ?? 0;
        return seconds > 0 ? `${seconds}s` : t("settingsDlg.unsetTimeout");
      }
      case "Compaction":
        return config.context?.compactionEnabled
          ? t("settingsDlg.on")
          : t("settingsDlg.off");
      case "Compaction Threshold":
        return `${config.context?.compactionThresholdPercent ?? 85}%`;
      case "Checkpoint 目录":
        return t("settingsDlg.dirCount", {
          count: (config.checkpoint?.additionalDirs ?? []).length,
        });
      case "Git Bash 路径":
        return config.runtime?.shell?.bashPath || t("settingsDlg.autoDetect");
      case "PowerShell 路径":
        return config.runtime?.shell?.pwshPath || t("settingsDlg.autoDetect");
      case "Shell 类型":
        // The session's own choice when it has one, else the deployment's
        // configured shell, else 自动 — which is a REAL answer (the platform
        // default), not an absent one. A row with no case here falls through to
        // UNSET_VALUE_LABEL and reads 「未配置」, which claims nobody chose when
        // in fact "follow the platform" is what is in effect.
        return shellLabel(
          (config.runtime?.shell?.executable ?? "auto") as
            | "bash"
            | "pwsh"
            | "zsh"
            | "auto",
        );
      case "界面偏好保存范围":
        return uiWriteScope();
      case "运行时配置保存范围":
        return runtimeWriteScope();
    }
    return undefined;
  }

  return (
    <Show when={props.open}>
      {/* The settings surface is read, not glanced at, so it fills the
          viewport rather than floating a window over the shell. There is
          no outside to click, and no fullscreen toggle: the presentation
          is the only one, and a control that switches to the same thing
          is a control that does nothing. */}
      <div class="neu-settings-backdrop" data-fullscreen="true">
        <div class={styles.window} onClick={(event) => event.stopPropagation()}>
          <div class="neu-settings-header">
            <span class="neu-settings-title">{t("settingsDlg.title")}</span>
            <button
              type="button"
              class="neu-settings-close"
              onClick={props.onClose}
              aria-label={t("settingsDlg.closeAria")}
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
          <div class={styles.body}>
            <nav class={styles.categories}>
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
                    {t(category.labelKey)}
                  </button>
                )}
              </For>
            </nav>
            <section class={styles.content}>
              <Show when={current().id === "plugin"}>
                <div class={styles.contentTitle}>
                  {t("settings.pluginCategory")}
                </div>
                <For each={groupedSettingsPanels()}>
                  {([group, panels]) => (
                    <>
                      <Show when={group}>
                        <div class={styles.contentTitle}>{group}</div>
                      </Show>
                      <For each={panels}>
                        {(panel) => (
                          <div class={styles.pluginPanel}>
                            <button
                              type="button"
                              class={`${styles.item} ${styles.itemButton}`}
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
                              <div class={styles.itemMain}>
                                <span class={styles.itemLabel}>
                                  {localizePanelTitle(panel.panel)}
                                </span>
                                <span class={styles.itemDescription}>
                                  {localizePanelGroup(panel.panel.group)}
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
                                class={`${styles.item} ${styles.panelBody}`}
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
                  <div class={styles.contentTitle}>{t(current().labelKey)}</div>
                  <For each={current().items}>
                    {(item) => {
                      // A GETTER, not a const: `{value()}` in JSX is static
                      // text, so a const computed once freezes the cell at its
                      // first render — the write succeeded and the re-read
                      // answered the new value, and the row still showed the
                      // old one because nothing re-ran this expression. The
                      // getter re-runs whenever the config it reads changes.
                      //
                      // The fallback is "未配置", NOT the category's static
                      // value. That static value was the defect: a fresh
                      // install (no config yet) rendered a fabricated "Opus 4"
                      // for Default Model, a "3" for the concurrency whose real
                      // default is 4, and a "2 个" for checkpoint dirs that are
                      // empty by default — all of it indistinguishable from a
                      // real setting until the runtime's own answer arrived.
                      // An absent value says so; it does not invent one.
                      const value = () =>
                        runtimeValue(item.label) ?? t("settings.unset");
                      if (
                        item.label === "Providers & Models" &&
                        props.onOpenModels
                      ) {
                        return (
                          <button
                            type="button"
                            class={`${styles.item} ${styles.itemButton}`}
                            onClick={() => props.onOpenModels?.()}
                          >
                            <div class={styles.itemMain}>
                              <span class={styles.itemLabel}>
                                {t(item.labelKey)}
                              </span>
                              <span class={styles.itemDescription}>
                                {t(item.descKey)}
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
                      if (
                        item.label === "Theme Mode" &&
                        props.onCycleThemeMode
                      ) {
                        return (
                          <button
                            type="button"
                            class={`${styles.item} ${styles.itemButton}`}
                            onClick={() => props.onCycleThemeMode?.()}
                          >
                            <div class={styles.itemMain}>
                              <span class={styles.itemLabel}>
                                {t(item.labelKey)}
                              </span>
                              <span class={styles.itemDescription}>
                                {t(item.descKey)}
                              </span>
                            </div>
                            <span class={styles.itemValue}>
                              {props.themeMode === "dark"
                                ? t("settingsDlg.themeDark")
                                : t("settingsDlg.themeLight")}
                            </span>
                          </button>
                        );
                      }
                      if (item.label === "Language" && props.locale) {
                        const localeSnapshot = () => props.locale!.getLocale();
                        const activeLabel = () => {
                          const snap = localeSnapshot();
                          return (
                            snap.locales.find((l) => l.id === snap.active)
                              ?.label ?? snap.active
                          );
                        };
                        return (
                          <button
                            type="button"
                            class={`${styles.item} ${styles.itemButton}`}
                            onClick={() => {
                              const snap = localeSnapshot();
                              openSelect(
                                t(item.labelKey),
                                snap.locales.map((entry) => ({
                                  value: entry.id,
                                  label: entry.label,
                                })),
                                snap.active,
                                (next) => {
                                  props.locale?.setLocale(next);
                                },
                              );
                            }}
                          >
                            <div class={styles.itemMain}>
                              <span class={styles.itemLabel}>
                                {t(item.labelKey)}
                              </span>
                              <span class={styles.itemDescription}>
                                {t(item.descKey)}
                              </span>
                            </div>
                            <span class={styles.itemValue}>
                              {activeLabel()}
                            </span>
                          </button>
                        );
                      }
                      if (item.label === "运行中发送" && props.preferences) {
                        return (
                          <button
                            type="button"
                            class={`${styles.item} ${styles.itemButton}`}
                            onClick={() => {
                              const value =
                                busySendDelivery() === "next-step"
                                  ? ("next-turn" as const)
                                  : ("next-step" as const);
                              setBusySendDelivery(value);
                              props.preferences?.set("busySendDelivery", value);
                            }}
                          >
                            <div class={styles.itemMain}>
                              <span class={styles.itemLabel}>
                                {t(item.labelKey)}
                              </span>
                              <span class={styles.itemDescription}>
                                {t(item.descKey)}
                              </span>
                            </div>
                            <span class={styles.itemValue}>
                              {busySendDelivery() === "next-step"
                                ? t("settingsDlg.injectCurrent")
                                : t("settingsDlg.queueNext")}
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
                            class={`${styles.item} ${styles.itemButton}`}
                            onClick={() => {
                              const next =
                                !effectiveConfig()?.context?.compactionEnabled;
                              setConfigError("");
                              void updateConfig?.({
                                context: {
                                  ...effectiveConfig()?.context,
                                  compactionEnabled: next,
                                },
                              });
                            }}
                          >
                            <div class={styles.itemMain}>
                              <span class={styles.itemLabel}>
                                {t(item.labelKey)}
                              </span>
                              <span class={styles.itemDescription}>
                                {t(item.descKey)}
                              </span>
                            </div>
                            <span class={styles.itemValue}>{value()}</span>
                          </button>
                        );
                      }
                      if (editableActions[item.label] && updateConfig) {
                        return (
                          <button
                            type="button"
                            class={`${styles.item} ${styles.itemButton}`}
                            onClick={editableActions[item.label]}
                          >
                            <div class={styles.itemMain}>
                              <span class={styles.itemLabel}>
                                {t(item.labelKey)}
                              </span>
                              <span class={styles.itemDescription}>
                                {t(item.descKey)}
                              </span>
                            </div>
                            <span class={styles.itemValue}>{value()}</span>
                          </button>
                        );
                      }
                      return (
                        <div class={styles.item}>
                          <div class={styles.itemMain}>
                            <span class={styles.itemLabel}>
                              {t(item.labelKey)}
                            </span>
                            <span class={styles.itemDescription}>
                              {t(item.descKey)}
                            </span>
                          </div>
                          <span class={styles.itemValue}>{value()}</span>
                        </div>
                      );
                    }}
                  </For>
                </>
              </Show>
            </section>
            {/* A plugin's own settings section, after the shell's. */}
            <SlotMount slots={slots} name="settings.end" t={t} />
          </div>
          <div class={styles.footer}>
            <span class={styles.footerTitle}>Natalia</span>
            <span class={styles.footerSub}>{ACADEMIC_NAME}</span>
            <span class={styles.footerQuote}>
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
            class={`${styles.window} ${styles.editWindow}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div class="neu-settings-header">
              <span class="neu-settings-title">
                {t("settingsDlg.permissionListTitle")}
              </span>
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
            <div class={`${styles.body} ${styles.editBody}`}>
              <Show
                when={
                  Object.entries(effectiveConfig()?.agentModes ?? {}).filter(
                    ([name]) => !BUILTIN_PERMISSION_PROFILES.includes(name),
                  ).length
                }
                fallback={
                  <div class={styles.item}>
                    <div class={styles.itemMain}>
                      <span class={styles.itemLabel}>
                        {t("settingsDlg.noCustomProfiles")}
                      </span>
                      <span class={styles.itemDescription}>
                        {t("settingsDlg.noCustomProfilesHint")}
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
                    <div class={styles.permissionRow}>
                      <button
                        type="button"
                        class={`${styles.item} ${styles.itemButton}`}
                        onClick={() => {
                          updateConfig?.({
                            defaultAgentMode: name,
                            defaultPermission: name,
                          });
                        }}
                      >
                        <div class={styles.itemMain}>
                          <span class={styles.itemLabel}>
                            {name}
                            {effectiveConfig()?.defaultAgentMode === name
                              ? t("settingsDlg.defaultSuffix")
                              : ""}
                          </span>
                          <span class={styles.itemDescription}>
                            {profile.description || profile.approval}
                          </span>
                        </div>
                        <span class={styles.itemValue}>{profile.approval}</span>
                      </button>
                      <button
                        type="button"
                        class={styles.permissionEdit}
                        onClick={() => {
                          setPermissionListOpen(false);
                          openPermissionEditorFor(name);
                        }}
                      >
                        {t("settingsDlg.edit")}
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
                  {t("settingsDlg.newProfile")}
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
            class={`${styles.window} ${styles.editWindow}`}
            onClick={(event) => event.stopPropagation()}
          >
            <div class="neu-settings-header">
              <span class="neu-settings-title">
                {t("settingsDlg.profileEditorTitle")}
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
            <div class={`${styles.body} ${styles.editBody}`}>
              <div class="neu-form-field">
                <label class="neu-form-label">
                  {t("settingsDlg.profileName")}
                </label>
                <input
                  class="neu-form-input"
                  value={permissionName()}
                  onInput={(e) => setPermissionName(e.currentTarget.value)}
                />
              </div>
              <div class="neu-form-field">
                <label class="neu-form-label">
                  {t("settingsDlg.profileDesc")}
                </label>
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
                  {t("settingsDlg.allowedTools")}
                </label>
                {toolChecklist(
                  permissionAllowedTools(),
                  setPermissionAllowedTools,
                )}
              </div>
              <div class="neu-form-field">
                <label class="neu-form-label">
                  {t("settingsDlg.excludedTools")}
                </label>
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
                <label class="neu-form-label">
                  {t("settingsDlg.commandRules")}
                </label>
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
                  {t("settingsDlg.interactivePrograms")}
                </label>
                <div class="neu-checkbox-list">
                  <label class="neu-form-checkbox">
                    <input
                      type="checkbox"
                      checked={permissionInteractiveAny()}
                      onChange={() => setPermissionInteractiveAny((v) => !v)}
                    />
                    <span>{t("settingsDlg.allowAny")}</span>
                  </label>
                </div>
                <input
                  class="neu-form-input"
                  value={permissionInteractiveAllow()}
                  placeholder={t("settingsDlg.programsPh")}
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
                  {t("common.cancel")}
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
                  {t("settingsDlg.save")}
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
            class={`${styles.window} ${styles.editWindow}`}
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
            <div class={`${styles.body} ${styles.editBody}`}>
              <Show
                when={editFieldOptions()}
                fallback={
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
                }
              >
                <NeuSelect
                  value={editFieldValue()}
                  options={editFieldOptions()!}
                  onChange={(value) => setEditFieldValue(value)}
                />
              </Show>
              <div class="neu-form-actions">
                {/* The chooser rides the SAME action row as 取消/确定, not a row
                    of its own: a second `neu-form-actions` between the field
                    and the buttons added a whole line to every path editor. */}
                <Show when={editFieldBrowse()}>
                  {(kind) => (
                    <PathBrowseButton
                      t={props.t}
                      runtime={props.runtime}
                      kind={kind()}
                      onPick={(chosen) => {
                        // A row that needs more than "put the answer in the box"
                        // (a list that appends rather than replaces) installs
                        // its own action; everything else fills the field.
                        if (browseFieldAction) {
                          void browseFieldAction();
                          return;
                        }
                        setEditFieldValue(chosen);
                      }}
                    />
                  )}
                </Show>
                <button
                  type="button"
                  class="neu-form-btn neu-form-cancel"
                  onClick={() => setEditFieldLabel(undefined)}
                >
                  {t("common.cancel")}
                </button>
                <button
                  type="button"
                  class="neu-form-btn neu-form-primary"
                  onClick={() => {
                    editFieldAction?.(editFieldValue());
                    setEditFieldLabel(undefined);
                  }}
                >
                  {t("settingsDlg.confirm")}
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
