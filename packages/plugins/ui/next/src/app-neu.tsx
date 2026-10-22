import type { UiPluginContext } from "@natalia/ui-host";
import { selectPrimaryActivity } from "@natalia/view-store";
import type {
  ChatMessageRow,
  RuntimeModelCatalogEntry,
  RuntimeProjectedMessage,
  RuntimeSessionSummary,
  ChatModelProfile,
  ConfigV4,
  SessionID,
  WorkspaceSummary,
} from "@anthelia/contracts";
import { type AppState, cloneState } from "@natalia/view-store";
import { cloneStateInWorker } from "./clone-state-worker-client";
import { structuralClone } from "./structural-clone";
import type { ConfinementMode } from "@anthelia/contracts";
import { panelScopeKey } from "./panel-scope";
import {
  PERMISSION_RUNGS,
  availableRungs,
  rungFor,
  type PermissionRungID,
} from "./permission-rungs";
import {
  createSignal,
  createEffect,
  createMemo,
  createResource,
  onCleanup,
  onMount,
  batch,
  For,
  Show,
} from "solid-js";
import {
  ContextMeter,
  ImagePreviewHost,
  PagedTranscriptController,
  PendingBadge,
  Transcript,
  feedbackActions,
  feedbackToggle,
  toolCallRow,
  type Attachment,
  type ToolCall,
  type PagedTranscriptState,
  type TranscriptHandle,
} from "@natalia/ui-kit";
import type { UiPanelDefinition } from "@natalia/ui-host";
import { humanizeToolResult, pendingToolLink } from "@natalia/ui-model";
import { useConfirmDialog } from "./components/ConfirmDialog";
import { ModalLayer } from "./controllers/modals";
import { SessionSidebar } from "./controllers/session-tree";
import { MainPanes } from "./controllers/transcript";
import { RightRail } from "./controllers/workbench";
import { Topbar } from "./controllers/topbar";
import { createLocaleRuntime, type LocaleRuntime } from "./locale/runtime";
import { ToolCardRegistry } from "./tool-cards/registry";
import { createSlotsRegistry } from "./slots/registry";
import { CommandRegistry } from "./commands/registry";
import { CommandPalette } from "./controllers/command-palette";
import { SlotMount } from "./slots/mount";
import { transcriptRefs } from "./transcript-refs";
import { Composer, type ComposerAttachment } from "./components/Composer";
import { PendingTakeover } from "./components/PendingTakeover";
import { QueueDock } from "./components/QueueDock";
import { SessionUsageBar } from "./components/SessionUsageBar";
import { ReviewPane } from "./components/RightPanel";
import {
  SettingsPanel,
  type CategoryId,
  type RegisteredToolView,
} from "./settings-panel";
import {
  createUiPanelRequirementContext,
  uiPanelRequirementsSatisfied,
  type UiPanelRequirementContext,
} from "./ui-requirements";
import { PluginManagerPanel } from "./plugin-manager-panel";
import { applyNeuTheme, NATALIA_SKINS, NEU_THEME_MODES } from "./styles";
import { SessionActionsPanel } from "./session-actions-panel";
import { AgentPanel } from "./agent-panel";
import { PlanPanel } from "./plan-panel";
import { NiaPanel } from "./nia-panel";
import { WorkspacePanel } from "./workspace-panel";
import { WorkspaceSettingsPanel } from "./workspace-settings-panel";
import { NeuSelect } from "./components/NeuSelect";
import { StatusPanel } from "./status-panel";
import { SearchPanel } from "./search-panel";
import { HelpPanel } from "./help-panel";
import { StashPanel } from "./stash-panel";
import { SandboxPanel } from "./sandbox-panel";
import { GovernancePane, type GovernanceTab } from "./governance-panel";
import { ModelPanel } from "./model-panel";
import type { Message } from "./types";
import { parseGoalRoundPrompt } from "./goal-round";
import {
  collapseDuplicateTranscriptRows,
  dedupeTranscriptRowsById,
  stableRows,
  type RowSignature,
} from "./stable-rows";

const perfLog = (...args: unknown[]) => {
  if (
    (globalThis as { __NATALIA_PERF_VERBOSE?: number })
      .__NATALIA_PERF_VERBOSE === 1
  ) {
    console.warn(...args);
  }
};
const attachmentDataUrlCache = new Map<string, Promise<string>>();

type RightTab = string;

const GOVERNANCE_TABS: GovernanceTab[] = [
  "drift",
  "constitution",
  "decisions",
  "evidence",
  "completions",
  "workgraph",
  "notices",
  "growth",
  "eval",
];

/**
 * Read a deep-link parameter once. A host can open a specific governance view
 * (`?rightTab=governance&governance=decisions`) without scripted clicking — this
 * is also what the real-CEF smoke uses to exercise every tab.
 */
function queryParam(name: string): string | undefined {
  if (typeof window === "undefined") return undefined;
  try {
    return new URLSearchParams(window.location.search).get(name) ?? undefined;
  } catch {
    return undefined;
  }
}

const MIN_SIDEBAR_WIDTH = 180;
const MAX_SIDEBAR_WIDTH = 360;
const MIN_RIGHT_WIDTH = 440;
const MAX_RIGHT_WIDTH = 560;

/**
 * How many times the secondary startup data is fetched, and the pause
 * between attempts. The first attempt races the runtime's own startup on
 * a fresh install, so one failure is expected rather than exceptional;
 * three attempts a second apart covers a runtime that is still loading
 * without making a genuinely dead one wait four seconds to say so.
 */
const SECONDARY_STARTUP_ATTEMPTS = 3;
const SECONDARY_STARTUP_RETRY_MS = 1_000;

/**
 * How long one startup SOURCE may take before it is reported as failed.
 *
 * The five sources are independent and Promise.all waits for all of them, so
 * one that never settles holds the whole batch and the window shows its
 * loading surface forever — which is what happened, with the runtime
 * answering everything else perfectly. A rejected source already had a path
 * to the "unavailable" state; an unanswered one had none, so it is bounded
 * here.
 *
 * TWENTY SECONDS, and the bound is not free: it must exceed the SLOWEST
 * answer the server can legitimately give for one of these sources, or a
 * correct answer gets reported as no answer. Two of the five go through a
 * runtime worker whose own deadline is 15s
 * (`runtimeWorkerTaskTimeoutMs`, packages/framework/substrate), and both
 * still answer after it: `plugins()` catches the worker's failure and
 * projects inline (extensions-runtime.ts), and the model catalog is built
 * inline. At the 10s this bound used to be, the UI gave up five seconds
 * BEFORE the server it was waiting on. Move this whenever that deadline
 * moves.
 */
const SECONDARY_STARTUP_SOURCE_TIMEOUT_MS = 20_000;

function sessionTurnID(messageID: string) {
  if (!messageID.startsWith("turn_")) return undefined;
  return messageID.replace(/:(?:user|assistant|thinking|system)$/u, "");
}

function rightPanelMaxWidth(): number {
  if (typeof window === "undefined") return MAX_RIGHT_WIDTH;
  // On small/compact layouts the right panel is the most space-hungry
  // surface (terminal/diff), so allow it to take up to 2/3 width.
  return Math.max(MIN_RIGHT_WIDTH, Math.floor((window.innerWidth * 2) / 3));
}

export type GoalEditorTarget = {
  goalID: string;
  revision: number;
  objective: string;
  maxGoalRounds: number;
};

export function AppNeu(props: { ctx: UiPluginContext }) {
  const appNeuStart = performance.now();
  perfLog(
    `[perf] AppNeu component start +${(appNeuStart - ((globalThis as unknown as { __nataliaStartupStart?: number }).__nataliaStartupStart ?? appNeuStart)).toFixed(1)}ms`,
  );
  // The locale runtime is the shell's single source of truth for product
  // copy. It rides ctx.extra so every UI plugin can register its own
  // dictionaries under its own namespace and switch together with the
  // shell.
  const locale = createLocaleRuntime(props.ctx.preferences);
  (props.ctx.extra as { locale?: LocaleRuntime }).locale = locale;
  const t = locale.t;
  // The tool card registry is the second plugin-facing seat on
  // ctx.extra: a tool (or its plugin) registers its own card under its
  // tool name, and the transcript prefers it over the shared renderers.
  const toolCards = new ToolCardRegistry();
  (props.ctx.extra as { toolCards?: ToolCardRegistry }).toolCards = toolCards;
  // The slot registry is the third plugin-facing seat on ctx.extra: a UI
  // plugin fills a named shell slot instead of the shell growing a branch.
  // The command registry is the fourth plugin-facing seat: the Ctrl+K
  // palette reads the shell commands and every plugin own.
  const commands = new CommandRegistry();
  (props.ctx.extra as { commands?: CommandRegistry }).commands = commands;
  commands.register({
    id: "shell.settings",
    title: t("palette.cmd.settings"),
    keywords: ["settings", "preferences"],
    run: () => setSettingsOpen(true),
  });
  commands.register({
    id: "shell.search",
    title: t("palette.cmd.search"),
    keywords: ["search", "find"],
    run: () => setSearchOpen(true),
  });
  commands.register({
    id: "shell.help",
    title: t("palette.cmd.help"),
    keywords: ["help", "shortcuts"],
    run: () => setHelpOpen(true),
  });
  commands.register({
    id: "shell.status",
    title: t("palette.cmd.status"),
    keywords: ["status", "diagnostics"],
    run: () => setStatusOpen(true),
  });
  commands.register({
    id: "shell.toggleLeft",
    title: t("palette.cmd.toggleLeft"),
    keywords: ["left", "sidebar"],
    run: () => setLeftVisible((value) => !value),
  });
  commands.register({
    id: "shell.toggleRight",
    title: t("palette.cmd.toggleRight"),
    keywords: ["right", "rail"],
    run: () => setRightVisible((value) => !value),
  });
  commands.register({
    id: "shell.language",
    title: t("palette.cmd.language"),
    keywords: ["language", "locale", "语言"],
    run: () =>
      locale.setLocale(locale.getLocale().active === "zh-CN" ? "en" : "zh-CN"),
  });
  const slots = createSlotsRegistry();
  (
    props.ctx.extra as { slots?: ReturnType<typeof createSlotsRegistry> }
  ).slots = slots;
  const [state, setState] = createSignal(
    cloneState(props.ctx.projection.getState()),
  );
  const requestedRightTab = queryParam("rightTab") ?? queryParam("tab");
  const [rightTab, setRightTab] = createSignal<RightTab>(
    requestedRightTab &&
      ["diff", "plan", "governance", "nia", "agent"].includes(requestedRightTab)
      ? requestedRightTab
      : "plan",
  );
  const requestedGovernanceTab = queryParam("governance");
  const governanceInitialTab =
    requestedGovernanceTab &&
    GOVERNANCE_TABS.includes(requestedGovernanceTab as GovernanceTab)
      ? (requestedGovernanceTab as GovernanceTab)
      : undefined;
  const [leftWidth, setLeftWidth] = createSignal(240);
  const [rightWidth, setRightWidth] = createSignal(
    typeof window === "undefined"
      ? 440
      : Math.max(MIN_RIGHT_WIDTH, Math.floor(window.innerWidth / 3)),
  );
  const [resizing, setResizing] = createSignal(false);
  const [leftVisible, setLeftVisible] = createSignal(true);
  const [rightVisible, setRightVisible] = createSignal(true);
  const [layoutMode, setLayoutMode] = createSignal<"wide" | "compact" | "tiny">(
    "wide",
  );
  const [naviOpen, setNaviOpen] = createSignal(true);
  const [mainDraft, setMainDraft] = createSignal("");
  const [chatDraft, setChatDraft] = createSignal("");
  const [mainAttachments, setMainAttachments] = createSignal<
    ComposerAttachment[]
  >([]);
  const [chatAttachments, setChatAttachments] = createSignal<
    ComposerAttachment[]
  >([]);
  const [selectedSession, setSelectedSession] = createSignal("");
  const [selectedSessionID, setSelectedSessionID] = createSignal("");
  const [sessionList, setSessionList] = createSignal<RuntimeSessionSummary[]>(
    [],
  );
  const [workspaces, setWorkspaces] = createSignal<WorkspaceSummary[]>([]);
  const [registeredTools, setRegisteredTools] = createSignal<
    RegisteredToolView[]
  >([]);
  const [panelRequirementContext, setPanelRequirementContext] = createSignal<
    UiPanelRequirementContext | undefined
  >(undefined);
  const [settingsOpen, setSettingsOpen] = createSignal(false);
  /**
   * The settings page a caller asked for when it opened the panel.
   *
   * The four model controls need somewhere to send a user who has no model to
   * choose: with no provider configured their menu would be empty, so clicking
   * one opens the model page of the settings instead of showing a list of
   * nothing. The panel keeps its own remembered category for every other
   * opener, so this is cleared when it closes — a request, not a new default.
   */
  const [settingsCategory, setSettingsCategory] = createSignal<CategoryId>();
  const openModelSettings = () => {
    setSettingsCategory("model");
    setSettingsOpen(true);
  };
  const [pluginManagerOpen, setPluginManagerOpen] = createSignal(false);
  const [themeMode, setThemeMode] = createSignal(
    props.ctx.preferences.get<string>("themeMode") ?? "light",
  );
  const layoutProfile = () => NATALIA_SKINS[themeMode()]?.layout;

  createEffect(() => {
    const layout = layoutProfile();
    const left = layout?.regions?.left;
    const right = layout?.regions?.right;
    if (left?.width) setLeftWidth(left.width);
    if (right?.width) setRightWidth(right.width);
    if (left?.visible !== undefined) setLeftVisible(left.visible);
    if (right?.visible !== undefined) setRightVisible(right.visible);
    if (right?.order?.[0]) {
      const first = right.order[0] as RightTab;
      if (rightTabs().some((tab) => tab.id === first)) setRightTab(first);
    }
  });
  const [sessionMenuOpen, setSessionMenuOpen] = createSignal(false);
  const [showArchived, setShowArchived] = createSignal(false);
  const [sessionSearchOpen, setSessionSearchOpen] = createSignal(false);
  const [sessionQuery, setSessionQuery] = createSignal("");
  const [sidebarMenuOpen, setSidebarMenuOpen] = createSignal(false);
  const [bulkSelectMode, setBulkSelectMode] = createSignal(false);
  const [bulkSelected, setBulkSelected] = createSignal<Set<string>>(new Set());
  const [workspaceOpen, setWorkspaceOpen] = createSignal(false);
  const [workspaceSettingsOpen, setWorkspaceSettingsOpen] = createSignal(false);
  const [settingsWorkspaceID, setSettingsWorkspaceID] = createSignal<
    string | undefined
  >(undefined);
  const [workspaceError, setWorkspaceError] = createSignal<string>("");
  const [reviewRequestedTab, setReviewRequestedTab] = createSignal<
    "git" | "sandbox" | "checkpoint"
  >("git");
  const [reviewRequestedCheckpointID, setReviewRequestedCheckpointID] =
    createSignal<string | undefined>();
  // The composer takeover (R4(a)(c)): while a request waits it replaces the
  // composer, and minimizing leaves a persistent count rather than vanishing.
  const [pendingTakeoverMinimized, setPendingTakeoverMinimized] =
    createSignal(false);
  const [pendingTakeoverFocus, setPendingTakeoverFocus] = createSignal<
    string | undefined
  >(undefined);
  const pendingTakeoverCount = createMemo(() => {
    return (
      state().pendingApprovals.length +
      state().pendingQuestions.length +
      state().pendingInteractives.length
    );
  });
  const [pendingRollback, setPendingRollback] = createSignal<
    | {
        turnID: string;
        checkpointID?: string;
        label: string;
        hiddenAfter?: number;
      }
    | undefined
  >();
  const [rollbackNotice, setRollbackNotice] = createSignal<
    | {
        text: string;
        safetyCheckpointID?: string;
      }
    | undefined
  >();
  const [panelRevision, setPanelRevision] = createSignal(0);
  const [transcriptHistoryLoading, setTranscriptHistoryLoading] =
    createSignal(true);
  const [transcriptOlderLoading, setTranscriptOlderLoading] =
    createSignal(false);
  let historyReplayDone = false;
  let userSelectedSession = false;
  let sessionsRefreshToken = 0;
  let sessionsRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let workspacesRefreshTimer: ReturnType<typeof setTimeout> | undefined;
  let sessionsRefreshInFlight: Promise<void> | undefined;
  let workspacesRefreshInFlight: Promise<void> | undefined;
  const naviPager = new PagedTranscriptController<ChatMessageRow>({
    pageSize: 100,
    onPage: (page, direction) => {
      props.ctx.projection.hydrateNaviMessages?.(
        page.data,
        direction === "initial" ? { replace: true } : { direction },
      );
    },
  });
  const niaPager = new PagedTranscriptController<ChatMessageRow>({
    pageSize: 100,
    onPage: (page, direction) => {
      props.ctx.projection.hydrateNiaMessages?.(
        page.data,
        direction === "initial" ? { replace: true } : { direction },
      );
    },
  });
  const [naviPaging, setNaviPaging] = createSignal<PagedTranscriptState>(
    naviPager.snapshot(),
  );
  const [niaPaging, setNiaPaging] = createSignal<PagedTranscriptState>(
    niaPager.snapshot(),
  );
  onCleanup(naviPager.subscribe(() => setNaviPaging(naviPager.snapshot())));
  function chatPageSource(
    channel: "navi" | "nia",
    sessionID: string | undefined,
    input: { cursor?: string; limit: number },
  ) {
    if (!sessionID) return Promise.resolve({ data: [], cursor: {} });
    const surface =
      channel === "navi"
        ? props.ctx.runtime.naviChat
        : props.ctx.runtime.niaChat;
    if (surface?.messagesPage)
      return surface.messagesPage({
        sessionID,
        limit: input.limit,
        ...(input.cursor ? { cursor: input.cursor } : {}),
      });
    return Promise.resolve(surface?.messages?.(sessionID)).then((data) => ({
      data: data ?? [],
      cursor: {},
    }));
  }

  function naviChatPageSource(input: { cursor?: string; limit: number }) {
    return chatPageSource(
      "navi",
      selectedSessionID() || state().sessionID,
      input,
    );
  }

  function niaChatPageSource(input: { cursor?: string; limit: number }) {
    return chatPageSource(
      "nia",
      selectedSessionID() || state().sessionID,
      input,
    );
  }

  async function loadOlderNaviChat() {
    await naviPager.loadOlder();
    setState(cloneState(props.ctx.projection.getState()));
  }

  async function loadOlderNiaChat() {
    await niaPager.loadOlder();
    setState(cloneState(props.ctx.projection.getState()));
  }

  function mainTranscriptPageSource(
    sessionID: string | undefined,
    input: { cursor?: string; limit: number },
  ) {
    if (!sessionID || !props.ctx.runtime.messages)
      return Promise.resolve({ data: [], cursor: {} });
    return props.ctx.runtime.messages({
      sessionID,
      limit: input.limit,
      ...(input.cursor ? { cursor: input.cursor } : {}),
    });
  }

  const mainPager = new PagedTranscriptController<RuntimeProjectedMessage>({
    pageSize: 100,
    onPage: (page, direction) => {
      props.ctx.projection.hydrateMessages?.(
        [...page.data].reverse(),
        direction === "initial" ? "newer" : direction,
        { replace: direction === "initial" },
      );
    },
  });
  const [mainPaging, setMainPaging] = createSignal<PagedTranscriptState>(
    mainPager.snapshot(),
  );
  onCleanup(mainPager.subscribe(() => setMainPaging(mainPager.snapshot())));
  onCleanup(() => mainPager.dispose());

  onCleanup(niaPager.subscribe(() => setNiaPaging(niaPager.snapshot())));
  onCleanup(() => naviPager.dispose());
  onCleanup(() => niaPager.dispose());

  const [statusOpen, setStatusOpen] = createSignal(false);
  const [turnElapsedMs, setTurnElapsedMs] = createSignal(0);
  const [showJumpToBottom, setShowJumpToBottom] = createSignal(false);
  const [chatShowJumpToBottom, setChatShowJumpToBottom] = createSignal(false);
  let transcriptApi: TranscriptHandle | undefined;
  let chatTranscriptApi: TranscriptHandle | undefined;
  const [chatElapsedMs, setChatElapsedMs] = createSignal(0);

  function scrollMainTranscriptToBottom() {
    transcriptRefs.main?.scrollToBottom();
  }

  function scrollChatTranscriptToBottom() {
    transcriptRefs.chat?.scrollToBottom();
  }

  // --- Goal status-bar controls: one pause/resume toggle + inline editor ---
  const [goalEditOpen, setGoalEditOpen] = createSignal(false);
  const [goalEditObjective, setGoalEditObjective] = createSignal("");
  const [goalEditCap, setGoalEditCap] = createSignal("");
  const [goalNotice, setGoalNotice] = createSignal("");
  const [goalBusy, setGoalBusy] = createSignal(false);
  let goalNoticeTimer: ReturnType<typeof setTimeout> | undefined;

  function goalTargetSessionID(): string | undefined {
    return selectedSessionID() || state().sessionID;
  }

  function flashGoalNotice(message: string) {
    setGoalNotice(message);
    if (goalNoticeTimer) clearTimeout(goalNoticeTimer);
    goalNoticeTimer = setTimeout(() => setGoalNotice(""), 4000);
  }

  async function runGoalControl(
    action: "pause" | "resume" | "clear",
  ): Promise<void> {
    const sessionID = goalTargetSessionID();
    if (!sessionID) return;
    setGoalBusy(true);
    try {
      const result = await props.ctx.runtime.goalControl?.(action, sessionID);
      if (result && !result.ok)
        flashGoalNotice(result.message ?? `goal ${action} refused`);
      else if (action === "clear") setGoalEditOpen(false);
    } catch (error) {
      flashGoalNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setGoalBusy(false);
    }
  }

  function openGoalEditor(goal: GoalEditorTarget) {
    setGoalEditObjective(goal.objective);
    setGoalEditCap(goal.maxGoalRounds === 0 ? "" : String(goal.maxGoalRounds));
    setGoalEditOpen(true);
  }

  async function saveGoalEditor(goal: GoalEditorTarget): Promise<void> {
    const sessionID = goalTargetSessionID();
    if (!sessionID) return;
    const objective = goalEditObjective().trim();
    if (!objective) {
      flashGoalNotice("goal objective must not be empty");
      return;
    }
    const capRaw = goalEditCap().trim();
    const maxGoalRounds = capRaw === "" ? undefined : Number(capRaw);
    if (
      maxGoalRounds !== undefined &&
      (!Number.isInteger(maxGoalRounds) || maxGoalRounds < 0)
    ) {
      flashGoalNotice("round cap must be a non-negative integer");
      return;
    }
    if (objective === goal.objective && maxGoalRounds === undefined) {
      setGoalEditOpen(false);
      return;
    }
    setGoalBusy(true);
    try {
      const result = await props.ctx.runtime.goalEdit?.(
        {
          goalID: goal.goalID,
          revision: goal.revision,
          ...(objective !== goal.objective ? { objective } : {}),
          ...(maxGoalRounds !== undefined ? { maxGoalRounds } : {}),
        },
        sessionID,
      );
      if (result && !result.ok) {
        flashGoalNotice(result.message ?? "goal edit refused");
        return;
      }
      setGoalEditOpen(false);
    } catch (error) {
      flashGoalNotice(error instanceof Error ? error.message : String(error));
    } finally {
      setGoalBusy(false);
    }
  }

  /**
   * The turn clock's start.
   *
   * The durable start is the projection's own `activeTurnStartedAt` (the turn's
   * `turn.submitted.at`), which is what this reads. The local signal is a
   * fallback for a turn that carries no start — a journal written before the
   * field existed — and it is keyed by turn id (`legacyTurnStartKey`) so that
   * switching sessions neither restarts a running turn's clock (the old
   * "first time I saw activeTurn" heuristic set it on every switch) nor shows
   * another session's elapsed time as this one's.
   */
  const activeTurnStartedAt = createSignal<number | undefined>(undefined);
  const [activeTurnStartedAtValue, setActiveTurnStartedAt] =
    activeTurnStartedAt;
  const [legacyTurnStartKey, setLegacyTurnStartKey] = createSignal<
    string | undefined
  >(undefined);
  /** The start the running clock counts from, or undefined when unknown. */
  const turnStartAt = () =>
    state().activeTurnStartedAt ?? activeTurnStartedAtValue();
  const [modelOpen, setModelOpen] = createSignal(false);
  const [modelCatalog, setModelCatalog] = createSignal<
    RuntimeModelCatalogEntry[]
  >([]);
  const [modelSelectionSignal, setModelSelectionSignal] = createSignal<
    { modelID?: string; variant?: string } | undefined
  >(undefined);
  const [config, setConfig] = createSignal<ConfigV4 | undefined>(undefined);
  /**
   * Whether the startup data is KNOWN to be missing, as opposed to merely
   * not arrived yet. The permission dropdown reads it: an empty menu that
   * says nothing is indistinguishable from "this config has no modes",
   * and the config always has three (the schema default) — so an empty
   * dropdown is a delivery failure and has to look like one.
   */
  const [startupDataDegraded, setStartupDataDegraded] = createSignal(false);
  // Empty until the runtime says otherwise: the effort has no schema default
  // (it is a five-value union), so a pre-filled "medium" displayed a choice
  // nobody made. The select's placeholder is what an unset effort shows — the
  // control is unchanged, only the value it claims is now true.
  const [reasoningEffort, setReasoningEffortSignal] = createSignal<string>("");
  const [chatProfile, setChatProfile] = createSignal<ChatModelProfile>({});
  const [searchOpen, setSearchOpen] = createSignal(false);
  const [paletteOpen, setPaletteOpen] = createSignal(false);
  // The settings window fills the viewport when this preference is on.
  const [settingsFullscreen, setSettingsFullscreen] = createSignal(
    props.ctx.preferences?.get<boolean>("uiSettingsFullscreen") ?? false,
  );
  const toggleSettingsFullscreen = () =>
    setSettingsFullscreen((value) => {
      const next = !value;
      props.ctx.preferences?.set("uiSettingsFullscreen", next);
      return next;
    });
  const [helpOpen, setHelpOpen] = createSignal(false);
  const [stashOpen, setStashOpen] = createSignal(false);
  const [sandboxOpen, setSandboxOpen] = createSignal(false);
  const [topbarPanel, setTopbarPanel] = createSignal<{
    pluginId: string;
    panelId: string;
  } | null>(null);
  const [moreOpen, setMoreOpen] = createSignal(false);
  const { confirm, alert, dialog } = useConfirmDialog(t);
  const [viewOpen, setViewOpen] = createSignal(false);
  let topbarPanelRef: HTMLDivElement | undefined;

  async function refreshModelConfig() {
    if (!props.ctx.runtime.configGet) {
      throw new Error("configGet runtime method unavailable");
    }
    if (!props.ctx.runtime.modelCatalog) {
      throw new Error("modelCatalog runtime method unavailable");
    }
    const [nextConfig, nextCatalog] = await Promise.all([
      props.ctx.runtime.configGet(),
      props.ctx.runtime.modelCatalog(),
    ]);
    setConfig(nextConfig);
    setModelCatalog(nextCatalog);
  }

  let projectionFramePending = false;
  let suppressProjectionClones = false;
  /**
   * The snapshot this component handed Solid last frame.
   *
   * The structural clone reuses THIS frame's unchanged branches by identity,
   * which is what keeps the transcript's rows mounted: Solid's `<For>` keys by
   * element identity, so a full deep clone per animation frame rebuilt every
   * visible row while the model streamed (the card toolbar flickered under the
   * cursor, and a click landed on a node that had been replaced between
   * mousedown and mouseup — the image preview never opened). `undefined` until
   * the first frame, and stale after any direct `setState` (a session switch, a
   * hydration), which only costs one full clone.
   */
  let lastProjectedSnapshot: AppState | undefined;
  onCleanup(
    props.ctx.projection.subscribe((next) => {
      const replaying = (
        globalThis as unknown as {
          __nataliaReplayingHistory?: boolean;
        }
      ).__nataliaReplayingHistory;
      // During a full history replay the projection emits one event at a time.
      // Cloning the whole AppState after every raw event is O(n^2) for long
      // sessions, so skip the heavy clones until the replay completes and then
      // take one final snapshot in openUnresolvedInteractives.
      if (replaying || suppressProjectionClones) return;
      // Live events stream as many small deltas per second. Clone the
      // projection at most once per animation frame and let Solid paint one
      // batched frame instead of one clone/update per raw event.
      if (projectionFramePending) return;
      projectionFramePending = true;
      requestAnimationFrame(() => {
        projectionFramePending = false;
        void (async () => {
          let projected: AppState;
          const live = props.ctx.projection.getState();
          try {
            projected = lastProjectedSnapshot
              ? structuralClone(lastProjectedSnapshot, live)
              : await cloneStateInWorker(live);
          } catch {
            projected = lastProjectedSnapshot
              ? structuralClone(lastProjectedSnapshot, live)
              : cloneState(live);
          }
          lastProjectedSnapshot = projected;
          const setStart = performance.now();
          setState(projected);
          const setMs = performance.now() - setStart;
          perfLog(
            `[perf] renderer projection frame messages=${projected.messages.length} navi=${projected.navi.messages.length} nia=${projected.nia.messages.length} set=${setMs.toFixed(1)}ms`,
          );
          if (projected.workspaces.length)
            mergeProjectedWorkspaces(projected.workspaces);
          const currentTurn = projected.activeTurn;
          // The turn's durable start is the projection's; the local signal only
          // remembers a turn that carries none (a journal written before the
          // field existed), and it is keyed by the turn id so switching sessions
          // neither restarts a running turn's clock nor shows another session's
          // elapsed time as this one's.
          const durableStart = projected.activeTurnStartedAt;
          if (currentTurn && durableStart === undefined) {
            if (legacyTurnStartKey() !== currentTurn) {
              setLegacyTurnStartKey(currentTurn);
              setActiveTurnStartedAt(Date.now());
            }
          } else if (!currentTurn) {
            setLegacyTurnStartKey(undefined);
            setActiveTurnStartedAt(undefined);
            setTurnElapsedMs(0);
          }
        })();
      });
    }),
  );

  async function refreshWorkspaces() {
    if (workspacesRefreshInFlight) return workspacesRefreshInFlight;
    const phaseStart = performance.now();
    workspacesRefreshInFlight = (async () => {
      const roots = await props.ctx.runtime.workspaceRoots?.();
      perfLog(
        `[perf] refreshWorkspaces done roots=${roots?.length ?? 0} +${(performance.now() - phaseStart).toFixed(1)}ms`,
      );
      if (roots) {
        const current = workspaces();
        if (!current || JSON.stringify(current) !== JSON.stringify(roots)) {
          setWorkspaces(roots);
        }
      }
    })().finally(() => {
      workspacesRefreshInFlight = undefined;
    });
    return workspacesRefreshInFlight;
  }

  function mergeProjectedWorkspaces(projected: WorkspaceSummary[]) {
    setWorkspaces((current) => {
      const byID = new Map(
        current.map((workspace) => [workspace.workspaceID, workspace]),
      );
      for (const workspace of projected) {
        const existing = byID.get(workspace.workspaceID);
        byID.set(
          workspace.workspaceID,
          existing ? { ...existing, ...workspace } : workspace,
        );
      }
      return [...byID.values()];
    });
  }

  function markStartup(phase: string) {
    const global = globalThis as unknown as {
      __nataliaStartupStart?: number;
      __nataliaStartupTimings?: Record<string, number>;
    };
    global.__nataliaStartupStart ??= performance.now();
    const timings = (global.__nataliaStartupTimings ??= {});
    const elapsed = performance.now() - global.__nataliaStartupStart;
    timings[phase] = elapsed;
    perfLog(`[startup] ${phase} +${elapsed.toFixed(1)}ms`);
  }

  function logStartupSummary() {
    (
      globalThis as unknown as {
        __nataliaStartupComplete?: boolean;
      }
    ).__nataliaStartupComplete = true;
    perfLog("[web-ui] startup complete");
  }

  async function loadAttachmentUrl(attachment: Attachment) {
    const sessionID = selectedSessionID() || state().sessionID;
    const key =
      attachment.id && sessionID
        ? `${sessionID}:${attachment.id}`
        : `path:${attachment.path}`;
    const cached = attachmentDataUrlCache.get(key);
    if (cached) return cached;
    const load = Promise.resolve(
      props.ctx.runtime.attachmentDataUrl?.({
        ...(attachment.id && sessionID
          ? { attachmentID: attachment.id, sessionID }
          : {}),
        path: attachment.path,
        mediaType: attachment.mediaType ?? "image/png",
      }),
    )
      .then((result) => result ?? "")
      .catch((error) => {
        attachmentDataUrlCache.delete(key);
        throw error;
      });
    attachmentDataUrlCache.set(key, load);
    return load;
  }

  function handlePasteAttachments(
    event: ClipboardEvent,
    current: ComposerAttachment[],
    setAttachments: (value: ComposerAttachment[]) => void,
  ) {
    const items = Array.from(event.clipboardData?.items ?? []);
    const files = items
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        const base64 = dataUrl.split(",")[1];
        if (!base64) return;
        void props.ctx.runtime
          .uploadAttachment?.({
            name: file.name || "attachment",
            mediaType: file.type || "application/octet-stream",
            data: base64,
          })
          .then((attachment) => {
            setAttachments([
              ...current,
              {
                path: attachment.path,
                name: attachment.filename,
                ...(file.type.startsWith("image/")
                  ? { previewUrl: dataUrl }
                  : {}),
              },
            ]);
          });
      };
      reader.readAsDataURL(file);
    }
  }

  function debouncedRefreshWorkspaces(delay = 1000) {
    if (workspacesRefreshTimer) clearTimeout(workspacesRefreshTimer);
    workspacesRefreshTimer = setTimeout(() => {
      workspacesRefreshTimer = undefined;
      runIdle(() => void refreshWorkspaces());
    }, delay);
  }

  function sessionRecency(session: RuntimeSessionSummary) {
    return new Date(session.lastAccessedAt ?? session.createdAt).getTime();
  }

  function debouncedRefreshSessions(delay = 1000) {
    if (sessionsRefreshTimer) clearTimeout(sessionsRefreshTimer);
    sessionsRefreshTimer = setTimeout(() => {
      sessionsRefreshTimer = undefined;
      runIdle(() => void refreshSessions());
    }, delay);
  }

  async function refreshSessions() {
    if (sessionsRefreshInFlight) return sessionsRefreshInFlight;
    const phaseStart = performance.now();
    const token = ++sessionsRefreshToken;
    let operation: Promise<void>;
    operation = (async () => {
      try {
        const sessions = await props.ctx.runtime.sessionList?.();
        perfLog(
          `[perf] refreshSessions done count=${sessions?.length ?? 0} +${(performance.now() - phaseStart).toFixed(1)}ms`,
        );
        if (token !== sessionsRefreshToken) return;
        if (sessions) {
          const current = sessionList();
          if (
            !current ||
            JSON.stringify(current) !== JSON.stringify(sessions)
          ) {
            setSessionList(sessions);
          }
          if (!userSelectedSession && sessions.length) {
            const active = state().sessionID;
            const target = active
              ? sessions.find(
                  (session) => session.id === active && !session.archived,
                )
              : undefined;
            if (target) {
              setSelectedSessionID(target.id);
              setSelectedSession(target.title);
            } else if (!selectedSessionID()) {
              // While the runtime is still attaching/restoring the startup session,
              // do not race it with a local fallback. The final selection is
              // determined by natalia:recent-session-restored / session.ready and
              // then projected once by openUnresolvedInteractives.
              const load = globalThis as unknown as {
                __nataliaReplayingHistory?: boolean;
              };
              if (load.__nataliaReplayingHistory) return;
              const recent = sessions
                .filter((session) => !session.archived)
                .sort((a, b) => sessionRecency(b) - sessionRecency(a));
              const touched = recent.filter(
                (session) => session.lastAccessedAt,
              );
              const meaningful = recent.filter(
                (session) => session.title && session.title !== "New session",
              );
              const nonEmpty = recent.filter((session) => session.events > 0);
              const fallbackSource = touched.length
                ? touched
                : meaningful.length
                  ? meaningful
                  : nonEmpty.length
                    ? nonEmpty
                    : recent;
              const fallback = fallbackSource[0] ?? sessions[0];
              if (fallback) {
                setSelectedSessionID(fallback.id);
                setSelectedSession(fallback.title);
              }
            }
          }
        }
      } finally {
        if (token === sessionsRefreshToken) {
          sessionsRefreshInFlight = undefined;
        }
      }
    })();
    sessionsRefreshInFlight = operation;
    return operation;
  }

  const visibleSessions = (): RuntimeSessionSummary[] => {
    const query = sessionQuery().trim().toLowerCase();
    return sessionList().filter((session) => {
      if (showArchived() ? !session.archived : session.archived) return false;
      if (query && !session.title.toLowerCase().includes(query)) return false;
      return true;
    });
  };

  async function createSession(workspaceID?: string) {
    if (workspaceID) {
      if (!props.ctx.runtime.workspaceActivate) {
        await alert({
          title: t("shell.newSessionTitle"),
          message: t("shell.switchWorkspaceUnsupported"),
        });
        return;
      }
      await props.ctx.runtime.workspaceActivate(workspaceID);
    }
    const created = await props.ctx.runtime.sessionNew?.();
    if (created?.sessionID) {
      userSelectedSession = true;
      const nextSessionID = created.sessionID;
      setSelectedSessionID(nextSessionID);
      setSelectedSession(t("shell.newSessionName"));
      await props.ctx.runtime.sessionAttach?.(nextSessionID);
      void loadPerSessionModelConfig(nextSessionID);
    }
    await refreshWorkspaces();
    // A refresh requested before sessionNew may still be in flight. Drop it so
    // the newly created session cannot be missed by a stale list response.
    sessionsRefreshInFlight = undefined;
    await refreshSessions();
  }

  async function renameWorkspace(workspaceID: string, title: string) {
    const workspace = workspaces().find(
      (entry) => entry.workspaceID === workspaceID,
    );
    const nextTitle = title.trim();
    if (!workspace || !nextTitle) return;
    if (
      workspaces().some(
        (entry) =>
          entry.workspaceID !== workspaceID && entry.title === nextTitle,
      )
    ) {
      await alert({
        title: t("shell.renameWorkspaceTitle"),
        message: t("shell.workspaceExists", { title: nextTitle }),
      });
      return;
    }
    if (!props.ctx.runtime.workspaceAdd) {
      await alert({
        title: t("shell.renameWorkspaceTitle"),
        message: t("shell.renameWorkspaceUnsupported"),
      });
      return;
    }
    try {
      await props.ctx.runtime.workspaceAdd({
        path: workspace.root,
        title: nextTitle,
      });
      await refreshWorkspaces();
    } catch (error: unknown) {
      await alert({
        title: t("shell.renameFailed"),
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  async function removeWorkspace(workspaceID: string) {
    const workspace = workspaces().find(
      (entry) => entry.workspaceID === workspaceID,
    );
    const confirmed = await confirm({
      title: t("shell.deleteWorkspaceTitle"),
      message: t("shell.deleteWorkspaceBody", {
        title: workspace?.title ?? workspaceID,
      }),
      confirmLabel: t("shell.deleteWorkspaceConfirm"),
      danger: true,
    });
    if (!confirmed) return;
    try {
      await props.ctx.runtime.workspaceRemove?.(workspaceID);
      await refreshWorkspaces();
      await refreshSessions();
    } catch (error: unknown) {
      // In the dialog the user is looking at, not in the add-workspace panel's
      // error signal: that signal renders only while THAT panel is open, so a
      // failed delete wrote its reason to a place nobody could see and the
      // click looked like it did nothing at all. Renaming above already
      // reports this way.
      await alert({
        title: t("shell.deleteWorkspaceFailed"),
        message: error instanceof Error ? error.message : String(error),
      });
      setWorkspaceError(error instanceof Error ? error.message : String(error));
    }
  }

  function selectedSessionIsActive() {
    return Boolean(
      selectedSessionID() && selectedSessionID() === state().sessionID,
    );
  }

  function workspaceIDForSessionID(sessionID: string): string | undefined {
    const fromList = sessionList().find(
      (session) => session.id === sessionID,
    )?.workspaceID;
    if (fromList) return fromList;
    const fromState = state().sessions.find(
      (session) => session.id === sessionID,
    )?.workspaceID;
    if (fromState) return fromState;
    if (sessionID === selectedSessionID() || sessionID === state().sessionID)
      return state().activeWorkspaceID;
    return undefined;
  }

  async function attachAndSelectSession(session: {
    id: string;
    title: string;
  }): Promise<void> {
    const attach = props.ctx.runtime.sessionAttach;
    if (typeof attach !== "function")
      throw new Error(t("shell.sessionSwitchUnsupported"));
    // Select locally before awaiting attach: the web runtime emits
    // `natalia:session-attached` from inside the attach promise, and the
    // hydration listener reads selectedSessionID() at that moment. Updating the
    // signals afterwards makes hydration load the previous session even though
    // the tree already shows the new one.
    const previousID = selectedSessionID();
    const previousTitle = selectedSession();
    const previousUserSelected = userSelectedSession;
    userSelectedSession = true;
    setSelectedSessionID(session.id);
    setSelectedSession(session.title);
    try {
      await attach(session.id);
      void loadPerSessionModelConfig(session.id);
    } catch (error) {
      userSelectedSession = previousUserSelected;
      setSelectedSessionID(previousID);
      setSelectedSession(previousTitle);
      throw error;
    }
  }

  async function switchAwayFromSession(targetID: string): Promise<boolean> {
    const findOther = (list: RuntimeSessionSummary[]) => {
      const candidates = list.filter(
        (session) => session.id !== targetID && !session.archived,
      );
      if (!candidates.length) return undefined;
      const targetWorkspaceID = workspaceIDForSessionID(targetID);
      if (targetWorkspaceID) {
        const sameWorkspace = candidates.find(
          (session) => session.workspaceID === targetWorkspaceID,
        );
        if (sameWorkspace) return sameWorkspace;
      }
      return candidates[0];
    };
    let other = findOther(sessionList());
    if (!other) {
      // A stale/short list must not force a brand-new session when older
      // sessions already exist. Refresh once before falling back to creation.
      sessionsRefreshInFlight = undefined;
      await refreshSessions();
      other = findOther(sessionList());
    }
    if (!other) other = findOther(state().sessions);
    if (other) {
      await attachAndSelectSession(other);
      return true;
    }
    const created = await props.ctx.runtime.sessionNew?.();
    if (!created?.sessionID) return false;
    await attachAndSelectSession({
      id: created.sessionID,
      title: t("shell.newSessionTitle"),
    });
    return true;
  }

  async function archiveSession(targetID: string) {
    try {
      if (targetID === selectedSessionID()) {
        const switched = await switchAwayFromSession(targetID);
        if (!switched) {
          props.ctx.runtime.diagnostic?.(
            t("shell.archiveNeedsSession"),
            "warning",
          );
          return;
        }
      }
      await props.ctx.runtime.sessionArchive?.(targetID);
      await refreshSessions();
    } catch (error: unknown) {
      props.ctx.runtime.diagnostic?.(
        t("shell.archiveFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        "warning",
      );
    }
  }

  async function restoreSession(sessionID: string) {
    try {
      await props.ctx.runtime.sessionRestore?.(sessionID);
      await refreshSessions();
    } catch (error: unknown) {
      props.ctx.runtime.diagnostic?.(
        t("shell.restoreFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        "warning",
      );
    }
  }

  async function forkSessionAtTurn(turnID: string) {
    const sourceID = selectedSessionID() || state().sessionID;
    if (!sourceID) return;
    try {
      const result = await props.ctx.runtime.sessionFork?.(
        sourceID,
        turnID,
        `Fork of ${selectedSession()}`,
      );
      if (result) await refreshSessions();
    } catch (error: unknown) {
      props.ctx.runtime.diagnostic?.(
        t("shell.forkFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        "warning",
      );
    }
  }

  function toggleBulkSelected(id: string) {
    const next = new Set(bulkSelected());
    if (next.has(id)) next.delete(id);
    else next.add(id);
    setBulkSelected(next);
  }

  function toggleSelectAllVisible() {
    const ids = visibleSessions().map((session) => session.id);
    if (!ids.length) return;
    const next = new Set(bulkSelected());
    const allSelected = ids.every((id) => next.has(id));
    for (const id of ids) {
      if (allSelected) next.delete(id);
      else next.add(id);
    }
    setBulkSelected(next);
  }

  async function switchAwayFromActiveIfNeeded(ids: string[]) {
    const active = state().sessionID;
    if (!active || !ids.includes(active)) return true;
    const activeWorkspaceID =
      workspaceIDForSessionID(active) ?? state().activeWorkspaceID;
    const candidates = sessionList().filter(
      (session) => !ids.includes(session.id) && !session.archived,
    );
    const other =
      (activeWorkspaceID
        ? candidates.find(
            (session) => session.workspaceID === activeWorkspaceID,
          )
        : undefined) ?? candidates[0];
    if (other) {
      await attachAndSelectSession(other);
      return true;
    }
    const created = await props.ctx.runtime.sessionNew?.();
    if (!created?.sessionID) {
      props.ctx.runtime.diagnostic?.(t("shell.bulkNeedsSession"), "warning");
      return false;
    }
    await attachAndSelectSession({
      id: created.sessionID,
      title: t("shell.newSessionTitle"),
    });
    return true;
  }

  async function bulkArchiveSelected() {
    const ids = [...bulkSelected()];
    if (!ids.length) return;
    if (!(await switchAwayFromActiveIfNeeded(ids))) return;
    for (const id of ids) await props.ctx.runtime.sessionArchive?.(id);
    await refreshSessions();
    setBulkSelected(new Set<string>());
    setBulkSelectMode(false);
  }

  async function bulkRestoreSelected() {
    const ids = [...bulkSelected()];
    if (!ids.length) return;
    for (const id of ids) await props.ctx.runtime.sessionRestore?.(id);
    await refreshSessions();
    setBulkSelected(new Set<string>());
    setBulkSelectMode(false);
  }

  async function bulkDeleteSelected() {
    const ids = [...bulkSelected()];
    if (!ids.length) return;
    if (
      !(await confirm({
        title: t("shell.deleteSessionTitle"),
        message: t("shell.deleteSessionsBody", { count: ids.length }),
        confirmLabel: t("settingsDlg.confirm"),
        cancelLabel: t("common.cancel"),
        danger: true,
      }))
    )
      return;
    try {
      if (!(await switchAwayFromActiveIfNeeded(ids))) return;
      if (!props.ctx.runtime.sessionDelete) {
        props.ctx.runtime.diagnostic?.(t("shell.purgeUnsupported"), "warning");
        return;
      }
      for (const id of ids) await props.ctx.runtime.sessionDelete(id);
      await refreshSessions();
      setBulkSelected(new Set<string>());
      setBulkSelectMode(false);
    } catch (error: unknown) {
      props.ctx.runtime.diagnostic?.(
        t("shell.bulkDeleteFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        "warning",
      );
    }
  }

  function checkpointIDForMessage(message: Message) {
    const turnID = sessionTurnID(message.id);
    if (!turnID) return undefined;
    const checkpoint = state()
      .checkpoints.filter((candidate) => candidate.turnID === turnID)
      .sort((a, b) => b.sequence - a.sequence)[0];
    return checkpoint?.id;
  }

  function rollbackDraftFromMessage(message: Message) {
    const checkpointID = checkpointIDForMessage(message);
    const turnID = sessionTurnID(message.id);
    const messages = mainMessages();
    const userMessage = turnID
      ? messages.find(
          (candidate) =>
            sessionTurnID(candidate.id) === turnID && candidate.role === "user",
        )
      : undefined;
    const targetIndex = messages.findIndex(
      (candidate) => candidate.id === message.id,
    );
    if (userMessage) setMainDraft(userMessage.content);
    setPendingRollback({
      turnID: turnID ?? message.id,
      ...(checkpointID ? { checkpointID } : {}),
      label: userMessage?.content || message.content || t("shell.thisMessage"),
      hiddenAfter: targetIndex >= 0 ? targetIndex + 1 : undefined,
    });
    setRollbackNotice(undefined);
    if (checkpointID) {
      setReviewRequestedTab("checkpoint");
      setReviewRequestedCheckpointID(checkpointID);
      setRightVisible(true);
      setRightTab("diff");
    }
  }

  async function hydrateRecentMessages(options?: { replace?: boolean }) {
    const sessionID = selectedSessionID() || state().sessionID;
    await hydrateRecentMessagesForSession(sessionID, () => true, options);
  }

  async function hydrateRecentMessagesForSession(
    sessionID: string | undefined,
    isCurrent: () => boolean,
    options?: { replace?: boolean },
  ) {
    const hydrateStart = performance.now();
    setTranscriptHistoryLoading(true);
    mainPager.setSource((input) => mainTranscriptPageSource(sessionID, input));
    try {
      await mainPager.loadInitial();
    } catch (error) {
      setTranscriptHistoryLoading(false);
      throw error;
    }
    // A superseded/expired load must still release the transcript's initial
    // loading gate, otherwise the tail state machine waits forever.
    if (!isCurrent()) {
      setTranscriptHistoryLoading(false);
      return;
    }
    const hydrated = props.ctx.projection.getState();
    if (
      options?.replace ||
      state().natalia.messages.length !== hydrated.natalia.messages.length
    ) {
      setState(cloneState(hydrated));
    }
    perfLog(
      "[hydrate] applied",
      JSON.stringify({
        sessionID,
        projectedMessages: hydrated.natalia.messages.length,
        uiMessages: state().natalia.messages.length,
      }),
    );
    setTranscriptHistoryLoading(false);
    perfLog(
      `[perf] messages hydrate total ${(performance.now() - hydrateStart).toFixed(1)}ms`,
    );
  }

  async function refreshTranscript() {
    await hydrateRecentMessages({ replace: true });
    setState(cloneState(props.ctx.projection.getState()));
  }

  function cancelPendingRollback() {
    setPendingRollback(undefined);
  }

  async function redoAppliedRollback() {
    const notice = rollbackNotice();
    if (!notice?.safetyCheckpointID) {
      setRollbackNotice(undefined);
      return;
    }
    try {
      await props.ctx.runtime.checkpointRollback?.({
        id: notice.safetyCheckpointID,
        sessionID: selectedSessionID() || state().sessionID,
      });
      await refreshTranscript();
    } catch (error: unknown) {
      props.ctx.runtime.diagnostic?.(
        t("shell.redoFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
        "warning",
      );
    } finally {
      setRollbackNotice(undefined);
    }
  }

  async function physicallyDeleteSelectedSession() {
    const targetID = selectedSessionID();
    if (!targetID) return;
    if (
      !(await confirm({
        title: t("shell.deleteSessionTitle"),
        message: t("shell.deleteSessionBody", {
          name: selectedSession(),
        }),
        confirmLabel: t("settingsDlg.confirm"),
        cancelLabel: t("common.cancel"),
        danger: true,
      }))
    ) {
      return;
    }
    const deleteSession = props.ctx.runtime.sessionDelete;
    if (typeof deleteSession !== "function") {
      await alert({
        title: t("shell.deleteFailed"),
        message: t("shell.purgeUnsupported"),
      });
      return;
    }
    try {
      if (targetID === selectedSessionID()) {
        const switched = await switchAwayFromSession(targetID);
        if (!switched) {
          await alert({
            title: t("shell.deleteFailed"),
            message: t("shell.purgeNeedsSession"),
          });
          return;
        }
      }
      await deleteSession(targetID);
      setSessionMenuOpen(false);
      await refreshSessions();
    } catch (error: unknown) {
      const message = error instanceof Error ? error.message : String(error);
      props.ctx.runtime.diagnostic?.(
        t("shell.purgeFailed", { message }),
        "warning",
      );
      await alert({
        title: t("shell.deleteFailed"),
        message,
      });
    }
  }

  let perSessionLoadToken = 0;
  async function loadPerSessionModelConfig(sessionID: string) {
    const token = ++perSessionLoadToken;
    setModelSelectionSignal(undefined);
    // Unset until the runtime answers: the placeholder shows the truth.
    setReasoningEffortSignal("");
    setChatProfile({});
    const [selectionResult, effortResult, profileResult] =
      await Promise.allSettled([
        props.ctx.runtime.modelSelection?.(sessionID),
        props.ctx.runtime.reasoningEffort?.(sessionID),
        props.ctx.runtime.naviChat?.modelProfile?.(sessionID),
      ]);
    const appliedStart = performance.now();
    if (token !== perSessionLoadToken) return;
    const selectionValue =
      selectionResult.status === "fulfilled"
        ? selectionResult.value
        : undefined;
    const effortValue =
      effortResult.status === "fulfilled" ? effortResult.value : undefined;
    const profileValue =
      profileResult.status === "fulfilled" ? profileResult.value : undefined;
    batch(() => {
      if (selectionValue?.modelID) setModelSelectionSignal(selectionValue);
      if (effortValue) setReasoningEffortSignal(effortValue);
      if (
        profileValue &&
        (profileValue.normal?.modelID || profileValue.expert?.modelID)
      )
        setChatProfile(profileValue);
    });
    perfLog(
      `[perf] perSessionModelConfig applied selection=${selectionValue?.modelID ?? "-"} reasoning=${effortValue ?? "-"} profile=${profileValue?.normal?.modelID ?? "-"} +${(performance.now() - appliedStart).toFixed(1)}ms`,
    );
  }

  createEffect(() => {
    const sessionID = selectedSessionID() || state().sessionID;
    if (sessionID) void loadPerSessionModelConfig(sessionID);
  });

  onMount(() => {
    const mountStart = performance.now();
    perfLog(
      `[perf] AppNeu onMount +${(mountStart - ((globalThis as unknown as { __nataliaStartupStart?: number }).__nataliaStartupStart ?? mountStart)).toFixed(1)}ms`,
    );
    const handleKeydown = (event: KeyboardEvent) => {
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "b") {
        event.preventDefault();
        setLeftVisible((value) => !value);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "j") {
        event.preventDefault();
        setRightVisible((value) => !value);
      }
      if (
        (event.metaKey || event.ctrlKey) &&
        event.shiftKey &&
        event.key.toLowerCase() === "p"
      ) {
        event.preventDefault();
        setSearchOpen(true);
      }
      if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "k") {
        event.preventDefault();
        setPaletteOpen((value) => !value);
      }
    };
    window.addEventListener("keydown", handleKeydown);
    onCleanup(() => window.removeEventListener("keydown", handleKeydown));

    // Real runtime integration: open the approval modal when the model asks
    // for permission during a turn, and refresh workspace/session navigation
    // whenever the multi-workspace runtime publishes a routing event.
    onCleanup(
      props.ctx.events.subscribe((event) => {
        const replaying = (
          globalThis as unknown as {
            __nataliaReplayingHistory?: boolean;
          }
        ).__nataliaReplayingHistory;
        if (replaying) return;
        if (event.type === "turn.submitted" || event.type === "turn.input") {
          // A turn that starts (or an input injected into one) should be visible.
          scrollMainTranscriptToBottom();
          setShowJumpToBottom(false);
        }
        if (
          (event.type === "navi.chat.message.new" ||
            event.type === "navi.chat.message.added") &&
          event.role === "user"
        ) {
          scrollChatTranscriptToBottom();
          setChatShowJumpToBottom(false);
        }
        if (
          event.type.startsWith("workspace.") ||
          event.type === "session.created" ||
          event.type === "session.ready"
        ) {
          debouncedRefreshWorkspaces();
          debouncedRefreshSessions();
        }
      }),
    );

    // After history replay completes, surface only still-unresolved
    // approvals/questions from the restored session. Resolved historical
    // requests are not re-opened because their response events clear them
    // from the view-store pending state during replay.
    const resetProjectionForSessionSwitch = () => {
      historyReplayDone = false;
      setTranscriptHistoryLoading(true);
      lastHydratedSessionID = undefined;
      // A stale in-flight load must not block the same session from being
      // retried after the reset.
      hydratingSessionID = undefined;
      mainPager.reset();
      toolOutputCache.clear();
      setShowJumpToBottom(false);
      setChatShowJumpToBottom(false);
      setMainDraft("");
      setChatDraft("");
      setMainAttachments([]);
      setChatAttachments([]);
      // The previous session's rung is not this session's: the echo of a write
      // belongs to the session it was written for, and the projection supplies
      // the standing rung for whichever session is now shown.
      setSessionRung(undefined);
      // The turn clock belongs to the session too: drop the legacy echo so the
      // next session starts from its own turn's durable start.
      setLegacyTurnStartKey(undefined);
      setActiveTurnStartedAt(undefined);
      setTurnElapsedMs(0);
      const projected = cloneState(props.ctx.projection.getState());
      setState(projected);
    };
    const unsubscribePanels = props.ctx.host?.subscribePanels(() => {
      setPanelRevision((revision) => revision + 1);
    });
    onCleanup(() => unsubscribePanels?.());
    const elapsedTimer = setInterval(() => {
      const start = turnStartAt();
      if (start !== undefined) setTurnElapsedMs(Date.now() - start);
      if (naviChatActivity()?.startedAt)
        setChatElapsedMs(Date.now() - naviChatActivity()!.startedAt);
    }, 1000);
    onCleanup(() => clearInterval(elapsedTimer));

    window.addEventListener(
      "natalia:session-switch-reset",
      resetProjectionForSessionSwitch,
    );
    onCleanup(() =>
      window.removeEventListener(
        "natalia:session-switch-reset",
        resetProjectionForSessionSwitch,
      ),
    );

    const onRecentSessionRestored = (event: Event) => {
      const detail = (event as CustomEvent<{ sessionID?: string }>).detail;
      if (!detail?.sessionID || userSelectedSession) return;
      const restored = sessionList().find(
        (session) => session.id === detail.sessionID && !session.archived,
      );
      if (restored) {
        setSelectedSessionID(restored.id);
        setSelectedSession(restored.title);
      } else {
        setSelectedSessionID(detail.sessionID);
        setSelectedSession("");
      }
    };
    window.addEventListener(
      "natalia:recent-session-restored",
      onRecentSessionRestored,
    );
    onCleanup(() =>
      window.removeEventListener(
        "natalia:recent-session-restored",
        onRecentSessionRestored,
      ),
    );

    let lastHydratedSessionID: string | undefined;
    let hydratingSessionID: string | undefined;
    const workspaceIDForSession = (sessionID: string) =>
      sessionList().find((session) => session.id === sessionID)?.workspaceID ??
      state().activeWorkspaceID;
    const hydrateRecentMessagesOnLoad = async () => {
      const sessionID = selectedSessionID() || state().sessionID;
      if (!sessionID) {
        // Startup may not have selected/restored the session yet. Retry until
        // runtime publishes the active session rather than hydrating empty data.
        setTimeout(() => void hydrateRecentMessagesOnLoad(), 100);
        return;
      }
      if (
        sessionID === lastHydratedSessionID ||
        sessionID === hydratingSessionID
      )
        return;
      hydratingSessionID = sessionID;
      props.ctx.projection.activateSession?.(
        sessionID,
        workspaceIDForSession(sessionID),
      );
      const loadToken = (
        globalThis as unknown as { __nataliaSessionLoadToken?: number }
      ).__nataliaSessionLoadToken;
      const isCurrentLoad = () =>
        loadToken ===
          (globalThis as unknown as { __nataliaSessionLoadToken?: number })
            .__nataliaSessionLoadToken &&
        sessionID === (selectedSessionID() || state().sessionID);
      const hydrateStart = performance.now();
      perfLog(
        `[perf] hydrateRecentMessagesOnLoad start +${(hydrateStart - ((globalThis as unknown as { __nataliaStartupStart?: number }).__nataliaStartupStart ?? hydrateStart)).toFixed(1)}ms`,
      );
      // Message-first startup: the latest projected page replaces the old
      // full-log replay. The page is newest-last on the wire; reverse it so the
      // projection's older-merge keeps transcript order. This is a baseline
      // replacement, not a paging merge: merging a whole baseline page with
      // live rows via the paging path put new messages before history.
      try {
        await hydrateRecentMessagesForSession(sessionID, isCurrentLoad, {
          replace: true,
        });
      } catch (error) {
        // Release the in-flight guard so the history-replay-complete path can
        // retry instead of leaving the transcript with only live rows.
        perfLog(
          "[hydrate] failed",
          JSON.stringify({
            sessionID,
            error: error instanceof Error ? error.message : String(error),
          }),
        );
        if (hydratingSessionID === sessionID) hydratingSessionID = undefined;
        throw error;
      }
      if (!isCurrentLoad()) {
        // A reconnect/newer attach superseded this load. Do not mark the
        // session hydrated; clearing the guard lets the next attach retry the
        // page instead of leaving the transcript partial forever.
        perfLog(
          "[hydrate] stale",
          JSON.stringify({
            sessionID,
            loadToken,
            currentToken: (globalThis as { __nataliaSessionLoadToken?: number })
              .__nataliaSessionLoadToken,
            selected: selectedSessionID() || state().sessionID,
          }),
        );
        if (hydratingSessionID === sessionID) hydratingSessionID = undefined;
        return;
      }
      lastHydratedSessionID = sessionID;
      if (hydratingSessionID === sessionID) hydratingSessionID = undefined;
      // The attach-triggered hydrate can finish while the runtime replay guard
      // is still set; the projection subscription intentionally ignores those
      // notifications, and finishSessionLoad only flushes live events rather
      // than re-syncing an already-applied projection. Push the hydrated state
      // into the UI signal explicitly so the transcript is not left at 0 rows.
      if (
        (globalThis as unknown as { __nataliaReplayingHistory?: boolean })
          .__nataliaReplayingHistory
      ) {
        setState(cloneState(props.ctx.projection.getState()));
      }
      perfLog(
        "[hydrate] onLoad applied",
        JSON.stringify({
          sessionID,
          projectedMessages:
            props.ctx.projection.getState().natalia.messages.length,
          uiMessages: state().natalia.messages.length,
        }),
      );
      markStartup("main.messages");
      // Chat and subagents are secondary surfaces. Hydrate them in the
      // background so the primary transcript paints first and does not wait
      // for extra RPCs before the first visible frame.
      void (async () => {
        const chatStart = performance.now();
        props.ctx.projection.beginNaviHydration?.();
        props.ctx.projection.beginNiaHydration?.();
        naviPager.setSource(naviChatPageSource);
        niaPager.setSource(niaChatPageSource);
        const [, , runtimeNotices] = await Promise.all([
          naviPager.loadInitial(),
          niaPager.loadInitial(),
          // ADR Phase C dual ingestion: the server-projected notices merge
          // into the same view the live `context.instructions` stream feeds.
          props.ctx.runtime.notices?.(sessionID),
        ]);
        perfLog(
          `[perf] secondary chatMessages ${(performance.now() - chatStart).toFixed(1)}ms`,
        );
        if (isCurrentLoad()) {
          if (runtimeNotices?.length)
            props.ctx.projection.hydrateRuntimeNotices?.(runtimeNotices);
          // The projection listener may be suppressed while history is still
          // replaying, so copy the paged Chat projection into the UI signal.
          setState(cloneState(props.ctx.projection.getState()));
          perfLog(
            `[perf] secondary chat applied +${(performance.now() - chatStart).toFixed(1)}ms`,
          );
        }
        markStartup("secondary.loaded");
        const timings = (
          globalThis as unknown as {
            __nataliaStartupTimings?: Record<string, number>;
          }
        ).__nataliaStartupTimings;
        if (timings) {
          perfLog("[startup] complete", timings);
          if (
            (globalThis as { __NATALIA_PERF_VERBOSE?: number })
              .__NATALIA_PERF_VERBOSE === 1
          ) {
            console.table(timings);
          }
        }
        // Sub-agent data is not part of the primary Natalia/Navi/Nia view.
        // Load it slightly later on idle so it never delays first paint or the
        // main-agent chat surfaces.
        void new Promise<void>((resolve) => {
          if (typeof requestIdleCallback !== "undefined") {
            requestIdleCallback(() => resolve(), { timeout: 3000 });
          } else {
            setTimeout(resolve, 1500);
          }
        }).then(async () => {
          if (!isCurrentLoad()) return;
          const subagentsStart = performance.now();
          const subagents = await props.ctx.runtime.subagents?.(sessionID);
          perfLog(
            `[perf] background subagents ${(performance.now() - subagentsStart).toFixed(1)}ms`,
          );
          if (subagents && isCurrentLoad())
            props.ctx.projection.hydrateSubagents?.(subagents);
        });
      })();
    };

    const onSessionAttached = (event: Event) => {
      const sessionID = (event as CustomEvent<{ sessionID?: string }>).detail
        ?.sessionID;
      if (sessionID)
        props.ctx.projection.activateSession?.(
          sessionID,
          workspaceIDForSession(sessionID),
        );
      void hydrateRecentMessagesOnLoad();
    };
    window.addEventListener("natalia:session-attached", onSessionAttached);
    onCleanup(() =>
      window.removeEventListener("natalia:session-attached", onSessionAttached),
    );
    // The host may start and restore the session before this plugin mounts, so
    // hydration must not depend solely on the session-attached event.
    void hydrateRecentMessagesOnLoad();

    const openUnresolvedInteractives = (event: Event) => {
      const openStart = performance.now();
      perfLog(
        `[perf] openUnresolvedInteractives start +${(openStart - ((globalThis as unknown as { __nataliaStartupStart?: number }).__nataliaStartupStart ?? openStart)).toFixed(1)}ms`,
      );
      const detail = (
        event as CustomEvent<{ token?: number; sessionID?: string }>
      ).detail;
      const replayGlobal = globalThis as unknown as {
        __nataliaReplayingHistory?: boolean;
        __nataliaSessionLoadToken?: number;
      };
      const isStaleLoad = () =>
        detail?.token !== undefined &&
        replayGlobal.__nataliaSessionLoadToken !== undefined &&
        detail.token !== replayGlobal.__nataliaSessionLoadToken;
      if (isStaleLoad()) return;
      void (async () => {
        if (isStaleLoad()) return;
        suppressProjectionClones = true;
        try {
          await Promise.all([refreshSessions(), hydrateRecentMessagesOnLoad()]);
        } finally {
          suppressProjectionClones = false;
        }
        if (isStaleLoad()) return;
        // Attach hydrates Navi/Nia in the background, but that request is
        // dropped when the load token changes. Re-request after main history is
        // settled so a slow old session cannot leave both chat streams empty.
        const secondarySessionID =
          detail?.sessionID || selectedSessionID() || state().sessionID;
        if (secondarySessionID) {
          naviPager.setSource((input) =>
            chatPageSource("navi", secondarySessionID, input),
          );
          niaPager.setSource((input) =>
            chatPageSource("nia", secondarySessionID, input),
          );
          await Promise.all([naviPager.loadInitial(), niaPager.loadInitial()]);
          if (isStaleLoad()) return;
        }
        // Session loading finished; take one projection snapshot instead of
        // cloning once per raw event.
        const projected = cloneState(props.ctx.projection.getState());
        const cloneStart = performance.now();
        setState(projected);
        perfLog(
          "[hydrate] ui state",
          JSON.stringify({
            selected: selectedSessionID(),
            projectedSession: projected.sessionID,
            projectedMessages: projected.natalia.messages.length,
          }),
        );
        if (projected.workspaces.length)
          mergeProjectedWorkspaces(projected.workspaces);
        perfLog(
          `[perf] openUnresolvedInteractives hydrate/state clone +${(performance.now() - cloneStart).toFixed(1)}ms`,
        );
        markStartup("first.paint");
        const startupMask = document.getElementById("natalia-startup-mask");
        if (startupMask) {
          startupMask.classList.add("natalia-startup-mask-hide");
          setTimeout(() => startupMask.remove(), 500);
        }
        logStartupSummary();
        void loadSecondaryStartupData();
        // One explicit initial tail alignment. Later measurement/data
        // changes are owned by the shared Transcript controller.
        scrollMainTranscriptToBottom();
        scrollChatTranscriptToBottom();
        perfLog(
          `[perf] openUnresolvedInteractives done +${(performance.now() - openStart).toFixed(1)}ms`,
        );
        historyReplayDone = true;
      })();
    };
    window.addEventListener(
      "natalia:history-replay-complete",
      openUnresolvedInteractives,
    );
    onCleanup(() =>
      window.removeEventListener(
        "natalia:history-replay-complete",
        openUnresolvedInteractives,
      ),
    );
    // Fast session restore can finish before this UI module mounts. When the
    // history-replay-complete event has already fired, replay it locally so
    // the first attach still hydrates messages/chat/terminal instead of
    // waiting forever for an event that will never arrive again.
    const startupTimings = (
      globalThis as unknown as {
        __nataliaStartupTimings?: Record<string, number>;
      }
    ).__nataliaStartupTimings;
    if (startupTimings?.["session.loaded"] !== undefined) {
      queueMicrotask(() =>
        openUnresolvedInteractives(
          new Event("natalia:history-replay-complete"),
        ),
      );
    }

    const applyTheme = () => {
      applyNeuTheme(themeMode(), props.ctx.root);
    };
    applyTheme();
    createEffect(applyTheme);

    // Non-critical startup queries are deferred until the primary transcript
    // has painted. Running them before session.messages competes for the
    // desktop main-process event loop and makes first paint wait longer.
  });

  function runIdle(callback: () => void) {
    const idle = (
      globalThis as unknown as {
        requestIdleCallback?: (
          cb: () => void,
          opts?: { timeout?: number },
        ) => number;
      }
    ).requestIdleCallback;
    if (idle) {
      idle(callback, { timeout: 1000 });
    } else {
      setTimeout(callback, 0);
    }
  }

  /**
   * The startup data that is not needed for the first frame.
   *
   * Retried, because the first attempt races the runtime's own startup:
   * on a fresh install these RPCs are answered while the runtime is still
   * loading, and a failure there used to be swallowed whole — the
   * permission dropdown then rendered its empty menu for the rest of the
   * session, with nothing on screen to say the config had never arrived.
   * The config on disk always carries its three agent modes (the schema
   * default), so an empty dropdown is a delivery failure, never real
   * data, and it now says so.
   */
  async function fetchSecondaryStartupData(): Promise<{
    requirementContext:
      | Awaited<ReturnType<typeof createUiPanelRequirementContext>>
      | undefined;
    catalog:
      | Awaited<ReturnType<NonNullable<typeof props.ctx.runtime.modelCatalog>>>
      | undefined;
    tools:
      | Awaited<
          ReturnType<NonNullable<typeof props.ctx.runtime.registeredTools>>
        >
      | undefined;
    nextConfig:
      | Awaited<ReturnType<NonNullable<typeof props.ctx.runtime.configGet>>>
      | undefined;
    failed: string[];
  }> {
    const settle = async <T,>(
      name: string,
      work: () => Promise<T> | undefined,
    ): Promise<{ value: T | undefined; failed: boolean }> => {
      // Bounded, and the deadline is per SOURCE, not for the batch. The four
      // sources below are independent, and Promise.all waits for all of them:
      // one that never settles used to hold the whole batch, and the window
      // showed its loading surface forever with no error anywhere — the
      // runtime answering everything else was not enough, because nothing
      // asked. A rejected source was already reported; an unanswered one is
      // the same failure with no shape, so it gets one. This is the same rule
      // the connection layer uses for a generation's readiness.
      const timeoutMs = SECONDARY_STARTUP_SOURCE_TIMEOUT_MS;
      let timer: ReturnType<typeof setTimeout> | undefined;
      try {
        const value = await Promise.race([
          Promise.resolve().then(work),
          new Promise<never>((_resolve, reject) => {
            timer = setTimeout(
              () =>
                reject(
                  new Error(
                    `startup source ${name} did not answer within ${timeoutMs}ms`,
                  ),
                ),
              timeoutMs,
            );
          }),
        ]);
        return { value: value as T | undefined, failed: false };
      } catch {
        return { value: undefined, failed: true };
      } finally {
        if (timer) clearTimeout(timer);
      }
    };
    const [requirementContext, catalog, tools, nextConfig] = await Promise.all([
      settle("panelRequirements", () =>
        createUiPanelRequirementContext(props.ctx.runtime),
      ),
      settle("modelCatalog", () => props.ctx.runtime.modelCatalog?.()),
      settle("registeredTools", () =>
        props.ctx.runtime.registeredTools?.(
          selectedSessionID() || state().sessionID,
        ),
      ),
      settle("configGet", () => props.ctx.runtime.configGet?.()),
    ]);
    const failed = [requirementContext, catalog, tools, nextConfig]
      .map((entry, index) => (entry.failed ? index : -1))
      .filter((index) => index >= 0)
      .map(
        (index) =>
          ["panelRequirements", "modelCatalog", "registeredTools", "configGet"][
            index
          ]!,
      );
    return {
      requirementContext: requirementContext.value,
      catalog: catalog.value,
      tools: tools.value,
      nextConfig: nextConfig.value,
      failed,
    };
  }

  // The fetch's own return type, so the applied shape and the fetched
  // shape cannot drift: a field added to one and not the other is a
  // compile error rather than a silently dropped startup input.
  function applySecondaryStartupData(
    data: Awaited<ReturnType<typeof fetchSecondaryStartupData>>,
  ): void {
    const appliedAt = performance.now();
    batch(() => {
      if (data.requirementContext)
        setPanelRequirementContext(data.requirementContext);
      if (data.catalog) setModelCatalog(data.catalog);
      if (data.tools) setRegisteredTools(data.tools);
      if (data.nextConfig) setConfig(data.nextConfig);
    });
    perfLog(
      `[perf] secondary applied +${(performance.now() - appliedAt).toFixed(1)}ms`,
    );
  }

  function loadSecondaryStartupData() {
    const secondaryStart = performance.now();
    perfLog(
      `[perf] loadSecondaryStartupData start +${(secondaryStart - ((globalThis as unknown as { __nataliaStartupStart?: number }).__nataliaStartupStart ?? secondaryStart)).toFixed(1)}ms`,
    );
    runIdle(() => {
      void (async () => {
        for (
          let attempt = 1;
          attempt <= SECONDARY_STARTUP_ATTEMPTS;
          attempt += 1
        ) {
          const data = await fetchSecondaryStartupData();
          applySecondaryStartupData(data);
          if (data.failed.length === 0) {
            setStartupDataDegraded(false);
            return;
          }
          if (attempt < SECONDARY_STARTUP_ATTEMPTS) {
            await new Promise((resolve) =>
              setTimeout(resolve, SECONDARY_STARTUP_RETRY_MS),
            );
            continue;
          }
          // Every attempt failed for these sources. The UI says so
          // instead of rendering an empty state that reads as "no
          // data exists".
          console.warn(
            `[web-runtime] startup data unavailable after ${attempt} attempts: ${data.failed.join(", ")}`,
          );
          setStartupDataDegraded(true);
        }
      })();
    });
    runIdle(() => {
      void debouncedRefreshSessions();
    });
    runIdle(() => {
      void debouncedRefreshWorkspaces();
    });
    perfLog(
      `[perf] loadSecondaryStartupData scheduled +${(performance.now() - secondaryStart).toFixed(1)}ms`,
    );
  }

  const modelOptions = () =>
    (modelCatalog() ?? []).map((entry) => ({
      value: entry.id,
      label: entry.id,
    }));

  const workspaceIDForSelectedSession = () =>
    sessionList().find(
      (session) => session.id === (selectedSessionID() || state().sessionID),
    )?.workspaceID ?? state().activeWorkspaceID;

  const workspaceIDForRightPanels = () =>
    state().activeWorkspaceID ?? workspaceIDForSelectedSession();

  // Remount the right-side panels when the workspace/session changes, and ONLY
  // then. The panels hold their own async cursors and editors, so relying on
  // prop updates left plan/review/files showing the previous workspace.
  //
  // The key is computed by `panelScopeKey` from ONE source (audit: the tab
  // re-mounted on every message). It used to mix a session-list lookup
  // (`workspaceIDForSelectedSession()`, refreshed after events, therefore
  // briefly empty) with the projection's own active workspace, and to carry the
  // session twice — so an ordinary event could flip the key with nothing real
  // changed, and a keyed <Show> rebuilds its subtree on any change.
  const rightPanelScopeKey = createMemo(() =>
    panelScopeKey({
      workspaceID: state().activeWorkspaceID,
      sessionID: selectedSessionID() || state().sessionID,
    }),
  );

  /**
   * The session's rung, as the runtime accepted it.
   *
   * A rung is a PAIR (approval axis + file-effect axis) and it is SESSION-scoped,
   * which is why this signal holds both halves:
   *
   *   - the answer to the write (`setSandboxRung({mode, approval})`) is the only
   *     place the pair arrives together; and
   *   - the config cannot supply it. `resolveConfig` merges
   *     defaults -> global -> project, so the workspace's own
   *     `.natalia/config.json` outranks a global write — the version of this
   *     control that wrote `updateConfig(scope:"global")` was a no-op wherever
   *     the workspace pinned `defaultAgentMode`, which is why moving it only
   *     produced a reload notice. Measured: the axes read back unchanged after
   *     the write, and `currentRung()` stayed on `ask`.
   *
   * Until the human moves it (or a session loads with a mode of its own), the
   * display falls back to what the config says — the deployment's answer, which
   * is also what a new session starts on.
   */
  const [sessionRung, setSessionRung] = createSignal<
    | { approval: "ask" | "auto" | "read_only"; confinement: ConfinementMode }
    | undefined
  >(undefined);
  /**
   * Why the last rung switch did not take, when it did not.
   *
   * A control that silently does nothing is the failure this whole path is
   * about: the runtime face was missing from the web client, the click wrote
   * nothing, and the only thing the human saw was a config reload somewhere else.
   */
  const [permissionProblem, setPermissionProblem] = createSignal<
    string | undefined
  >(undefined);
  /**
   * The rung the SESSION stands on, read from the projection.
   *
   * The runtime publishes the session's approval mode on every attach
   * (`status.snapshot.permissions`) and records a move durably
   * (`session.permission.mode`); the confinement half rides the session
   * snapshot's `confinement.mode`. Reading them is what makes the control
   * honest: a front end that never touched it shows the session's own mode
   * instead of the config's default, two front ends cannot disagree, and a
   * restart shows the mode the human chose (measured: CEF showed
   * `auto（工作区）` while a second front end showed the placeholder for the
   * same session, because each showed its own last write or the config).
   *
   * Absent only when the runtime has said nothing yet — a brand-new session,
   * or a front end attached before the first snapshot — which is when the
   * config's mode is the honest answer.
   */
  const sessionRungFromProjection = () => {
    const approval = state().permissionMode;
    // `permissionConfinement` (status.snapshot) is the half that reaches a
    // client after a restart; `intelligence.confinement` (session.snapshot) is
    // the live one and stays as the fallback for a session that has one.
    const confinement =
      state().permissionConfinement ?? state().intelligence?.confinement?.mode;
    if (!approval || !confinement) return undefined;
    return rungFor({ approval, confinement });
  };
  /**
   * The rung the runtime ANSWERS with, asked directly on session activation.
   *
   * The projection above is fed by events, and a cold start is exactly the case
   * where the events never arrive: the transcript is hydrated from a MESSAGE
   * page rather than the full journal, so the durable
   * `session.permission.mode` facts are never folded, and no `status.snapshot`
   * is published after this window subscribes (the runtime publishes one at
   * attach, which the shell can beat, and thereafter only when a tool runs).
   * The control therefore fell back to the config's default and STAYED there —
   * the reported "locked on read" — while `runtime.status` for the same session
   * answered `auto`.
   *
   * Asking once on activation is the timing-free answer: the runtime owns the
   * rung, and `runtime.status` is the read it already answers correctly.
   */
  const [runtimeRung, setRuntimeRung] = createSignal<
    | { approval: "ask" | "auto" | "read_only"; confinement: ConfinementMode }
    | undefined
  >(undefined);
  createEffect(() => {
    const sessionID = selectedSessionID() || state().sessionID;
    const ask = props.ctx.runtime.runtimeStatus;
    setRuntimeRung(undefined);
    if (!sessionID || !ask) return;
    void ask(sessionID)
      .then((snapshot) => {
        // A newer activation wins: the answer must describe the session the
        // controls are showing, never the one that was there when it was asked.
        if ((selectedSessionID() || state().sessionID) !== sessionID) return;
        if (!snapshot) return;
        const approval = snapshot.permissions as
          | "ask"
          | "auto"
          | "read_only"
          | undefined;
        const confinement = snapshot.confinement as ConfinementMode | undefined;
        if (!approval || !confinement) return;
        setRuntimeRung({ approval, confinement });
      })
      .catch(() => undefined);
  });
  /** The rung the controls are standing on. */
  const currentRung = () =>
    sessionRungFromProjection() ??
    rungFor(
      runtimeRung() ??
        sessionRung() ?? {
          approval:
            (config()?.defaultAgentMode as
              | "ask"
              | "auto"
              | "read_only"
              | undefined) ?? "ask",
          confinement:
            (config()?.confinement as { mode?: ConfinementMode } | undefined)
              ?.mode ?? "workspace-write",
        },
    );
  /**
   * The rung id the trigger falls back to when nothing above can name one.
   *
   * The fallback used to be `config()?.defaultAgentMode` — an AGENT-MODE name
   * fed to a control whose option values are RUNG ids. Two of the three names
   * coincide (`ask`, `auto`), so the bug only showed on the third: a config on
   * `read_only` put the literal string `"read_only"` in the trigger, no option
   * matched, and the selector rendered its 「选择权限」 placeholder while the
   * session ran on a real rung. Spelling the mode as its rung is the same fact
   * in the vocabulary the control speaks.
   */
  const configRungID = (): PermissionRungID | undefined => {
    const mode = config()?.defaultAgentMode;
    if (typeof mode !== "string") return undefined;
    return PERMISSION_RUNGS.find((rung) => rung.agentMode === mode)?.id;
  };
  // The menu shows the four rungs and no "current" suffix: the trigger already
  // names the standing rung, and the option rows carry `data-active` for the
  // highlight. The suffix made two of the four rows read as one long sentence.
  //
  // The standing rung is always offered, even when the config's `agentModes`
  // cannot name it: hiding it left the trigger with a value no option matched,
  // which rendered as the "选择权限" placeholder — the control looked unset
  // while the session was running on `auto（工作区）`.
  const permissionOptions = () => {
    const listed = availableRungs(config()?.agentModes);
    const standing = currentRung();
    if (!standing || listed.some((rung) => rung.id === standing.id))
      return listed.map((rung) => ({
        value: rung.id,
        label: t(rung.labelKey),
      }));
    return [
      ...listed.map((rung) => ({ value: rung.id, label: rung.label })),
      { value: standing.id, label: standing.label },
    ];
  };

  // The PLUGIN side panels (terminal, todo, files) have NO scope key at all.
  //
  // They are mounted once and then only shown or hidden, because everything
  // they hold lives inside the component and dies with it: an xterm instance
  // with its socket and scrollback, an open diff, and — the sharpest case — the
  // file editor's open tabs and UNSAVED buffers. A keyed <Show> rebuilds its
  // subtree whenever the key changes, and the previous key was mixed from a
  // debounced session list and a per-event projection snapshot, so an ordinary
  // message re-mounted them.
  //
  // They do not need a key to stay correct: each panel subscribes to the
  // projection itself and reloads on a real workspace change (the file editor's
  // own `subscribe` compares the workspace key; the terminal's effect keys on
  // sessionID+runtimeURL), so a key here could only do harm.

  /**
   * Move to a rung: BOTH axes, in ONE session-scoped write.
   *
   * Not a config write, and that is the fix rather than a shortcut. The previous
   * version patched `defaultAgentMode` + `confinement.mode` at global scope and
   * then re-read the config, which could not work on a workspace whose own
   * `.natalia/config.json` pins those keys: `resolveConfig` merges
   * defaults -> global -> project, so the project row won, the readback never
   * moved, `exec.permissionMode` never moved either (so the model's per-turn
   * `Permission mode:` line kept saying the old thing), and the only visible
   * effect was the `config.reload` the write itself triggered.
   *
   * `setSandboxRung({mode, approval})` moves the session's two axes and tells the
   * model through the durable `context.instructions` notice; the per-turn
   * environment block then states the pair, so the agent knows what it may do
   * without the system prompt changing under the cached prefix.
   */
  async function changePermission(rungID: string) {
    const rung = PERMISSION_RUNGS.find((candidate) => candidate.id === rungID);
    if (!rung) return;
    const sessionID = selectedSessionID() || state().sessionID;
    const call = props.ctx.runtime.setSandboxRung;
    // A rung is a runtime WRITE, and the label may only say what the runtime
    // answered. This is not defensive noise: the web client's RPC table was
    // missing this method, so `?.()` returned `undefined` and the old control
    // looked like it did nothing while writing only the config. A missing face is
    // a refusal the human can see, not a silent no-op.
    if (!call) {
      setPermissionProblem(t("shell.permissionSwitchUnsupported"));
      return;
    }
    let applied: Awaited<ReturnType<typeof call>> | undefined;
    try {
      applied = await call({
        mode: rung.confinement,
        approval: rung.approval,
        ...(sessionID ? { sessionID } : {}),
      });
    } catch (error) {
      setPermissionProblem(
        t("shell.permissionSwitchFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
      return;
    }
    setPermissionProblem(undefined);
    // The answer carries the axes the session now stands on. `changed: false` is
    // legitimate (already on that rung); a THROWN call is not, and neither is a
    // missing answer — both leave the label where it was.
    if (!applied) return;
    setSessionRung({
      approval: applied.approval ?? rung.approval,
      confinement: applied.mode,
    });
  }

  async function updateChatProfile(next: ChatModelProfile) {
    setChatProfile(next);
    const sessionID = selectedSessionID() || state().sessionID;
    await props.ctx.runtime.naviChat?.setModelProfile?.(next, sessionID);
  }
  const toolOutputCache = new Map<string, string>();

  async function loadOlderHistory(): Promise<boolean> {
    if (
      !historyReplayDone ||
      !mainPaging().hasOlder ||
      mainPaging().loadingOlder
    )
      return false;
    setTranscriptOlderLoading(true);
    const before = props.ctx.projection.getState().natalia.messages.length;
    try {
      await mainPager.loadOlder();
    } catch {
      return false;
    } finally {
      setTranscriptOlderLoading(false);
    }
    setState(cloneState(props.ctx.projection.getState()));
    return props.ctx.projection.getState().natalia.messages.length > before;
  }

  async function loadNewerHistory() {
    if (
      !historyReplayDone ||
      !mainPaging().hasNewer ||
      mainPaging().loadingNewer
    )
      return;
    await mainPager.loadNewer();
    setState(cloneState(props.ctx.projection.getState()));
  }

  function jumpToBottom() {
    scrollMainTranscriptToBottom();
    setShowJumpToBottom(false);
  }

  function jumpChatToBottom() {
    scrollChatTranscriptToBottom();
    setChatShowJumpToBottom(false);
  }

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 1) return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
  }

  function chatActivityLabel(): string {
    const activity = naviChatActivity();
    if (!activity) return "idle";
    switch (activity.phase) {
      case "waiting":
        return "Waiting";
      case "thinking":
        return "Thinking";
      case "generating":
        return "Generating";
      case "using_tool":
        return activity.toolName
          ? `Using ${activity.toolName}`
          : "Using a tool";
    }
  }

  function activityLabel(): string {
    const activity = selectPrimaryActivity(state());
    if (activity) {
      switch (activity.kind) {
        case "planning":
          return "Planning";
        case "thinking":
          return "Thinking";
        case "generating":
          return "Generating";
        case "tool":
          return activity.label ? `Using ${activity.label}` : "Using a tool";
        case "command":
          return "Running command";
        case "workflow":
          return "Running workflow";
        case "subagent":
          return "Working with subagent";
        case "compacting":
          return "Compacting context";
        case "retrying":
          return "Retrying";
        case "waiting_for_user":
          return "Waiting for input";
        case "paused":
          return "Paused";
      }
    }
    return state().natalia.activeTurn ? "Working" : "Ready";
  }

  const pendingByMessageID = createMemo(() => {
    const map = new Map<string, string>();
    for (const approval of state().pendingApprovals) {
      const link = pendingToolLink(approval.id);
      if (link) map.set(link.messageID, approval.id);
    }
    for (const question of state().pendingQuestions) {
      const link = pendingToolLink(question.id);
      if (link) map.set(link.messageID, question.id);
    }
    return map;
  });

  const pendingCount = createMemo(
    () => state().pendingApprovals.length + state().pendingQuestions.length,
  );

  // Open/disputed drift findings — the治理 tab's PendingBadge (EI Phase 2).
  const [openDriftCount] = createResource(
    () => selectedSessionID() || state().sessionID,
    async (sessionID) => {
      try {
        const page = await props.ctx.runtime.driftFindings?.({ sessionID });
        return (page?.items ?? []).filter(
          (finding) =>
            finding.status === "open" || finding.status === "disputed",
        ).length;
      } catch {
        return 0;
      }
    },
  );

  const mainMessageCache = new Map<
    string,
    { signature: RowSignature; value: Message }
  >();

  /**
   * The live message objects, keyed by row id.
   *
   * A row's identity answers "is this still the same row", never "what does it
   * say now" — the text of the row being streamed changes on every delta. The
   * row objects below therefore carry an EMPTY `content` plus a `contentLive`
   * accessor that reads this map, so a delta updates one text node instead of
   * replacing the row's DOM (which flickered the copy/fork/rollback row under
   * the cursor and made clicks land on a node the next delta had removed).
   */
  const liveMessages = createMemo(() => {
    const messages = state().natalia.messages;
    const map = new Map<string, (typeof messages)[number]>();
    for (const msg of messages) map.set(msg.id, msg);
    return map;
  });
  /** One row's current text, through the live map (empty when the row left). */
  const liveContent = (id: string): string => {
    const live = liveMessages().get(id);
    return live ? live.text + (live.pendingText || "") : "";
  };
  /**
   * One tool row's current call, through the live map.
   *
   * Same rule as `liveContent`: a tool call streams twice (its arguments arrive
   * in fragments, then its result), so neither belongs in the row's identity.
   */
  const liveToolCall = (id: string): ToolCall | undefined => {
    const live = liveMessages().get(id)?.tool;
    return live ? toolCallRow(live) : undefined;
  };
  const mainMessages = createMemo<Message[]>(() => {
    const list = state().natalia.messages;
    const active = state().natalia.activeTurn;
    // The running marker belongs to the last message of the active turn, not to
    // whatever message happens to be last — a queued or steering input is not
    // running.
    let lastActiveIndex = -1;
    if (active)
      for (let index = list.length - 1; index >= 0; index -= 1)
        if (list[index]!.id.startsWith(`${active}:`)) {
          lastActiveIndex = index;
          break;
        }
    return stableRows(
      mainMessageCache,
      list.map((msg, idx) => {
        const isLast = idx === lastActiveIndex;
        const tool = msg.tool;
        if (tool) {
          const status =
            active && isLast ? "running" : (tool.status as Message["status"]);
          const pendingRequestID = pendingByMessageID().get(msg.id);
          return {
            id: msg.id,
            // Identity only. The arguments, the result, the card and its facts
            // all MOVE while the call streams — carrying them here rebuilt the
            // card's DOM on every delta (the newest card flickered, and a click
            // landing between two deltas hit a node that no longer existed).
            // They ride `live` on the ToolCall instead.
            signature: [
              tool.name,
              status,
              Boolean(active),
              isLast,
              pendingRequestID,
            ],
            create: () => {
              const initial = toolCallRow(tool);
              return {
                id: msg.id,
                role: "assistant",
                content: "",
                status,
                ...(pendingRequestID
                  ? {
                      actions: [
                        {
                          label: t("shell.handleAction"),
                          primary: true,
                          onClick: () => {
                            // The pending tab is gone (T4-4): the request's
                            // home is the composer takeover now. Focusing it
                            // also un-minimizes, so the button always lands on
                            // the card rather than on a collapsed strip.
                            setPendingTakeoverMinimized(false);
                            setPendingTakeoverFocus(pendingRequestID);
                            props.ctx.pending.controller.focus(
                              pendingRequestID,
                            );
                          },
                        },
                      ],
                    }
                  : {}),
                // The row object stays; the card reads through `live`.
                toolCalls: [
                  { ...initial, live: () => liveToolCall(msg.id) ?? initial },
                ],
              };
            },
          };
        }
        const role =
          msg.role === "user"
            ? "user"
            : msg.role === "system"
              ? "system"
              : "assistant";
        // The attachment array reference survives cloneState, so comparing it
        // by reference is both cheap and correct.
        const attachments =
          msg.role === "user" && msg.attachments?.length
            ? msg.attachments
            : undefined;

        const goalRound =
          msg.role === "system" ? parseGoalRoundPrompt(msg.text) : undefined;
        const status = active && isLast ? "running" : undefined;
        const steering = msg.status === "steering";
        const streaming = Boolean(
          active &&
            isLast &&
            msg.role !== "user" &&
            (msg.pendingText ?? "").length > 0,
        );
        // L2's feedback entry: a confirmed assistant answer carries the
        // thumbs. Which rows qualify is the kit's decision; the actions
        // themselves come from it too, so the rule lives in one tested
        // place rather than in this 4500-line host.
        const feedbackRowActions = feedbackActionsFor({
          id: msg.id,
          role,
          thinking: msg.role === "thinking",
          streaming,
          text: msg.text,
        });
        // The signature answers identity only: text / pendingText / content are
        // the row's CONTENT and change on every streaming delta, so carrying
        // them here rebuilt the row's DOM per delta.
        return {
          id: msg.id,
          signature: [
            role,
            msg.role,
            msg.reasoningVisible,
            status,
            steering,
            streaming,
            goalRound?.round ?? 0,
            Boolean(active),
            isLast,
            attachments,
            feedbackRowActions.length,
            messageVerdicts()[msg.id]?.verdict ?? "",
          ],
          create: () => ({
            id: msg.id,
            role,
            thinking: msg.role === "thinking" && msg.reasoningVisible !== false,
            ...(attachments
              ? {
                  attachments: attachments.map((attachment) => ({
                    id: attachment.id,
                    path: attachment.path,
                    name: attachment.filename,
                    mediaType: attachment.mediaType,
                    ...(attachment.width ? { width: attachment.width } : {}),
                    ...(attachment.height ? { height: attachment.height } : {}),
                  })),
                }
              : {}),
            ...(goalRound ? { goalRound } : {}),
            ...(feedbackRowActions.length
              ? { actions: feedbackRowActions }
              : {}),
            // Empty on purpose: the text is read live, never carried here.
            content: "",
            contentLive: () => liveContent(msg.id),
            status,
            steering,
            streaming,
          }),
        };
      }),
    );
  });

  const visibleMainMessages = createMemo<Message[]>(() => {
    const hiddenAfter = pendingRollback()?.hiddenAfter;
    const messages = mainMessages();
    if (hiddenAfter === undefined) return messages;
    return messages.slice(0, hiddenAfter);
  });

  // L2's feedback entry (D6a): the thumbs on a confirmed assistant row.
  // The rating rides the runtime's feedback face, which journals a
  // `feedback.recorded` event and structurally never reaches the model —
  // design law 3, "signals about the output, never input to it". The
  // per-message verdict is remembered here so a rated row shows its own
  // state instead of offering the same choice twice.
  // The row's recorded judgment, with the journal record's id: a
  // retraction names the record it undoes, so the id rides along. Seeded
  // from the projected feedback slice (message-scope records), so a rating
  // survives a reload and a retraction after one is still possible.
  const [messageVerdicts, setMessageVerdicts] = createSignal<
    Record<string, { verdict: "up" | "down"; recordID: string }>
  >({});
  createEffect(() => {
    const seeded: Record<string, { verdict: "up" | "down"; recordID: string }> =
      {};
    for (const record of state().feedback ?? []) {
      if (record.scope !== "message" || !record.messageID) continue;
      seeded[record.messageID] = {
        verdict: record.verdict,
        recordID: record.id,
      };
    }
    setMessageVerdicts((current) => ({ ...seeded, ...current }));
  });
  const [feedbackNotice, setFeedbackNotice] = createSignal("");
  let feedbackNoticeTimer: ReturnType<typeof setTimeout> | undefined;
  function flashFeedbackNotice(message: string) {
    setFeedbackNotice(message);
    if (feedbackNoticeTimer) clearTimeout(feedbackNoticeTimer);
    feedbackNoticeTimer = setTimeout(() => setFeedbackNotice(""), 4000);
  }
  async function rateMessage(messageID: string, verdict: "up" | "down") {
    const runtime = props.ctx.runtime;
    const sessionID = selectedSessionID() || state().sessionID;
    // Every dead end says so out loud: a click that changes nothing and
    // explains nothing is the bug this button shipped with (the route was
    // missing, the catch was silent, and the user reported "点击后没反应").
    if (!runtime.feedback) {
      flashFeedbackNotice(t("shell.feedbackUnavailable"));
      return;
    }
    if (!sessionID) {
      flashFeedbackNotice(t("shell.feedbackNoSession"));
      return;
    }
    const current = messageVerdicts()[messageID];
    try {
      if (
        feedbackToggle({ current: current?.verdict, requested: verdict }) ===
        "retract"
      ) {
        // The withdrawal: the same face, the retract mode, naming the
        // record. The row drops back to its unrated glyph.
        const result = await runtime.feedback({
          scope: "message",
          sessionID: sessionID as SessionID,
          messageID,
          verdict,
          retract: true,
          recordID: current!.recordID,
        });
        if (result && !result.recorded) {
          flashFeedbackNotice(t("shell.withdrawUnrecorded"));
          return;
        }
        setMessageVerdicts((map) => {
          const next = { ...map };
          delete next[messageID];
          return next;
        });
        return;
      }
      const result = await runtime.feedback({
        scope: "message",
        sessionID: sessionID as SessionID,
        messageID,
        verdict,
      });
      if (result && !result.recorded) {
        flashFeedbackNotice(t("shell.ratingUnrecorded"));
        return;
      }
      setMessageVerdicts((map) => ({
        ...map,
        [messageID]: { verdict, recordID: result?.id ?? "" },
      }));
    } catch (error) {
      flashFeedbackNotice(
        t("shell.ratingFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    }
  }
  // Which rows carry the thumbs is the kit's decision (rateableRow): a
  // confirmed assistant answer, never a streaming tail and never a
  // thinking row.
  const feedbackActionsFor = (row: {
    role: string;
    thinking?: boolean;
    streaming?: boolean;
    text: string;
    id: string;
  }) =>
    feedbackActions({
      row,
      verdict: messageVerdicts()[row.id]?.verdict,
      rate: (verdict) => void rateMessage(row.id, verdict),
    });

  // The shared Transcript virtualizes long histories, so do not switch
  // between a synthetic tail window and the full paged window here. That
  // data-window swap was racing the scroll anchor restore in CEF.
  const renderedMainMessages = createMemo<Message[]>(() =>
    collapseDuplicateTranscriptRows(
      dedupeTranscriptRowsById(visibleMainMessages()),
    ),
  );
  const naviChatActivity = () => state().navi.activity;

  const chatMessageCache = new Map<
    string,
    { signature: RowSignature; value: Message }
  >();

  const chatMessages = createMemo<Message[]>(() => {
    const list = state().navi.messages;
    const activity = naviChatActivity();
    const lastIndex = list.length - 1;
    return stableRows(
      chatMessageCache,
      list.map((msg, idx) => {
        const isLast = idx === lastIndex;
        const tool = msg.tool;
        if (tool) {
          return {
            id: msg.id,
            signature: [
              tool.name,
              tool.result,
              tool.summary,
              tool.status,
              // The arguments stream in fragments; a row cached mid-stream
              // would pin a ToolCall without parsed arguments forever.
              tool.argumentsRaw,
              // The card and its structured facts are what the row RENDERS
              // (R0), and the legacy metadata blob is the replay fallback
              // the decode reads: every field the derivation depends on
              // belongs in the row's identity.
              tool.card,
              tool.meta,
              tool.metadata,
            ],
            create: () => ({
              id: msg.id,
              role: "assistant",
              content: "",
              toolCalls: [toolCallRow(tool)],
            }),
          };
        }
        const role =
          msg.role === "user" ? ("user" as const) : ("assistant" as const);

        const content = msg.text + (msg.pendingText || "");
        const streaming = Boolean(activity && isLast && msg.role !== "user");
        const attachments =
          msg.role === "user" && msg.attachments?.length
            ? msg.attachments
            : undefined;
        return {
          id: msg.id,
          signature: [
            role,
            msg.role,
            msg.text,
            msg.pendingText ?? "",
            msg.reasoningVisible,
            content,
            attachments,
            streaming,
            isLast,
            Boolean(activity),
          ],
          create: () => ({
            id: msg.id,
            role,
            thinking: msg.role === "thinking" && msg.reasoningVisible !== false,
            ...(attachments
              ? {
                  attachments: attachments.map((attachment) => ({
                    id: attachment.id,
                    path: attachment.path,
                    name: attachment.filename,
                    mediaType: attachment.mediaType,
                    ...(attachment.width ? { width: attachment.width } : {}),
                    ...(attachment.height ? { height: attachment.height } : {}),
                  })),
                }
              : {}),
            content,
            streaming,
          }),
        };
      }),
    );
  });

  const renderedChatMessages = createMemo<Message[]>(() =>
    collapseDuplicateTranscriptRows(dedupeTranscriptRowsById(chatMessages())),
  );
  function startResize(
    event: PointerEvent,
    computeWidth: (clientX: number) => number,
    applyWidth: (width: number) => void,
  ) {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture?.(event.pointerId);
    setResizing(true);
    let frame: number | undefined;
    let latest: number | undefined;
    const flush = () => {
      frame = undefined;
      if (latest !== undefined) applyWidth(latest);
    };
    const move = (next: PointerEvent) => {
      latest = computeWidth(next.clientX);
      if (frame === undefined) frame = requestAnimationFrame(flush);
    };
    const finish = (next: PointerEvent) => {
      if (frame !== undefined) {
        cancelAnimationFrame(frame);
        frame = undefined;
      }
      if (latest !== undefined) applyWidth(latest);
      target.releasePointerCapture?.(next.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
      setResizing(false);
      // The Transcript controller pauses follow while resizing and resumes
      // it only if follow was still true when the drag ended.
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  }

  function startLeftResize(event: PointerEvent) {
    const startX = event.clientX;
    const startWidth = leftWidth();
    startResize(
      event,
      (clientX) =>
        Math.max(
          MIN_SIDEBAR_WIDTH,
          Math.min(MAX_SIDEBAR_WIDTH, startWidth + clientX - startX),
        ),
      setLeftWidth,
    );
  }

  function startRightResize(event: PointerEvent) {
    const startX = event.clientX;
    const startWidth = rightWidth();
    const maxRight = rightPanelMaxWidth();
    startResize(
      event,
      (clientX) =>
        Math.max(
          MIN_RIGHT_WIDTH,
          Math.min(maxRight, startWidth - (clientX - startX)),
        ),
      setRightWidth,
    );
  }

  function cycleThemeMode() {
    const modes = NEU_THEME_MODES;
    const current = themeMode() as (typeof modes)[number];
    const next = modes[(modes.indexOf(current) + 1) % modes.length];
    setThemeMode(next);
    props.ctx.preferences.set("themeMode", next);
  }

  function panelVisible(panel: {
    requires?: import("@anthelia/contracts").UiPanelRequirement[];
  }) {
    const context = panelRequirementContext();
    if (!context) return true;
    return uiPanelRequirementsSatisfied(context, panel.requires);
  }

  // `listPanels()` returns fresh wrapper objects every call, and Solid's
  // <For> keys by identity. Keep stable descriptors so a panelRevision bump
  // does not destroy/recreate the mounted panel (which would remount it and
  // bump the revision again forever).
  const sidePanelCache = new Map<
    string,
    {
      signature: RowSignature;
      value: {
        id: string;
        item: { pluginId: string; panel: UiPanelDefinition };
      };
    }
  >();

  const sidePanels = createMemo(() => {
    panelRevision();
    const list = props.ctx.host?.listPanels() ?? [];
    const rows = list
      .filter((item) => item.panel.region === "side")
      // Metadata-only panels (e.g. the shell's own `chat`) have no mount and
      // cannot be rendered into the rail.
      .filter((item) => typeof item.panel.mount === "function")
      .filter((item) => panelVisible(item.panel))
      // One row per panel id: the shell keys its tabs on the panel id alone, so
      // a duplicate is not a second tab but a second mount slot — and two slots
      // split the sidebar's height between them (the terminal occupied exactly
      // half of it). The host's own dedup covers the armed/mounted split; this
      // keeps the invariant local to the place that mounts.
      .filter(
        (item, index, all) =>
          all.findIndex((other) => other.panel.id === item.panel.id) === index,
      )
      // No second gate on plugins here. A listed panel is a panel whose plugin
      // the host armed from the plugin CATALOG (`installed && enabled`) or has
      // already mounted, and that is the only thing that decides whether a
      // plugin-owned tab exists — "installed and enabled, therefore visible;
      // disabled or uninstalled, therefore gone". A gate that asked the
      // runtime for its LOADED plugin list said the opposite of the catalog:
      // plugins load lazily, so that list is empty at startup (measured on an
      // installed app: `plugin.list` returned no plugins while the catalog
      // listed 16), and the terminal tab was deleted from the rail every time.
      .map((item) => {
        const id = `${item.pluginId}:${item.panel.id}`;
        return {
          id,
          signature: [
            item.pluginId,
            item.panel.id,
            item.panel.title,
            item.panel.order,
          ] as RowSignature,
          create: () => ({ id, item }),
        };
      });
    return stableRows(sidePanelCache, rows).map((entry) => entry.item);
  });

  const rightTabs = () => {
    panelRevision();
    const tabs: { id: RightTab; label: string }[] = [
      { id: "diff", label: t("tab.diff") },
      { id: "plan", label: t("tab.plan") },
      { id: "governance", label: t("tab.governance") },
      { id: "nia", label: t("tab.nia") },
      { id: "agent", label: t("tab.agent") },
      ...sidePanels().map((item) => ({
        id: item.panel.id,
        label: item.panel.title,
      })),
    ];
    const seen = new Set<string>();
    const unique = tabs.filter((tab) =>
      seen.has(tab.id) ? false : (seen.add(tab.id), true),
    );
    const layout = layoutProfile();
    const order = layout?.regions?.right?.order;
    if (order?.length) {
      unique.sort((a, b) => {
        const ai = order.indexOf(a.id);
        const bi = order.indexOf(b.id);
        return (
          (ai === -1 ? order.length : ai) - (bi === -1 ? order.length : bi)
        );
      });
    }
    return unique;
  };

  const topbarPanels = () => {
    panelRevision();
    return (
      props.ctx.host
        ?.listPanels()
        .filter(
          (item) => item.panel.region === "topbar" && panelVisible(item.panel),
        ) ?? []
    );
  };

  const groupedTopbarPanels = () => {
    const groups = new Map<string, ReturnType<typeof topbarPanels>>();
    for (const item of topbarPanels()) {
      const group = item.panel.group ?? t("shell.moreGroup");
      const list = groups.get(group) ?? [];
      list.push(item);
      groups.set(group, list);
    }
    return [...groups.entries()];
  };

  function mountTopbarPanel(panel: ReturnType<typeof topbarPanels>[number]) {
    setTopbarPanel({ pluginId: panel.pluginId, panelId: panel.panel.id });
    requestAnimationFrame(() => {
      if (topbarPanelRef && props.ctx.host) {
        void props.ctx.host.mountPanel(
          panel.pluginId,
          panel.panel.id,
          topbarPanelRef,
        );
      }
    });
  }

  onMount(() => {
    const updateLayout = () => {
      const width = window.innerWidth;
      const height = window.innerHeight;
      const screenWidth =
        window.screen?.availWidth || window.screen?.width || width;
      const screenHeight =
        window.screen?.availHeight || window.screen?.height || height;
      const area = width * height;
      const quarterArea = screenWidth * screenHeight * 0.25;
      const tiny =
        width <= 1000 || height <= screenHeight * 0.5 || area <= quarterArea;
      const mode = tiny ? "tiny" : width <= 1700 ? "compact" : "wide";
      setLayoutMode(mode);
      if (mode !== "wide") {
        setLeftVisible(false);
        setRightVisible(false);
      } else {
        setLeftVisible(true);
        setRightVisible(true);
      }
      setNaviOpen(mode !== "tiny");
    };
    updateLayout();
    window.addEventListener("resize", updateLayout);
    onCleanup(() => window.removeEventListener("resize", updateLayout));
  });

  const nataliaVisible = () => layoutMode() !== "tiny" || !naviOpen();
  const naviVisible = () =>
    layoutMode() === "wide" ||
    (layoutMode() === "compact" && !leftVisible() && !rightVisible()) ||
    (layoutMode() === "tiny" &&
      naviOpen() &&
      !leftVisible() &&
      !rightVisible());

  let leftSidebarWasVisible = true;
  createEffect(() => {
    const visible = leftVisible();
    if (visible && !leftSidebarWasVisible) {
      debouncedRefreshSessions();
      debouncedRefreshWorkspaces();
    }
    leftSidebarWasVisible = visible;
  });

  return (
    <div
      class="neu-shell"
      data-compact={layoutMode() !== "wide"}
      data-tiny={layoutMode() === "tiny"}
      data-left-open={leftVisible()}
      data-left-wide={leftWidth() >= 230}
      data-right-open={rightVisible()}
      data-resizing={resizing()}
    >
      <Topbar
        t={t}
        slots={slots}
        locale={locale}
        viewOpen={viewOpen}
        setViewOpen={setViewOpen}
        setSearchOpen={setSearchOpen}
        setSettingsOpen={setSettingsOpen}
        moreOpen={moreOpen}
        setMoreOpen={setMoreOpen}
        topbarPanel={topbarPanel}
        topbarPanelRef={(element) => {
          topbarPanelRef = element;
        }}
        setTopbarPanel={setTopbarPanel}
        leftVisible={leftVisible}
        setLeftVisible={setLeftVisible}
        rightVisible={rightVisible}
        setRightVisible={setRightVisible}
        layoutMode={layoutMode}
        naviOpen={naviOpen}
        setNaviOpen={setNaviOpen}
        setStatusOpen={setStatusOpen}
        setHelpOpen={setHelpOpen}
        setStashOpen={setStashOpen}
        setSandboxOpen={setSandboxOpen}
        setPluginManagerOpen={setPluginManagerOpen}
        groupedTopbarPanels={groupedTopbarPanels}
        mountTopbarPanel={mountTopbarPanel}
      />
      {/*
        The image preview lives HERE, at the shell root: one instance for the whole
        app, a sibling of the panes. Inside a message it could not paint above the
        following messages or the right column — `.neu-pane .natalia-message` is a
        stacking context (`position: relative; z-index: 1`), so the overlay's own
        z-index was scoped to one row and the preview came up with cards and the
        side column on top of it.
      */}
      <ImagePreviewHost />
      <CommandPalette
        open={paletteOpen()}
        onClose={() => setPaletteOpen(false)}
        registry={commands}
        t={t}
      />
      <SlotMount slots={slots} name="statusbar" t={t} />
      <div class="neu-app">
        {/* Left session tree */}
        <SessionSidebar
          t={t}
          ctx={props.ctx}
          leftVisible={leftVisible}
          leftWidth={leftWidth}
          setLeftVisible={setLeftVisible}
          sessionSearchOpen={sessionSearchOpen}
          setSessionSearchOpen={setSessionSearchOpen}
          sessionQuery={sessionQuery}
          setSessionQuery={setSessionQuery}
          sidebarMenuOpen={sidebarMenuOpen}
          setSidebarMenuOpen={setSidebarMenuOpen}
          bulkSelectMode={bulkSelectMode}
          setBulkSelectMode={setBulkSelectMode}
          bulkSelected={bulkSelected}
          setBulkSelected={setBulkSelected}
          showArchived={showArchived}
          setShowArchived={setShowArchived}
          selectedSessionID={selectedSessionID}
          selectedSession={selectedSession}
          setSelectedSessionID={setSelectedSessionID}
          setSelectedSession={setSelectedSession}
          workspaces={workspaces}
          visibleSessions={visibleSessions}
          setSettingsWorkspaceID={setSettingsWorkspaceID}
          setWorkspaceSettingsOpen={setWorkspaceSettingsOpen}
          setSessionMenuOpen={setSessionMenuOpen}
          setWorkspaceOpen={setWorkspaceOpen}
          createSession={createSession}
          refreshSessions={refreshSessions}
          refreshWorkspaces={refreshWorkspaces}
          loadPerSessionModelConfig={loadPerSessionModelConfig}
          removeWorkspace={removeWorkspace}
          renameWorkspace={renameWorkspace}
          restoreSession={restoreSession}
          archiveSession={archiveSession}
          toggleSelectAllVisible={toggleSelectAllVisible}
          toggleBulkSelected={toggleBulkSelected}
          bulkArchiveSelected={bulkArchiveSelected}
          bulkRestoreSelected={bulkRestoreSelected}
          bulkDeleteSelected={bulkDeleteSelected}
          startLeftResize={startLeftResize}
          markUserSelectedSession={() => {
            userSelectedSession = true;
          }}
        />

        {/* Middle dual agent panes */}
        <MainPanes
          t={t}
          slots={slots}
          commands={commands}
          ctx={props.ctx}
          toolCards={toolCards}
          state={state}
          setState={setState}
          mainDraft={mainDraft}
          setMainDraft={setMainDraft}
          chatDraft={chatDraft}
          setChatDraft={setChatDraft}
          mainAttachments={mainAttachments}
          setMainAttachments={setMainAttachments}
          chatAttachments={chatAttachments}
          setChatAttachments={setChatAttachments}
          selectedSessionID={selectedSessionID}
          selectedSession={selectedSession}
          sessionList={sessionList}
          layoutMode={layoutMode}
          naviOpen={naviOpen}
          setNaviOpen={setNaviOpen}
          showJumpToBottom={showJumpToBottom}
          setShowJumpToBottom={setShowJumpToBottom}
          chatShowJumpToBottom={chatShowJumpToBottom}
          setChatShowJumpToBottom={setChatShowJumpToBottom}
          pendingTakeoverMinimized={pendingTakeoverMinimized}
          setPendingTakeoverMinimized={setPendingTakeoverMinimized}
          pendingTakeoverFocus={pendingTakeoverFocus}
          setPendingTakeoverFocus={setPendingTakeoverFocus}
          pendingRollback={pendingRollback}
          setPendingRollback={setPendingRollback}
          jumpToBottom={jumpToBottom}
          jumpChatToBottom={jumpChatToBottom}
          activityLabel={activityLabel}
          chatActivityLabel={chatActivityLabel}
          naviChatActivity={naviChatActivity}
          pendingTakeoverCount={pendingTakeoverCount}
          formatDuration={formatDuration}
          turnStartAt={turnStartAt}
          currentRung={currentRung}
          configRungID={configRungID}
          modelOptions={modelOptions}
          permissionOptions={permissionOptions}
          nataliaVisible={nataliaVisible}
          naviVisible={naviVisible}
          renderedMainMessages={renderedMainMessages}
          renderedChatMessages={renderedChatMessages}
          loadAttachmentUrl={loadAttachmentUrl}
          loadOlderHistory={loadOlderHistory}
          loadOlderNaviChat={loadOlderNaviChat}
          loadSecondaryStartupData={loadSecondaryStartupData}
          refreshTranscript={refreshTranscript}
          updateChatProfile={updateChatProfile}
          handlePasteAttachments={handlePasteAttachments}
          openModelSettings={openModelSettings}
          openGoalEditor={openGoalEditor}
          saveGoalEditor={saveGoalEditor}
          runGoalControl={runGoalControl}
          forkSessionAtTurn={forkSessionAtTurn}
          rollbackDraftFromMessage={rollbackDraftFromMessage}
          checkpointIDForMessage={checkpointIDForMessage}
          redoAppliedRollback={redoAppliedRollback}
          cancelPendingRollback={cancelPendingRollback}
          changePermission={changePermission}
          perfLog={perfLog}
          feedbackNotice={feedbackNotice}
          mainPaging={mainPaging}
          transcriptHistoryLoading={transcriptHistoryLoading}
          transcriptOlderLoading={transcriptOlderLoading}
          resizing={resizing}
          goalBusy={goalBusy}
          goalEditOpen={goalEditOpen}
          goalEditObjective={goalEditObjective}
          setGoalEditObjective={setGoalEditObjective}
          setGoalEditOpen={setGoalEditOpen}
          goalEditCap={goalEditCap}
          setGoalEditCap={setGoalEditCap}
          goalNotice={goalNotice}
          turnElapsedMs={turnElapsedMs}
          modelSelectionSignal={modelSelectionSignal}
          setModelSelectionSignal={setModelSelectionSignal}
          setReasoningEffortSignal={setReasoningEffortSignal}
          startupDataDegraded={startupDataDegraded}
          permissionProblem={permissionProblem}
          rollbackNotice={rollbackNotice}
          setRollbackNotice={setRollbackNotice}
          naviPaging={naviPaging}
          chatElapsedMs={chatElapsedMs}
          chatProfile={chatProfile}
          reasoningEffort={reasoningEffort}
        />

        {/* Right secondary tabs */}
        <RightRail
          t={t}
          ctx={props.ctx}
          state={state}
          setState={setState}
          rightVisible={rightVisible}
          setRightVisible={setRightVisible}
          rightWidth={rightWidth}
          startRightResize={startRightResize}
          rightTabs={rightTabs}
          rightTab={rightTab}
          setRightTab={setRightTab}
          openDriftCount={openDriftCount}
          rightPanelScopeKey={rightPanelScopeKey}
          reviewRequestedTab={reviewRequestedTab}
          reviewRequestedCheckpointID={reviewRequestedCheckpointID}
          selectedSessionID={selectedSessionID}
          workspaceIDForRightPanels={workspaceIDForRightPanels}
          governanceInitialTab={governanceInitialTab}
          modelCatalog={modelCatalog}
          openModelSettings={openModelSettings}
          loadAttachmentUrl={loadAttachmentUrl}
          resizing={resizing}
          niaPaging={niaPaging}
          loadOlderNiaChat={loadOlderNiaChat}
          sidePanels={sidePanels}
          panelRevision={panelRevision}
        />
        {rightVisible() ? null : (
          <button
            type="button"
            class="neu-collapsed-rail neu-right-rail"
            onClick={() => setRightVisible(true)}
            title={t("workbench.expandRight")}
          >
            <span class="neu-rail-dots" />
          </button>
        )}
      </div>
      <ModalLayer
        t={t}
        settingsFullscreen={settingsFullscreen}
        onToggleSettingsFullscreen={toggleSettingsFullscreen}
        ctx={props.ctx}
        state={state}
        config={config}
        setStateConfig={setConfig}
        modelCatalog={modelCatalog}
        modelSelectionSignal={modelSelectionSignal}
        registeredTools={registeredTools}
        workspaces={workspaces}
        selectedSession={selectedSession}
        selectedSessionID={selectedSessionID}
        sessionList={sessionList}
        themeMode={themeMode}
        cycleThemeMode={cycleThemeMode}
        refreshModelConfig={refreshModelConfig}
        refreshWorkspaces={refreshWorkspaces}
        refreshSessions={refreshSessions}
        physicallyDeleteSelectedSession={physicallyDeleteSelectedSession}
        workspaceIDForSelectedSession={workspaceIDForSelectedSession}
        settingsOpen={settingsOpen}
        settingsCategory={settingsCategory}
        setSettingsOpen={setSettingsOpen}
        setSettingsCategory={setSettingsCategory}
        pluginManagerOpen={pluginManagerOpen}
        setPluginManagerOpen={setPluginManagerOpen}
        modelOpen={modelOpen}
        setModelOpen={setModelOpen}
        searchOpen={searchOpen}
        setSearchOpen={setSearchOpen}
        helpOpen={helpOpen}
        setHelpOpen={setHelpOpen}
        stashOpen={stashOpen}
        setStashOpen={setStashOpen}
        sandboxOpen={sandboxOpen}
        setSandboxOpen={setSandboxOpen}
        statusOpen={statusOpen}
        setStatusOpen={setStatusOpen}
        workspaceOpen={workspaceOpen}
        setWorkspaceOpen={setWorkspaceOpen}
        workspaceError={workspaceError}
        setWorkspaceError={setWorkspaceError}
        workspaceSettingsOpen={workspaceSettingsOpen}
        setWorkspaceSettingsOpen={setWorkspaceSettingsOpen}
        settingsWorkspaceID={settingsWorkspaceID}
        sessionMenuOpen={sessionMenuOpen}
        setSessionMenuOpen={setSessionMenuOpen}
        dialog={dialog}
      />
    </div>
  );
}

/**
 * Turns the `/goal` composer shortcut into an explicit instruction for the
 * agent, which then uses the model-facing goal tools. This is the human
 * "manual" path: `/goal <objective>` creates, `/goal` reads, and
 * `/goal pause|resume|clear` control the current goal.
 */
export function goalCommandInstruction(text: string): string | undefined {
  const match = /^\/goal(?:\s+([\s\S]*))?$/iu.exec(text.trim());
  if (!match) return undefined;
  const arg = (match[1] ?? "").trim();
  if (!arg)
    return "The user issued the direct command /goal. Call get_goal and report the current goal (objective, phase, rounds started/max, blockedReason, activation) to the user.";
  const control = arg.toLowerCase();
  if (control === "status")
    return "The user issued the direct command /goal status. Call get_goal and report the current goal to the user.";
  if (control === "pause")
    return "The user issued the direct command /goal pause. Call get_goal, then call update_goal with action pause.";
  if (control === "resume")
    return "The user issued the direct command /goal resume. Call get_goal, then call update_goal with action resume.";
  if (control === "clear")
    return "The user issued the direct command /goal clear. Call get_goal, then call update_goal with action clear.";
  return `The user issued the direct command /goal. This is an explicit human request, so do not ask for confirmation: call create_goal with objective ${JSON.stringify(arg)}, then continue working toward it.`;
}
