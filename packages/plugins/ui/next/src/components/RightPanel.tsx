import styles from "../styles/review-panel.module.css";
import { PanelState } from "./PanelState";
import {
  createSignal,
  createEffect,
  createMemo,
  For,
  Show,
  onMount,
  onCleanup,
} from "solid-js";
import type {
  AuditRoundRecord,
  RuntimeAstNode,
  RuntimeCheckpoint,
  RuntimeClient,
  RuntimeEvent,
  RuntimeGitRef,
  RuntimeSandbox,
  RuntimeStructuredDiff,
  RuntimeTeamPR,
} from "@anthelia/contracts";
import type { StructuredDiffResult } from "@anthelia/diff-wasm";
import { NeuSelect } from "./NeuSelect";
import {
  UnifiedDiffView,
  SplitDiffView,
  buildSplitRows,
  diffLines,
  structuredRows,
  languageFromPath,
} from "@anthelia/diff";
import { computeDiffInWorker, computeDiffInWorkerStream } from "@anthelia/diff";
import type { DiffItem } from "@anthelia/diff";

const perfLog = (...args: unknown[]) => {
  if (
    (globalThis as { __NATALIA_PERF_VERBOSE?: number })
      .__NATALIA_PERF_VERBOSE === 1
  ) {
    console.warn(...args);
  }
};

type ReviewSubTab = "git" | "sandbox" | "checkpoint" | "rounds";

function toDiffItem(change: {
  path: string;
  operation?: "added" | "modified" | "deleted" | "renamed";
  kind?: string;
  oldPath?: string;
  additions?: number;
  deletions?: number;
  patch?: string;
  before?: string;
  after?: string;
  structured?: RuntimeStructuredDiff;
}): DiffItem {
  const operation =
    change.operation ??
    (change.kind === "add"
      ? "added"
      : change.kind === "delete"
        ? "deleted"
        : change.kind === "rename"
          ? "renamed"
          : "modified");
  return {
    id: change.path,
    path: change.path,
    operation,
    ...(change.oldPath ? { oldPath: change.oldPath } : {}),
    ...(change.additions !== undefined ? { additions: change.additions } : {}),
    ...(change.deletions !== undefined ? { deletions: change.deletions } : {}),
    ...(change.patch ? { patch: change.patch } : {}),
    ...(change.before ? { before: change.before } : {}),
    ...(change.after ? { after: change.after } : {}),
    ...(change.structured ? { structured: change.structured } : {}),
  };
}

function statusFor(operation: string) {
  if (operation === "added") return "A";
  if (operation === "modified") return "M";
  if (operation === "deleted") return "D";
  if (operation === "renamed") return "R";
  return "?";
}

export function ReviewPane(
  props: {
    t: (key: string, params?: Record<string, unknown>) => string;
    runtime?: RuntimeClient;
    requestedTab?: ReviewSubTab;
    requestedCheckpointID?: string;
    sessionID?: string;
    workspaceID?: string;
    events?: {
      subscribe(listener: (event: RuntimeEvent) => void): () => void;
    };
  } = {
    t: (key) => key,
  },
) {
  const t = props.t;
  const [tab, setTab] = createSignal<ReviewSubTab>("git");
  createEffect(() => {
    if (props.requestedTab) setTab(props.requestedTab);
    if (props.requestedCheckpointID) {
      setTab("checkpoint");
      setSelectedCheckpoint(props.requestedCheckpointID);
      void loadCheckpointPreview(props.requestedCheckpointID);
    }
  });
  const [loaded, setLoaded] = createSignal(false);
  const [sandboxLoaded, setSandboxLoaded] = createSignal(false);
  const [checkpointLoaded, setCheckpointLoaded] = createSignal(false);
  const [gitChanges, setGitChanges] = createSignal<DiffItem[]>([]);
  const [gitSelected, setGitSelected] = createSignal<string | null>(null);
  const [gitRefs, setGitRefs] = createSignal<RuntimeGitRef[]>([]);
  const [gitFrom, setGitFrom] = createSignal("HEAD");
  const [gitTo, setGitTo] = createSignal("WORKTREE");
  const [sandboxes, setSandboxes] = createSignal<RuntimeSandbox[]>([]);
  const [teamPRs, setTeamPRs] = createSignal<RuntimeTeamPR[]>([]);
  const [selectedSandbox, setSelectedSandbox] = createSignal<string | null>(
    null,
  );
  const [sandboxChanges, setSandboxChanges] = createSignal<DiffItem[]>([]);
  const [sandboxSelected, setSandboxSelected] = createSignal<string | null>(
    null,
  );
  const [checkpoints, setCheckpoints] = createSignal<RuntimeCheckpoint[]>([]);
  const [selectedCheckpoint, setSelectedCheckpoint] = createSignal<
    string | null
  >(null);
  const [checkpointChanges, setCheckpointChanges] = createSignal<DiffItem[]>(
    [],
  );
  const [checkpointSelected, setCheckpointSelected] = createSignal<
    string | null
  >(null);
  const [renamingCheckpointID, setRenamingCheckpointID] = createSignal<
    string | null
  >(null);
  const [checkpointNameDraft, setCheckpointNameDraft] = createSignal("");
  const [auditRounds, setAuditRounds] = createSignal<AuditRoundRecord[]>([]);
  const [roundPlanID, setRoundPlanID] = createSignal<string>("");
  const [roundFrom, setRoundFrom] = createSignal<number | undefined>(undefined);
  const [roundTo, setRoundTo] = createSignal<number | undefined>(undefined);
  const [roundChanges, setRoundChanges] = createSignal<DiffItem[]>([]);
  const [roundSelected, setRoundSelected] = createSignal<string | null>(null);
  const [fileWidth, setFileWidth] = createSignal(180);
  const [viewMode, setViewMode] = createSignal<"unified" | "split" | "ast">(
    "unified",
  );
  const [diffScope, setDiffScope] = createSignal<"session" | "all">("session");
  const [astDiffResult, setAstDiffResult] = createSignal<
    | {
        language: string;
        changes: Array<{
          kind: "modified" | "added" | "removed" | "moved";
          nodeKind: string;
          oldStart: number;
          oldEnd: number;
          newStart: number;
          newEnd: number;
        }>;
      }
    | undefined
  >();
  const [diffIgnoreWhitespace, setDiffIgnoreWhitespace] = createSignal(false);
  const [structuredDiff, setStructuredDiff] = createSignal<
    StructuredDiffResult | undefined
  >();
  const [structuredDiffError, setStructuredDiffError] = createSignal<
    string | undefined
  >();
  const [astDiffError, setAstDiffError] = createSignal<string | undefined>();
  const [collapsedAstGroups, setCollapsedAstGroups] = createSignal<Set<string>>(
    new Set(),
  );
  const [astSnippet, setAstSnippet] = createSignal<
    { kind: string; nodeKind: string; text: string } | undefined
  >();
  const [astBatchPanelOpen, setAstBatchPanelOpen] = createSignal(false);
  const [astBatchMode, setAstBatchMode] = createSignal<
    "structure" | "refactor" | "search" | "plan"
  >("structure");
  const [astBatchResult, setAstBatchResult] = createSignal<
    | {
        files: Array<{
          path?: string;
          language: string;
          changes: Array<{
            kind: "modified" | "added" | "removed" | "moved";
            nodeKind: string;
            oldStart: number;
            oldEnd: number;
            newStart: number;
            newEnd: number;
          }>;
          error?: string;
        }>;
      }
    | undefined
  >();
  const [astBatchLoading, setAstBatchLoading] = createSignal(false);
  const [astBatchError, setAstBatchError] = createSignal<string | undefined>();
  const [astSearchText, setAstSearchText] = createSignal("");
  const [astSearchNodeKind, setAstSearchNodeKind] = createSignal("");
  const [astSearchResult, setAstSearchResult] = createSignal<
    | {
        files: Array<{
          path?: string;
          language: string;
          nodes: RuntimeAstNode[];
          error?: string;
        }>;
        matches?: Array<{
          path?: string;
          language: string;
          nodes: RuntimeAstNode[];
        }>;
      }
    | undefined
  >();
  const [astSearchLoading, setAstSearchLoading] = createSignal(false);
  const [astSearchError, setAstSearchError] = createSignal<
    string | undefined
  >();
  const [astPlanFrom, setAstPlanFrom] = createSignal("");
  const [astPlanTo, setAstPlanTo] = createSignal("");
  const [astPlanResult, setAstPlanResult] = createSignal<
    | {
        operation: string;
        targets: Array<{
          path?: string;
          language: string;
          nodeKind: string;
          text: string;
          start: number;
          end: number;
          suggestedText?: string;
        }>;
        files: Array<{ path?: string; language: string; error?: string }>;
      }
    | undefined
  >();
  const [astPlanLoading, setAstPlanLoading] = createSignal(false);
  const [astPlanError, setAstPlanError] = createSignal<string | undefined>();
  const [astApplyResult, setAstApplyResult] = createSignal<
    | {
        operation: string;
        applied: Array<{
          path?: string;
          language: string;
          replacements: Array<{
            start: number;
            end: number;
            from: string;
            to: string;
          }>;
          before?: string;
          after?: string;
          error?: string;
        }>;
      }
    | undefined
  >();
  const [astApplyLoading, setAstApplyLoading] = createSignal(false);
  const [astApplyError, setAstApplyError] = createSignal<string | undefined>();

  const gitPatchCache = new Map<
    string,
    { signature: string; item: DiffItem }
  >();
  let gitPatchCacheScope = "";

  function gitDiffScopeKey() {
    return [
      props.workspaceID ?? "",
      gitFrom(),
      gitTo(),
      diffIgnoreWhitespace() ? "1" : "0",
    ].join("\u0000");
  }

  function ensureGitPatchCache() {
    const scope = gitDiffScopeKey();
    if (scope !== gitPatchCacheScope) {
      gitPatchCacheScope = scope;
      gitPatchCache.clear();
    }
  }

  function diffItemSignature(item: DiffItem) {
    return [
      item.operation,
      item.oldPath ?? "",
      item.additions ?? "",
      item.deletions ?? "",
    ].join("|");
  }

  function pickGitSelection(mapped: DiffItem[]) {
    const current = gitSelected();
    if (current && mapped.some((item) => item.path === current)) return current;
    return mapped[0]?.path ?? null;
  }

  let refreshTimer: ReturnType<typeof setTimeout> | undefined;
  const refreshCurrent = () => {
    if (tab() === "git") void loadGit();
    else if (tab() === "sandbox") void loadSandboxDiff(selectedSandbox() ?? "");
    else if (tab() === "checkpoint") {
      void (async () => {
        const checkpointList =
          (await props.runtime?.checkpointList?.(props.sessionID)) ?? [];
        setCheckpoints(checkpointList);
        if (selectedCheckpoint())
          await loadCheckpointPreview(selectedCheckpoint()!);
      })();
    } else if (tab() === "rounds") void loadRounds();
  };
  const onRefreshEvent = (event: RuntimeEvent) => {
    const finalToolUpdate =
      event.type === "tool.update" &&
      ["succeeded", "failed", "rejected", "cancelled"].includes(event.status);
    const relevant =
      finalToolUpdate ||
      event.type === "checkpoint.created" ||
      event.type === "rollback.previewed" ||
      event.type === "rollback.begin" ||
      event.type === "rollback.end" ||
      event.type === "rollback.failed" ||
      event.type === "plan.doc.created" ||
      event.type === "plan.doc.updated" ||
      event.type === "plan.doc.marked" ||
      event.type === "plan.doc.status" ||
      event.type === "plan.doc.deleted";
    if (!relevant) return;
    if (refreshTimer) clearTimeout(refreshTimer);
    refreshTimer = setTimeout(() => void refreshCurrent(), 300);
  };

  onMount(() => {
    const off = props.events?.subscribe(onRefreshEvent);
    onCleanup(() => {
      off?.();
      if (refreshTimer) clearTimeout(refreshTimer);
    });
  });

  async function loadSandboxTab() {
    if (sandboxLoaded()) return;
    setSandboxLoaded(true);
    const sandboxList =
      (await props.runtime?.sandboxList?.(props.sessionID)) ?? [];
    const prList = (await props.runtime?.teamPRList?.(props.sessionID)) ?? [];
    setSandboxes(sandboxList);
    setTeamPRs(prList);
    const firstSandboxID = prList[0]?.sandboxID ?? sandboxList[0]?.id ?? null;
    if (firstSandboxID) {
      setSelectedSandbox(firstSandboxID);
      await loadSandboxDiff(firstSandboxID);
    }
  }

  async function loadCheckpointTab() {
    if (checkpointLoaded()) return;
    setCheckpointLoaded(true);
    const checkpointList =
      (await props.runtime?.checkpointList?.(props.sessionID)) ?? [];
    setCheckpoints(checkpointList);
    if (checkpointList.length) {
      const latest = checkpointList[checkpointList.length - 1]!.id;
      setSelectedCheckpoint(latest);
      await loadCheckpointPreview(latest);
    }
  }

  async function currentSessionPaths(): Promise<Set<string> | null> {
    if (diffScope() !== "session" || !props.sessionID) return null;
    try {
      const changes =
        (await props.runtime?.confirmedWorkspaceChanges?.(props.sessionID)) ??
        [];
      const sessionChanges = changes.filter(
        (change) => change.correlation?.sessionID === props.sessionID,
      );
      if (!sessionChanges.length) return null;
      return new Set(sessionChanges.map((change) => change.path));
    } catch {
      return null;
    }
  }

  async function loadGit() {
    ensureGitPatchCache();
    const start = performance.now();
    const sessionPaths = await currentSessionPaths();
    try {
      const git = await props.runtime?.workspaceGitDiff?.({
        workspaceID: props.workspaceID,
        from: gitFrom(),
        to: gitTo(),
        includePatch: false,
        ignoreWhitespace: diffIgnoreWhitespace(),
      });
      if (git && git.length) {
        const mapped = git
          .map(toDiffItem)
          .filter((change) => !sessionPaths || sessionPaths.has(change.path));
        setGitChanges(mapped);
        const target = pickGitSelection(mapped);
        if (target) await selectGitFile(target, { force: true });
        else setGitSelected(null);
        perfLog(
          `[perf] diff git list ${mapped.length} files ${(performance.now() - start).toFixed(1)}ms`,
        );
        return;
      }
    } catch {
      // Fall through to the object-store global diff.
    }
    const workspace =
      (await props.runtime?.workspaceDiff?.({
        workspaceID: props.workspaceID,
      })) ?? [];
    const mapped = workspace
      .map(toDiffItem)
      .filter((change) => !sessionPaths || sessionPaths.has(change.path));
    setGitChanges(mapped);
    const target = pickGitSelection(mapped);
    if (target) await selectGitFile(target, { force: true });
    else setGitSelected(null);
    perfLog(
      `[perf] diff workspace fallback ${mapped.length} files ${(performance.now() - start).toFixed(1)}ms`,
    );
  }

  async function selectGitFile(path: string, options?: { force?: boolean }) {
    ensureGitPatchCache();
    const start = performance.now();
    const current = gitChanges().find((change) => change.path === path);
    const signature = current ? diffItemSignature(current) : "";
    const cached = options?.force ? undefined : gitPatchCache.get(path);
    if (cached && cached.signature === signature) {
      setGitSelected(path);
      setGitChanges((prev) =>
        prev.map((change) => (change.path === path ? cached.item : change)),
      );
      return;
    }
    setGitSelected(path);
    try {
      const detail = await props.runtime?.workspaceGitDiff?.({
        workspaceID: props.workspaceID,
        from: gitFrom(),
        to: gitTo(),
        path,
        includePatch: true,
        includeContent: true,
        ignoreWhitespace: diffIgnoreWhitespace(),
      });
      const file = detail?.[0];
      if (file) {
        const updated = toDiffItem(file);
        gitPatchCache.set(path, {
          signature: diffItemSignature(updated),
          item: updated,
        });
        setGitChanges((prev) =>
          prev.map((change) => (change.path === path ? updated : change)),
        );
        perfLog(
          `[perf] diff git file ${path} ${updated.patch?.length ?? 0} chars ${(performance.now() - start).toFixed(1)}ms`,
        );
      }
    } catch {
      // keep the list-only row; patch can be loaded by clicking again
    }
  }

  async function loadSandboxDiff(
    id: string,
    options?: { includePatch?: boolean },
  ) {
    const start = performance.now();
    try {
      const changes =
        (await props.runtime?.sandboxDiff?.(id, props.sessionID, options)) ??
        [];
      const mapped = changes.map(toDiffItem);
      setSandboxChanges(mapped);
      const current = sandboxSelected();
      if (!current || !mapped.some((item) => item.path === current)) {
        setSandboxSelected(mapped[0]?.path ?? null);
      }
      perfLog(
        `[perf] diff sandbox ${id} ${mapped.length} files ${(performance.now() - start).toFixed(1)}ms`,
      );
    } catch {
      setSandboxChanges([]);
      setSandboxSelected(null);
    }
  }

  async function selectSandbox(id: string) {
    setSelectedSandbox(id);
    await loadSandboxDiff(id);
  }

  async function runRoundDiff() {
    const planID = roundPlanID();
    const from = roundFrom();
    const to = roundTo();
    if (!planID || from === undefined || to === undefined || to <= from) {
      setRoundChanges([]);
      setRoundSelected(null);
      return;
    }
    const changes =
      (await props.runtime?.roundDiff?.({
        from: { kind: "round", planID, round: from },
        to: { kind: "round", planID, round: to },
        includePatch: true,
        includeContent: false,
      })) ?? [];
    const mapped = changes.map(toDiffItem);
    setRoundChanges(mapped);
    if (mapped.length) setRoundSelected(mapped[0]!.path);
  }

  async function loadRounds() {
    const list = (await props.runtime?.auditRounds?.()) ?? [];
    setAuditRounds(list);
    const plans = [...new Set(list.map((item) => item.planID))];
    const plan = plans.find((item) => item === roundPlanID()) ?? plans[0] ?? "";
    setRoundPlanID(plan);
    const planRounds = list
      .filter((item) => item.planID === plan)
      .sort((a, b) => a.round - b.round);
    if (planRounds.length >= 2) {
      setRoundFrom(planRounds[planRounds.length - 2]!.round);
      setRoundTo(planRounds.at(-1)!.round);
    } else {
      setRoundFrom(planRounds[0]?.round);
      setRoundTo(planRounds[0]?.round);
    }
    await runRoundDiff();
  }

  async function loadCheckpointPreview(
    id: string,
    options?: { includePatch?: boolean },
  ) {
    const start = performance.now();
    const preview = await props.runtime?.checkpointPreview?.(
      id,
      props.sessionID,
      options,
    );
    if (!preview) return;
    const mapped = preview.changes.map(toDiffItem);
    const current = checkpointSelected();
    setCheckpointChanges(mapped);
    if (!current || !mapped.some((item) => item.path === current)) {
      setCheckpointSelected(mapped[0]?.path ?? null);
    }
    // If any file lacks patch/before/after (or has empty structured hunks),
    // backfill from roundDiff(checkpoint -> current) so every card can expand.
    if (
      props.runtime?.roundDiff &&
      mapped.some(
        (item) =>
          !hasRenderableStructured(item.structured) &&
          !item.patch &&
          !item.before &&
          !item.after,
      )
    ) {
      try {
        const full = await props.runtime.roundDiff({
          workspaceID: props.workspaceID,
          from: { kind: "checkpoint", id },
          to: { kind: "current" },
          includePatch: true,
          includeContent: true,
        });
        if (full?.length && selectedCheckpoint() === id) {
          const fullMapped = full.map(toDiffItem);
          setCheckpointChanges(fullMapped);
        }
      } catch {
        // Keep preview changes on fallback failure
      }
    }
    perfLog(
      `[perf] diff checkpoint ${id} ${mapped.length} files ${(performance.now() - start).toFixed(1)}ms`,
    );
  }

  async function selectCheckpoint(id: string) {
    setSelectedCheckpoint(id);
    await loadCheckpointPreview(id);
  }

  async function refreshCheckpoints() {
    const checkpointList =
      (await props.runtime?.checkpointList?.(props.sessionID)) ?? [];
    setCheckpoints(checkpointList);
    return checkpointList;
  }

  function checkpointLabel(checkpoint: RuntimeCheckpoint) {
    const reasonKey = `review.cpReason.${checkpoint.reason}`;
    const reasonLabel = t(reasonKey);
    const title = checkpoint.name?.trim()
      ? `⭐ ${checkpoint.name.trim()}`
      : reasonLabel !== reasonKey
        ? reasonLabel
        : checkpoint.id;
    const time = checkpoint.createdAt
      ? new Date(checkpoint.createdAt).toLocaleTimeString([], {
          hour: "2-digit",
          minute: "2-digit",
        })
      : "";
    return `#${checkpoint.sequence} ${title} · ${t("review.cpChangesCount", { count: checkpoint.changes })}${time ? ` · ${time}` : ""}`;
  }

  function beginRenameCheckpoint(checkpoint: RuntimeCheckpoint) {
    setRenamingCheckpointID(checkpoint.id);
    setCheckpointNameDraft(checkpoint.name ?? "");
  }

  async function commitRenameCheckpoint() {
    const id = renamingCheckpointID();
    const name = checkpointNameDraft().trim();
    setRenamingCheckpointID(null);
    if (!id || !name) return;
    const current = checkpoints().find((checkpoint) => checkpoint.id === id);
    if (current?.name === name) return;
    await props.runtime?.checkpointRename?.({
      id,
      name,
      sessionID: props.sessionID,
    });
    await refreshCheckpoints();
  }

  const totalAdditions = () =>
    changesForTab().reduce((sum, change) => sum + (change.additions ?? 0), 0);
  const totalDeletions = () =>
    changesForTab().reduce((sum, change) => sum + (change.deletions ?? 0), 0);
  const changesForTab = () =>
    tab() === "git"
      ? gitChanges()
      : tab() === "sandbox"
        ? sandboxChanges()
        : tab() === "rounds"
          ? roundChanges()
          : checkpointChanges();
  const selectedForTab = () =>
    tab() === "git"
      ? gitSelected()
      : tab() === "sandbox"
        ? sandboxSelected()
        : tab() === "rounds"
          ? roundSelected()
          : checkpointSelected();
  const selectedFile = () =>
    changesForTab().find((change) => change.path === selectedForTab());

  function hasRenderableStructured(
    s: RuntimeStructuredDiff | StructuredDiffResult | undefined,
  ): s is RuntimeStructuredDiff | StructuredDiffResult {
    return Boolean(s && Array.isArray(s.hunks) && s.hunks.length > 0);
  }

  async function loadStructuredDiffForFile(file: DiffItem) {
    // Runtime structured diffs are canonical when they actually carry hunks.
    if (hasRenderableStructured(file.structured)) {
      setStructuredDiff(file.structured);
      setStructuredDiffError(undefined);
      return;
    }
    if (!file.before && !file.after) {
      setStructuredDiff(undefined);
      setStructuredDiffError(undefined);
      return;
    }
    setStructuredDiff(undefined);
    setStructuredDiffError(undefined);
    try {
      const oldText = file.before ?? "";
      const newText = file.after ?? "";
      if (oldText.length + newText.length > 1_000_000) {
        const hunks: StructuredDiffResult["hunks"] = [];
        setStructuredDiff({
          hunks: [],
          additions: 0,
          deletions: 0,
        });
        const meta = await computeDiffInWorkerStream(
          oldText,
          newText,
          (hunk) => {
            hunks.push(hunk);
            setStructuredDiff({
              hunks: [...hunks],
              additions: 0,
              deletions: 0,
            });
          },
        );
        setStructuredDiff({
          hunks,
          additions: meta.additions,
          deletions: meta.deletions,
        });
        return;
      }
      const result = await computeDiffInWorker(oldText, newText);
      setStructuredDiff(result);
    } catch (error) {
      setStructuredDiffError(
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  createEffect(() => {
    const file = selectedFile();
    if (file?.before || file?.after) {
      void loadStructuredDiffForFile(file);
    } else {
      setStructuredDiff(undefined);
      setStructuredDiffError(undefined);
    }
  });

  async function loadAstDiffForSelectedFile() {
    const file = selectedFile();
    if (!file) return;
    if (!file.before && !file.after) return;
    setAstDiffResult(undefined);
    setAstDiffError(undefined);
    if (!props.runtime?.astDiff) {
      setAstDiffError(t("review.astDiffUnsupported"));
      return;
    }
    try {
      const result = await props.runtime?.astDiff?.({
        oldText: file.before ?? "",
        newText: file.after ?? "",
        language: languageFromPath(file.path) ?? "plaintext",
      });
      setAstDiffResult(result);
    } catch (error) {
      setAstDiffError(error instanceof Error ? error.message : String(error));
    }
  }

  async function collectAstSourceFiles() {
    const changes = changesForTab();
    if (tab() === "git" && props.runtime?.workspaceGitDiff) {
      const files: Array<{
        path: string;
        source: string;
        language: string;
      }> = [];
      for (const change of changes) {
        const detail = await props.runtime.workspaceGitDiff({
          workspaceID: props.workspaceID,
          from: gitFrom(),
          to: gitTo(),
          path: change.path,
          includePatch: false,
          includeContent: true,
          ignoreWhitespace: diffIgnoreWhitespace(),
        });
        const file = detail?.[0];
        const source =
          file?.after ?? file?.before ?? change.after ?? change.before ?? "";
        if (source) {
          files.push({
            path: change.path,
            source,
            language: languageFromPath(change.path) ?? "plaintext",
          });
        }
      }
      return files;
    }
    if (
      tab() === "sandbox" &&
      selectedSandbox() &&
      props.runtime?.sandboxDiff
    ) {
      const details =
        (await props.runtime.sandboxDiff(
          selectedSandbox()!,
          props.sessionID,
        )) ?? [];
      return details
        .filter((change) => change.after || change.before)
        .map((change) => ({
          path: change.path,
          source: change.after ?? change.before ?? "",
          language: languageFromPath(change.path) ?? "plaintext",
        }));
    }
    if (
      tab() === "checkpoint" &&
      selectedCheckpoint() &&
      props.runtime?.checkpointPreview
    ) {
      const preview = await props.runtime.checkpointPreview(
        selectedCheckpoint()!,
        props.sessionID,
      );
      const details = preview?.changes ?? [];
      return details
        .filter((change) => change.after || change.before)
        .map((change) => ({
          path: change.path,
          source: change.after ?? change.before ?? "",
          language: languageFromPath(change.path) ?? "plaintext",
        }));
    }
    return changes
      .filter((change) => change.after || change.before)
      .map((change) => ({
        path: change.path,
        source: change.after ?? change.before ?? "",
        language: languageFromPath(change.path) ?? "plaintext",
      }));
  }

  async function loadAstSearch() {
    const files = await collectAstSourceFiles();
    if (!files.length) {
      setAstSearchResult(undefined);
      setAstSearchError(t("review.astSearchNoContent"));
      return;
    }
    setAstSearchLoading(true);
    setAstSearchError(undefined);
    setAstSearchResult(undefined);
    try {
      if (!props.runtime?.astService) {
        setAstSearchError(t("review.astSearchUnsupported"));
        return;
      }
      const result = await props.runtime.astService({
        operation: "query",
        files,
        query: {
          ...(astSearchNodeKind() ? { nodeKind: astSearchNodeKind() } : {}),
          ...(astSearchText() ? { textIncludes: astSearchText() } : {}),
        },
      });
      setAstSearchResult(result);
    } catch (error) {
      setAstSearchError(error instanceof Error ? error.message : String(error));
    } finally {
      setAstSearchLoading(false);
    }
  }

  async function loadAstBatch() {
    const changes = changesForTab();
    let files: Array<{
      path: string;
      oldText: string;
      newText: string;
      language: string;
    }> = [];
    if (tab() === "git" && props.runtime?.workspaceGitDiff) {
      for (const change of changes) {
        const detail = await props.runtime.workspaceGitDiff({
          workspaceID: props.workspaceID,
          from: gitFrom(),
          to: gitTo(),
          path: change.path,
          includePatch: false,
          includeContent: true,
          ignoreWhitespace: diffIgnoreWhitespace(),
        });
        const file = detail?.[0];
        if (file?.before || file?.after) {
          files.push({
            path: change.path,
            oldText: file.before ?? "",
            newText: file.after ?? "",
            language: languageFromPath(change.path) ?? "plaintext",
          });
        } else if (change.before || change.after) {
          // Non-git fallback from the object store still carries the content.
          files.push({
            path: change.path,
            oldText: change.before ?? "",
            newText: change.after ?? "",
            language: languageFromPath(change.path) ?? "plaintext",
          });
        }
      }
    } else if (
      tab() === "sandbox" &&
      selectedSandbox() &&
      props.runtime?.sandboxDiff
    ) {
      const details =
        (await props.runtime.sandboxDiff(
          selectedSandbox()!,
          props.sessionID,
        )) ?? [];
      files = details
        .filter((change) => change.before || change.after)
        .map((change) => ({
          path: change.path,
          oldText: change.before ?? "",
          newText: change.after ?? "",
          language: languageFromPath(change.path) ?? "plaintext",
        }));
    } else if (
      tab() === "checkpoint" &&
      selectedCheckpoint() &&
      props.runtime?.checkpointPreview
    ) {
      const preview = await props.runtime.checkpointPreview(
        selectedCheckpoint()!,
        props.sessionID,
      );
      const details = preview?.changes ?? [];
      files = details
        .filter((change) => change.before || change.after)
        .map((change) => ({
          path: change.path,
          oldText: change.before ?? "",
          newText: change.after ?? "",
          language: languageFromPath(change.path) ?? "plaintext",
        }));
    } else {
      files = changes
        .filter((change) => change.before || change.after)
        .map((change) => ({
          path: change.path,
          oldText: change.before ?? "",
          newText: change.after ?? "",
          language: languageFromPath(change.path) ?? "plaintext",
        }));
    }
    if (!files.length) {
      setAstBatchResult(undefined);
      setAstBatchError(t("review.astBatchNoContent"));
      return;
    }
    setAstBatchLoading(true);
    setAstBatchError(undefined);
    setAstBatchResult(undefined);
    try {
      if (astBatchMode() === "refactor") {
        if (!props.runtime?.astRefactorPreview) {
          setAstBatchError(t("review.astBatchPreviewUnsupported"));
          return;
        }
        const result = await props.runtime.astRefactorPreview({
          operation: "custom",
          files,
        });
        setAstBatchResult(result);
      } else {
        if (!props.runtime?.astDiffBatch) {
          setAstBatchError(t("review.astBatchUnsupported"));
          return;
        }
        const result = await props.runtime.astDiffBatch({
          files,
        });
        setAstBatchResult(result);
      }
    } catch (error) {
      setAstBatchError(error instanceof Error ? error.message : String(error));
    } finally {
      setAstBatchLoading(false);
    }
  }

  async function loadAstPlan() {
    const from = astPlanFrom().trim();
    const to = astPlanTo().trim();
    if (!from || !to) {
      setAstPlanError(t("review.astNeedNames"));
      return;
    }
    const files = await collectAstSourceFiles();
    if (!files.length) {
      setAstPlanResult(undefined);
      setAstPlanError(t("review.astPlanNoContent"));
      return;
    }
    setAstPlanLoading(true);
    setAstPlanError(undefined);
    setAstPlanResult(undefined);
    try {
      if (!props.runtime?.astRefactorPlan) {
        setAstPlanError(t("review.astPlanUnsupported"));
        return;
      }
      const result = await props.runtime.astRefactorPlan({
        operation: "rename",
        files,
        rename: { from, to },
      });
      setAstPlanResult(result);
    } catch (error) {
      setAstPlanError(error instanceof Error ? error.message : String(error));
    } finally {
      setAstPlanLoading(false);
    }
  }

  async function applyAstPlan() {
    const from = astPlanFrom().trim();
    const to = astPlanTo().trim();
    if (!from || !to) {
      setAstApplyError(t("review.astNeedNames"));
      return;
    }
    const files = await collectAstSourceFiles();
    if (!files.length) {
      setAstApplyError(t("review.astApplyNoContent"));
      return;
    }
    setAstApplyLoading(true);
    setAstApplyError(undefined);
    setAstApplyResult(undefined);
    try {
      if (!props.runtime?.astApplyRefactor) {
        setAstApplyError(t("review.astApplyUnsupported"));
        return;
      }
      const result = await props.runtime.astApplyRefactor({
        operation: "rename",
        files,
        rename: { from, to },
      });
      setAstApplyResult(result);
    } catch (error) {
      setAstApplyError(error instanceof Error ? error.message : String(error));
    } finally {
      setAstApplyLoading(false);
    }
  }

  const astGroups = createMemo(() => {
    const result = astDiffResult();
    if (!result) return [];
    const byKind = new Map<
      string,
      Array<{
        kind: "modified" | "added" | "removed" | "moved";
        nodeKind: string;
        oldStart: number;
        oldEnd: number;
        newStart: number;
        newEnd: number;
      }>
    >();
    for (const change of result.changes) {
      const list = byKind.get(change.nodeKind) ?? [];
      list.push(change);
      byKind.set(change.nodeKind, list);
    }
    return [...byKind.entries()].map(([nodeKind, changes]) => ({
      nodeKind,
      changes,
    }));
  });

  const astBatchGroups = createMemo(() => {
    const result = astBatchResult();
    if (!result) return [];
    const byKind = new Map<
      string,
      Array<{
        path?: string;
        language: string;
        change: {
          kind: "modified" | "added" | "removed" | "moved";
          nodeKind: string;
          oldStart: number;
          oldEnd: number;
          newStart: number;
          newEnd: number;
        };
      }>
    >();
    for (const file of result.files) {
      for (const change of file.changes) {
        const list = byKind.get(change.nodeKind) ?? [];
        list.push({ path: file.path, language: file.language, change });
        byKind.set(change.nodeKind, list);
      }
    }
    return [...byKind.entries()].map(([nodeKind, items]) => ({
      nodeKind,
      items,
    }));
  });

  const [checkpointMode, setCheckpointMode] = createSignal<
    "keypoints" | "bookmarks" | "compare" | "all"
  >("keypoints");
  const [compareFromID, setCompareFromID] = createSignal<string>("");
  const [compareToID, setCompareToID] = createSignal<string>("current");
  const [rollbackBusy, setRollbackBusy] = createSignal(false);
  const [rollbackToast, setRollbackToast] = createSignal<string | undefined>();

  // Reverse chronological (newest first) for human-friendly Time Machine browsing
  const sortedCheckpoints = createMemo(() =>
    [...checkpoints()].sort((a, b) => b.sequence - a.sequence),
  );

  // Deduplicated Keypoints: checkpoints with actual changes, named bookmarks,
  // audit rounds, or the session baseline (filtering out 0-change step/turn noise).
  const keypointCheckpoints = createMemo(() => {
    const list = sortedCheckpoints();
    const filtered = list.filter(
      (cp) =>
        cp.changes > 0 ||
        Boolean(cp.name?.trim()) ||
        cp.reason === "manual" ||
        cp.reason === "audit_round" ||
        cp.reason === "rollback_safety" ||
        cp.reason === "baseline",
    );
    return filtered.length ? filtered : list.slice(0, 15);
  });

  // Bookmarks & Rollback Safety Backups: manual checkpoints, named checkpoints, or rollback_safety
  const bookmarkCheckpoints = createMemo(() =>
    sortedCheckpoints().filter(
      (cp) =>
        cp.reason === "manual" ||
        cp.reason === "rollback_safety" ||
        Boolean(cp.name?.trim()),
    ),
  );

  const visibleCheckpointsForMode = createMemo(() => {
    const mode = checkpointMode();
    if (mode === "bookmarks") return bookmarkCheckpoints();
    if (mode === "all") return sortedCheckpoints();
    return keypointCheckpoints();
  });

  const activeCheckpointObj = createMemo(() =>
    checkpoints().find((cp) => cp.id === selectedCheckpoint()),
  );

  async function runCheckpointCompare(fromID: string, toID: string) {
    if (!fromID || !props.runtime?.roundDiff) return;
    const fromRef = { kind: "checkpoint" as const, id: fromID };
    const toRef =
      toID === "current"
        ? { kind: "current" as const }
        : { kind: "checkpoint" as const, id: toID };
    try {
      const changes =
        (await props.runtime.roundDiff({
          workspaceID: props.workspaceID,
          from: fromRef,
          to: toRef,
          includePatch: true,
          includeContent: true,
        })) ?? [];
      const mapped = changes.map(toDiffItem);
      const current = checkpointSelected();
      setCheckpointChanges(mapped);
      if (!current || !mapped.some((item) => item.path === current)) {
        setCheckpointSelected(mapped[0]?.path ?? null);
      }
    } catch {
      setCheckpointChanges([]);
      setCheckpointSelected(null);
    }
  }

  async function handleRollbackToSelected() {
    const target = activeCheckpointObj();
    if (!target || rollbackBusy()) return;
    const label = checkpointLabel(target);
    if (!window.confirm(t("review.cpRollbackConfirm", { label }))) return;
    setRollbackBusy(true);
    setRollbackToast(undefined);
    try {
      await props.runtime?.checkpointRollback?.({
        id: target.id,
        dryRun: false,
        sessionID: props.sessionID,
      });
      setRollbackToast(
        t("review.cpRollbackDone", { id: target.name || target.id }),
      );
      await refreshCheckpoints();
      await loadCheckpointPreview(target.id);
    } finally {
      setRollbackBusy(false);
    }
  }

  const selectedTeamPR = () =>
    teamPRs().find((pr) => pr.sandboxID === selectedSandbox());

  function startFileResize(event: PointerEvent) {
    event.preventDefault();
    const target = event.currentTarget as HTMLElement;
    target.setPointerCapture?.(event.pointerId);
    const startX = event.clientX;
    const startWidth = fileWidth();
    const move = (next: PointerEvent) =>
      setFileWidth(
        Math.max(140, Math.min(220, startWidth + next.clientX - startX)),
      );
    const finish = (next: PointerEvent) => {
      target.releasePointerCapture?.(next.pointerId);
      target.removeEventListener("pointermove", move);
      target.removeEventListener("pointerup", finish);
      target.removeEventListener("pointercancel", finish);
    };
    target.addEventListener("pointermove", move);
    target.addEventListener("pointerup", finish);
    target.addEventListener("pointercancel", finish);
  }

  function toggleFileCard(path: string) {
    if (selectedForTab() === path) {
      if (tab() === "git") setGitSelected(null);
      else if (tab() === "sandbox") setSandboxSelected(null);
      else if (tab() === "rounds") setRoundSelected(null);
      else setCheckpointSelected(null);
      return;
    }
    if (tab() === "git") void selectGitFile(path);
    else if (tab() === "sandbox") setSandboxSelected(path);
    else if (tab() === "rounds") setRoundSelected(path);
    else setCheckpointSelected(path);
  }

  function selectTab(next: ReviewSubTab) {
    setTab(next);
    if (next === "sandbox") void loadSandboxTab();
    if (next === "checkpoint") void loadCheckpointTab();
    if (next === "rounds") void loadRounds();
  }

  let reviewScopeInitialized = false;
  let reviewScope = "";
  createEffect(() => {
    const sessionID = props.sessionID ?? "";
    const workspaceID = props.workspaceID ?? "";
    const nextScope = `${workspaceID}:${sessionID}`;
    if (reviewScopeInitialized && nextScope === reviewScope) return;
    reviewScopeInitialized = true;
    reviewScope = nextScope;

    setLoaded(false);
    setSandboxLoaded(false);
    setCheckpointLoaded(false);
    gitPatchCache.clear();
    gitPatchCacheScope = "";
    setGitChanges([]);
    setGitSelected(null);
    setGitRefs([]);
    setSandboxes([]);
    setTeamPRs([]);
    setSelectedSandbox(null);
    setSandboxChanges([]);
    setSandboxSelected(null);
    setCheckpoints([]);
    setSelectedCheckpoint(null);
    setCheckpointChanges([]);
    setCheckpointSelected(null);
    setAuditRounds([]);
    setRoundChanges([]);
    setRoundSelected(null);
    setAstDiffResult(undefined);
    setStructuredDiff(undefined);
    setStructuredDiffError(undefined);
    setAstDiffError(undefined);

    void (async () => {
      const refs =
        (await props.runtime?.gitRefs?.({ workspaceID: props.workspaceID })) ??
        [];
      if (nextScope !== reviewScope) return;
      setGitRefs(refs);
      const currentBranch = refs.find(
        (ref) => ref.kind === "branch" && ref.current,
      )?.name;
      setGitFrom(currentBranch ?? "HEAD");
      await loadGit();
      if (nextScope !== reviewScope) return;
      setLoaded(true);
    })();
  });

  return (
    <div class="review-pane">
      <div class="review-subtabs">
        <button
          type="button"
          class="review-subtab"
          data-active={tab() === "git"}
          onClick={() => selectTab("git")}
        >
          {t("review.tabGit")}
        </button>
        <button
          type="button"
          class="review-subtab"
          data-active={tab() === "sandbox"}
          onClick={() => selectTab("sandbox")}
        >
          {t("review.tabSandbox")}
        </button>
        <button
          type="button"
          class="review-subtab"
          data-active={tab() === "checkpoint" || tab() === "rounds"}
          onClick={() => selectTab("checkpoint")}
        >
          {t("review.tabCheckpoint")}
        </button>
      </div>
      <Show when={tab() === "git" && diffScope() === "all"}>
        <div class={styles.gitRanges}>
          <NeuSelect
            value={gitFrom()}
            options={[
              { value: "HEAD", label: t("review.gitHeadLabel") },
              ...gitRefs().map((ref) => ({
                value: ref.name,
                label:
                  ref.kind === "worktree"
                    ? `${ref.name} (worktree)`
                    : `${ref.name} (${ref.kind})`,
              })),
            ]}
            onChange={(value) => {
              setGitFrom(value);
              void loadGit();
            }}
          />
          <span class={styles.gitArrow}>→</span>
          <NeuSelect
            value={gitTo()}
            options={[
              { value: "WORKTREE", label: t("review.gitWorktreeLabel") },
              ...gitRefs().map((ref) => ({
                value: ref.name,
                label:
                  ref.kind === "worktree"
                    ? `${ref.name} (worktree)`
                    : `${ref.name} (${ref.kind})`,
              })),
            ]}
            onChange={(value) => {
              setGitTo(value);
              void loadGit();
            }}
          />
        </div>
      </Show>
      <Show when={tab() === "sandbox" && teamPRs().length}>
        <div class="review-section-label">Team PRs</div>
        <div class="review-entity-list">
          <For each={teamPRs()}>
            {(pr) => (
              <button
                type="button"
                class={styles.entityButton}
                data-active={selectedSandbox() === pr.sandboxID}
                onClick={() => void selectSandbox(pr.sandboxID)}
              >
                {pr.id}
                <span class={styles.entityCount}>{pr.status}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={tab() === "sandbox" && sandboxes().length}>
        <div class="review-entity-list">
          <For each={sandboxes()}>
            {(sandbox) => (
              <button
                type="button"
                class={styles.entityButton}
                data-active={selectedSandbox() === sandbox.id}
                onClick={() => void selectSandbox(sandbox.id)}
              >
                {sandbox.id}
                <span class={styles.entityCount}>{sandbox.changedFiles}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={tab() === "sandbox" && selectedTeamPR()}>
        <div class={styles.prDetail}>
          <div class={styles.prRow}>
            <span class={styles.prLabel}>Task</span>
            <span class={styles.prText}>{selectedTeamPR()!.task}</span>
          </div>
          <div class={styles.prRow}>
            <span class={styles.prLabel}>Status</span>
            <span class={styles.prText}>{selectedTeamPR()!.status}</span>
          </div>
          <Show when={selectedTeamPR()!.result}>
            <div class={styles.prRow}>
              <span class={styles.prLabel}>Result</span>
              <pre class={styles.prResult}>{selectedTeamPR()!.result}</pre>
            </div>
          </Show>
          <Show when={selectedTeamPR()!.buildEvidence}>
            <div class={styles.prRow}>
              <span class={styles.prLabel}>Build</span>
              <span class={styles.prText}>
                {selectedTeamPR()!.buildEvidence!.ok ? "passed" : "failed"} ·
                exit {selectedTeamPR()!.buildEvidence!.exitCode}
              </span>
            </div>
            <Show when={selectedTeamPR()!.buildEvidence!.output}>
              <pre class={styles.prResult}>
                {selectedTeamPR()!.buildEvidence!.output}
              </pre>
            </Show>
          </Show>
        </div>
      </Show>
      <Show when={tab() === "checkpoint" && checkpoints().length}>
        <div class={styles.cpDeck}>
          <div class={styles.cpCategoryBar}>
            <button
              type="button"
              class={styles.segBtn}
              data-active={checkpointMode() === "keypoints"}
              onClick={() => {
                setCheckpointMode("keypoints");
                const first = keypointCheckpoints()[0];
                if (first) void selectCheckpoint(first.id);
              }}
            >
              {t("review.cpModeKeypoints")} ({keypointCheckpoints().length})
            </button>
            <button
              type="button"
              class={styles.segBtn}
              data-active={checkpointMode() === "bookmarks"}
              onClick={() => {
                setCheckpointMode("bookmarks");
                const first = bookmarkCheckpoints()[0];
                if (first) void selectCheckpoint(first.id);
              }}
            >
              {t("review.cpModeBookmarks")} ({bookmarkCheckpoints().length})
            </button>
            <button
              type="button"
              class={styles.segBtn}
              data-active={checkpointMode() === "compare"}
              onClick={() => {
                setCheckpointMode("compare");
                const list = sortedCheckpoints();
                const from = compareFromID() || list[list.length - 1]?.id || "";
                setCompareFromID(from);
                void runCheckpointCompare(from, compareToID());
              }}
            >
              {t("review.cpModeCompare")}
            </button>
            <button
              type="button"
              class={styles.segBtn}
              data-active={checkpointMode() === "all"}
              onClick={() => setCheckpointMode("all")}
            >
              {t("review.cpModeAll", { count: checkpoints().length })}
            </button>
          </div>

          <Show when={rollbackToast()}>
            <div class="neu-gov-action-note">{rollbackToast()}</div>
          </Show>

          <Show
            when={checkpointMode() !== "compare"}
            fallback={
              <div class={styles.gitRanges}>
                <NeuSelect
                  value={compareFromID()}
                  placeholder={t("review.cpSelectFrom")}
                  options={sortedCheckpoints().map((cp) => ({
                    value: cp.id,
                    label: checkpointLabel(cp),
                  }))}
                  onChange={(value) => {
                    setCompareFromID(value);
                    void runCheckpointCompare(value, compareToID());
                  }}
                />
                <span class={styles.gitArrow}>→</span>
                <NeuSelect
                  value={compareToID()}
                  placeholder={t("review.cpSelectTo")}
                  options={[
                    { value: "current", label: t("review.gitWorktreeLabel") },
                    ...sortedCheckpoints().map((cp) => ({
                      value: cp.id,
                      label: checkpointLabel(cp),
                    })),
                  ]}
                  onChange={(value) => {
                    setCompareToID(value);
                    void runCheckpointCompare(compareFromID(), value);
                  }}
                />
              </div>
            }
          >
            <Show
              when={visibleCheckpointsForMode().length > 0}
              fallback={
                <div class={styles.cpEmptyHint}>
                  {t("review.cpEmptyBookmarks")}
                </div>
              }
            >
              <div class={styles.cpActionBar}>
                <div class={styles.cpSelectWrap}>
                  <NeuSelect
                    value={selectedCheckpoint() ?? ""}
                    options={visibleCheckpointsForMode().map((checkpoint) => ({
                      value: checkpoint.id,
                      label: checkpointLabel(checkpoint),
                    }))}
                    onChange={(value) => void selectCheckpoint(value)}
                  />
                </div>
                <Show when={activeCheckpointObj()}>
                  {(activeCp) => (
                    <div class={styles.cpButtons}>
                      <Show
                        when={renamingCheckpointID() === activeCp().id}
                        fallback={
                          <button
                            type="button"
                            class={styles.checkpointRenameBtn}
                            onClick={() => beginRenameCheckpoint(activeCp())}
                          >
                            {t("review.rename")}
                          </button>
                        }
                      >
                        <input
                          class="review-checkpoint-rename-input"
                          value={checkpointNameDraft()}
                          placeholder={t("review.snapshotNamePh")}
                          onInput={(event) =>
                            setCheckpointNameDraft(event.currentTarget.value)
                          }
                          onKeyDown={(event) => {
                            if (event.key === "Enter")
                              void commitRenameCheckpoint();
                            if (event.key === "Escape")
                              setRenamingCheckpointID(null);
                          }}
                        />
                        <button
                          type="button"
                          class={styles.checkpointRenameBtn}
                          onClick={() => void commitRenameCheckpoint()}
                        >
                          {t("review.save")}
                        </button>
                      </Show>
                      <button
                        type="button"
                        class={styles.cpRollbackBtn}
                        disabled={rollbackBusy()}
                        onClick={() => void handleRollbackToSelected()}
                      >
                        {t("review.cpRollbackBtn")}
                      </button>
                    </div>
                  )}
                </Show>
              </div>
            </Show>
          </Show>
        </div>
      </Show>
      <div class="review-header">
        <div class="review-title">
          <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
            <path
              d="M2 5C2 3.89543 2.89543 3 4 3H6.5L8 4.5H10C11.1046 4.5 12 5.39543 12 6.5V10C12 11.1046 11.1046 12 10 12H4C2.89543 12 2 11.1046 2 10V5Z"
              stroke="currentColor"
              stroke-width="1.2"
            />
            <path d="M2 7H12" stroke="currentColor" stroke-width="1.2" />
          </svg>
          <span class="review-count">
            {t("review.filesCount", { count: changesForTab().length })}
          </span>
          <span class={styles.additions}>+{totalAdditions()}</span>
          <span class={styles.deletions}>-{totalDeletions()}</span>
        </div>
        <div class={styles.diffActions}>
          <Show when={tab() === "git"}>
            <div class={styles.segGroup}>
              <button
                type="button"
                class={styles.segBtn}
                data-active={diffScope() === "session"}
                title={t("review.tooltipSession")}
                onClick={() => {
                  setDiffScope("session");
                  void loadGit();
                }}
              >
                {t("review.scopeSession")}
              </button>
              <button
                type="button"
                class={styles.segBtn}
                data-active={diffScope() === "all"}
                title={t("review.tooltipGlobal")}
                onClick={() => {
                  setDiffScope("all");
                  void loadGit();
                }}
              >
                {t("review.scopeGlobal")}
              </button>
            </div>
            <button
              type="button"
              class={styles.iconBtn}
              data-active={diffIgnoreWhitespace()}
              title={t("review.tooltipIgnoreWhitespace")}
              onClick={() => {
                setDiffIgnoreWhitespace((value) => !value);
                void loadGit();
              }}
            >
              W
            </button>
          </Show>
          <div class={styles.segGroup}>
            <button
              type="button"
              class={styles.segBtn}
              data-active={viewMode() === "unified"}
              onClick={() => {
                setViewMode("unified");
                setAstBatchPanelOpen(false);
              }}
            >
              {t("review.viewUnified")}
            </button>
            <button
              type="button"
              class={styles.segBtn}
              data-active={viewMode() === "split"}
              onClick={() => {
                setViewMode("split");
                setAstBatchPanelOpen(false);
              }}
            >
              {t("review.viewSplit")}
            </button>
            <button
              type="button"
              class={styles.segBtn}
              data-active={viewMode() === "ast"}
              onClick={() => {
                setViewMode("ast");
                setAstBatchPanelOpen(false);
                void loadAstDiffForSelectedFile();
              }}
            >
              {t("review.viewAst")}
            </button>
          </div>
        </div>
      </div>
      <Show when={viewMode() === "ast"}>
        <div class={styles.astSubbar}>
          <button
            type="button"
            class={styles.segBtn}
            data-active={!astBatchPanelOpen()}
            onClick={() => {
              setAstBatchPanelOpen(false);
              void loadAstDiffForSelectedFile();
            }}
          >
            {t("review.astFile")}
          </button>
          <button
            type="button"
            class={styles.segBtn}
            data-active={astBatchPanelOpen() && astBatchMode() === "structure"}
            onClick={() => {
              setAstBatchPanelOpen(true);
              setAstBatchMode("structure");
              void loadAstBatch();
            }}
          >
            {t("review.astBatch")}
          </button>
          <button
            type="button"
            class={styles.segBtn}
            data-active={astBatchPanelOpen() && astBatchMode() === "refactor"}
            onClick={() => {
              setAstBatchPanelOpen(true);
              setAstBatchMode("refactor");
              void loadAstBatch();
            }}
          >
            {t("review.astRefactor")}
          </button>
          <button
            type="button"
            class={styles.segBtn}
            data-active={astBatchPanelOpen() && astBatchMode() === "search"}
            onClick={() => {
              setAstBatchPanelOpen(true);
              setAstBatchMode("search");
              setAstSearchResult(undefined);
              setAstSearchError(undefined);
            }}
          >
            {t("review.astSearch")}
          </button>
          <button
            type="button"
            class={styles.segBtn}
            data-active={astBatchPanelOpen() && astBatchMode() === "plan"}
            onClick={() => {
              setAstBatchPanelOpen(true);
              setAstBatchMode("plan");
              setAstPlanResult(undefined);
              setAstPlanError(undefined);
            }}
          >
            {t("review.astPlan")}
          </button>
        </div>
      </Show>
      <div class="review-body">
        <Show
          when={!loaded()}
          fallback={
            <Show
              when={changesForTab().length}
              fallback={
                <PanelState
                  state="empty"
                  title={
                    tab() === "rounds"
                      ? t("review.emptyRounds")
                      : t("review.emptyChanges")
                  }
                  description={
                    tab() === "rounds"
                      ? t("review.emptyRoundsHint")
                      : t("review.emptyChangesHint")
                  }
                />
              }
            >
              <div class={styles.accordionStream}>
                <Show when={viewMode() === "ast" && astBatchPanelOpen()}>
                  <div class={styles.accordionCard} data-expanded="true">
                    <div class={styles.accordionBody}>
                      <Show when={astBatchMode() === "search"}>
                        <div class={styles.astSearchForm}>
                          <input
                            type="text"
                            placeholder={t("review.astContainsPh")}
                            value={astSearchText()}
                            onInput={(event) =>
                              setAstSearchText(event.currentTarget.value)
                            }
                          />
                          <input
                            type="text"
                            placeholder={t("review.nodeTypePh")}
                            value={astSearchNodeKind()}
                            onInput={(event) =>
                              setAstSearchNodeKind(event.currentTarget.value)
                            }
                          />
                          <button
                            type="button"
                            onClick={() => void loadAstSearch()}
                          >
                            {t("review.search")}
                          </button>
                        </div>
                        <Show when={astSearchLoading()}>
                          <PanelState
                            state="loading"
                            title={t("review.astSearching")}
                          />
                        </Show>
                        <Show when={astSearchError()}>
                          <PanelState
                            state="error"
                            title={t("review.astSearchFailed")}
                            description={astSearchError()}
                          />
                        </Show>
                        <Show when={astSearchResult()}>
                          <div class={styles.astDiffList}>
                            <Show
                              when={!(astSearchResult()!.matches ?? []).length}
                            >
                              <PanelState
                                state="empty"
                                title={t("review.noMatchNodes")}
                              />
                            </Show>
                            <For each={astSearchResult()!.matches ?? []}>
                              {(file) => (
                                <div class={styles.astChangeGroup}>
                                  <div class={styles.astGroupHeader}>
                                    <span class="ast-group-name">
                                      {file.path ?? "?"}
                                    </span>
                                    <span class={styles.astGroupCount}>
                                      {file.nodes.length}
                                    </span>
                                  </div>
                                  <For each={file.nodes}>
                                    {(node) => (
                                      <div
                                        class={styles.astChangeRow}
                                        data-kind={node.nodeKind}
                                      >
                                        <span class={styles.astChangeKind}>
                                          {node.nodeKind}
                                        </span>
                                        <span class={styles.astChangeNode}>
                                          {node.text || "—"}
                                        </span>
                                        <span class={styles.astChangePos}>
                                          {node.start}-{node.end}
                                        </span>
                                      </div>
                                    )}
                                  </For>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </Show>

                      <Show when={astBatchMode() === "plan"}>
                        <div class={styles.astSearchForm}>
                          <input
                            type="text"
                            placeholder={t("review.oldNamePh")}
                            value={astPlanFrom()}
                            onInput={(event) =>
                              setAstPlanFrom(event.currentTarget.value)
                            }
                          />
                          <input
                            type="text"
                            placeholder={t("review.newNamePh")}
                            value={astPlanTo()}
                            onInput={(event) =>
                              setAstPlanTo(event.currentTarget.value)
                            }
                          />
                          <button
                            type="button"
                            onClick={() => void loadAstPlan()}
                          >
                            {t("review.genPlan")}
                          </button>
                          <button
                            type="button"
                            onClick={() => void applyAstPlan()}
                          >
                            {t("review.applyChanges")}
                          </button>
                        </div>
                        <Show when={astPlanLoading()}>
                          <PanelState
                            state="loading"
                            title={t("review.planGenerating")}
                          />
                        </Show>
                        <Show when={astPlanError()}>
                          <PanelState
                            state="error"
                            title={t("review.planFailed")}
                            description={astPlanError()}
                          />
                        </Show>
                        <Show when={astPlanResult()}>
                          <div class={styles.astDiffList}>
                            <Show when={!astPlanResult()!.targets.length}>
                              <PanelState
                                state="empty"
                                title={t("review.noRefactorNodes")}
                              />
                            </Show>
                            <For each={astPlanResult()!.targets}>
                              {(target) => (
                                <div
                                  class={styles.astChangeRow}
                                  data-kind={target.nodeKind}
                                >
                                  <span class={styles.astChangeKind}>
                                    {target.nodeKind}
                                  </span>
                                  <span class={styles.astChangeNode}>
                                    {target.text} →{" "}
                                    {target.suggestedText ?? "?"}
                                  </span>
                                  <span class={styles.astChangePos}>
                                    {target.path ?? "?"}
                                  </span>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                        <Show when={astApplyLoading()}>
                          <PanelState
                            state="loading"
                            title={t("review.autoApplying")}
                          />
                        </Show>
                        <Show when={astApplyError()}>
                          <PanelState
                            state="error"
                            title={t("review.autoApplyFailed")}
                            description={astApplyError()}
                          />
                        </Show>
                        <Show when={astApplyResult()}>
                          <div class="review-empty">
                            <div class="review-empty-title">
                              {t("review.appliedChanges")}
                              {
                                astApplyResult()!.applied.filter(
                                  (item) => !item.error,
                                ).length
                              }
                              / {astApplyResult()!.applied.length}
                            </div>
                          </div>
                        </Show>
                      </Show>

                      <Show
                        when={
                          astBatchMode() !== "search" &&
                          astBatchMode() !== "plan"
                        }
                      >
                        <Show when={astBatchLoading()}>
                          <PanelState
                            state="loading"
                            title={
                              astBatchMode() === "refactor"
                                ? t("review.previewComputing")
                                : t("review.batchComputing")
                            }
                          />
                        </Show>
                        <Show when={astBatchError()}>
                          <PanelState
                            state="error"
                            title={
                              astBatchMode() === "refactor"
                                ? t("review.previewFailed")
                                : t("review.batchFailed")
                            }
                            description={astBatchError()}
                          />
                        </Show>
                        <Show when={astBatchResult()}>
                          <div class={styles.astDiffList}>
                            <Show when={!astBatchGroups().length}>
                              <PanelState
                                state="empty"
                                title={t("review.noBatchChanges")}
                              />
                            </Show>
                            <For each={astBatchGroups()}>
                              {(group) => (
                                <div class={styles.astChangeGroup}>
                                  <div class={styles.astGroupHeader}>
                                    <span class="ast-group-name">
                                      {group.nodeKind}
                                    </span>
                                    <span class={styles.astGroupCount}>
                                      {group.items.length}
                                    </span>
                                  </div>
                                  <For each={group.items}>
                                    {(item) => (
                                      <div
                                        class={styles.astChangeRow}
                                        data-kind={item.change.kind}
                                      >
                                        <span class={styles.astChangeKind}>
                                          {item.change.kind}
                                        </span>
                                        <span class={styles.astChangeNode}>
                                          {item.change.nodeKind}
                                        </span>
                                        <span class={styles.astChangePos}>
                                          {item.path ?? "?"}
                                        </span>
                                      </div>
                                    )}
                                  </For>
                                </div>
                              )}
                            </For>
                          </div>
                        </Show>
                      </Show>
                    </div>
                  </div>
                </Show>

                <For each={changesForTab()}>
                  {(change) => {
                    const isExpanded = () => selectedForTab() === change.path;
                    return (
                      <div
                        class={styles.accordionCard}
                        data-expanded={isExpanded()}
                      >
                        <div class={styles.accordionHeader}>
                          <button
                            type="button"
                            class={styles.accordionTrigger}
                            aria-expanded={isExpanded()}
                            onClick={() => toggleFileCard(change.path)}
                          >
                            <span
                              class={`review-file-status ${change.operation === "added" ? "is-added" : change.operation === "deleted" ? "is-deleted" : "is-modified"}`}
                            >
                              {statusFor(change.operation)}
                            </span>
                            <span class={styles.accordionPath}>
                              {change.path}
                            </span>
                            <span class={styles.accordionStats}>
                              <Show when={change.additions !== undefined}>
                                <span class={styles.additions}>
                                  +{change.additions}
                                </span>
                              </Show>
                              <Show when={change.deletions !== undefined}>
                                <span class={styles.deletions}>
                                  -{change.deletions}
                                </span>
                              </Show>
                            </span>
                            <span
                              class={styles.accordionChevron}
                              data-open={isExpanded()}
                            >
                              ▾
                            </span>
                          </button>
                          <button
                            type="button"
                            class={styles.openFileBtn}
                            title={change.path}
                            onClick={() => {
                              window.dispatchEvent(
                                new CustomEvent("natalia:open-file", {
                                  detail: { path: change.path, line: 1 },
                                }),
                              );
                            }}
                          >
                            ↗
                          </button>
                        </div>

                        <Show when={isExpanded()}>
                          <div class={styles.accordionBody}>
                            <Show
                              when={
                                (viewMode() === "ast" &&
                                  !astBatchPanelOpen()) ||
                                selectedFile()?.patch ||
                                selectedFile()?.before ||
                                selectedFile()?.after ||
                                hasRenderableStructured(
                                  selectedFile()?.structured,
                                ) ||
                                hasRenderableStructured(structuredDiff())
                              }
                              fallback={
                                <div class="review-diff-content">
                                  <PanelState
                                    state="empty"
                                    title={t("review.noLineDiff")}
                                    description={t("review.noLineDiffHint")}
                                  />
                                </div>
                              }
                            >
                              <Show
                                when={
                                  viewMode() === "ast" && !astBatchPanelOpen()
                                }
                              >
                                <div class="review-diff-content">
                                  <Show
                                    when={astDiffError()}
                                    fallback={
                                      <Show
                                        when={astDiffResult()}
                                        fallback={
                                          <PanelState
                                            state="loading"
                                            title={t("review.loadingAst")}
                                          />
                                        }
                                      >
                                        <div class={styles.astDiffList}>
                                          <Show
                                            when={
                                              !astDiffResult()!.changes.length
                                            }
                                          >
                                            <PanelState
                                              state="empty"
                                              title={t(
                                                "review.noStructuralChanges",
                                              )}
                                            />
                                          </Show>
                                          <For each={astGroups()}>
                                            {(group) => (
                                              <div
                                                class={styles.astChangeGroup}
                                              >
                                                <button
                                                  type="button"
                                                  class={styles.astGroupHeader}
                                                  onClick={() =>
                                                    setCollapsedAstGroups(
                                                      (prev) => {
                                                        const next = new Set(
                                                          prev,
                                                        );
                                                        if (
                                                          next.has(
                                                            group.nodeKind,
                                                          )
                                                        )
                                                          next.delete(
                                                            group.nodeKind,
                                                          );
                                                        else
                                                          next.add(
                                                            group.nodeKind,
                                                          );
                                                        return next;
                                                      },
                                                    )
                                                  }
                                                >
                                                  <span class="ast-group-name">
                                                    {collapsedAstGroups().has(
                                                      group.nodeKind,
                                                    )
                                                      ? "▸"
                                                      : "▾"}{" "}
                                                    {group.nodeKind}
                                                  </span>
                                                  <span
                                                    class={styles.astGroupCount}
                                                  >
                                                    {group.changes.length}
                                                  </span>
                                                </button>
                                                <Show
                                                  when={
                                                    !collapsedAstGroups().has(
                                                      group.nodeKind,
                                                    )
                                                  }
                                                >
                                                  <For each={group.changes}>
                                                    {(astChange) => (
                                                      <div
                                                        class={
                                                          styles.astChangeRow
                                                        }
                                                        data-kind={
                                                          astChange.kind
                                                        }
                                                        onClick={() => {
                                                          const file =
                                                            selectedFile();
                                                          if (!file) return;
                                                          const source =
                                                            astChange.kind ===
                                                            "removed"
                                                              ? (file.before ??
                                                                "")
                                                              : (file.after ??
                                                                "");
                                                          const start =
                                                            astChange.kind ===
                                                            "removed"
                                                              ? astChange.oldStart
                                                              : astChange.newStart;
                                                          const end =
                                                            astChange.kind ===
                                                            "removed"
                                                              ? astChange.oldEnd
                                                              : astChange.newEnd;
                                                          setAstSnippet({
                                                            kind: astChange.kind,
                                                            nodeKind:
                                                              astChange.nodeKind,
                                                            text: source.slice(
                                                              start,
                                                              end,
                                                            ),
                                                          });
                                                        }}
                                                      >
                                                        <span
                                                          class={
                                                            styles.astChangeKind
                                                          }
                                                        >
                                                          {astChange.kind}
                                                        </span>
                                                        <span
                                                          class={
                                                            styles.astChangeNode
                                                          }
                                                        >
                                                          {astChange.nodeKind}
                                                        </span>
                                                        <span
                                                          class={
                                                            styles.astChangePos
                                                          }
                                                        >
                                                          {astChange.kind ===
                                                          "removed"
                                                            ? `${astChange.oldStart}-${astChange.oldEnd}`
                                                            : `${astChange.newStart}-${astChange.newEnd}`}
                                                        </span>
                                                      </div>
                                                    )}
                                                  </For>
                                                </Show>
                                              </div>
                                            )}
                                          </For>
                                        </div>
                                        <Show when={astSnippet()}>
                                          <pre class={styles.astSnippet}>
                                            {astSnippet()!.text}
                                          </pre>
                                        </Show>
                                      </Show>
                                    }
                                  >
                                    <PanelState
                                      state="error"
                                      title={t("review.astDiffFailed")}
                                      description={astDiffError()}
                                    />
                                  </Show>
                                </div>
                              </Show>
                              <Show
                                when={
                                  viewMode() !== "ast" &&
                                  (hasRenderableStructured(
                                    selectedFile()?.structured,
                                  ) ||
                                    hasRenderableStructured(structuredDiff()))
                                }
                              >
                                <Show
                                  when={viewMode() === "split"}
                                  fallback={
                                    <UnifiedDiffView
                                      rows={structuredRows(
                                        (hasRenderableStructured(
                                          selectedFile()?.structured,
                                        )
                                          ? selectedFile()?.structured
                                          : structuredDiff())!,
                                      )}
                                      language={languageFromPath(
                                        selectedFile()?.path ?? "",
                                      )}
                                    />
                                  }
                                >
                                  <SplitDiffView
                                    rows={buildSplitRows(
                                      (hasRenderableStructured(
                                        selectedFile()?.structured,
                                      )
                                        ? selectedFile()?.structured
                                        : structuredDiff())!,
                                    )}
                                    language={languageFromPath(
                                      selectedFile()?.path ?? "",
                                    )}
                                  />
                                </Show>
                              </Show>
                              <Show
                                when={
                                  viewMode() !== "ast" &&
                                  !hasRenderableStructured(
                                    selectedFile()?.structured,
                                  ) &&
                                  !hasRenderableStructured(structuredDiff()) &&
                                  structuredDiffError()
                                }
                              >
                                <div class="review-diff-content">
                                  <div class={styles.diffRaw}>
                                    <div class={styles.diffRawTitle}>
                                      {t("review.diffFailed")}
                                    </div>
                                    <pre>{structuredDiffError()}</pre>
                                  </div>
                                </div>
                              </Show>
                              <Show
                                when={
                                  viewMode() !== "ast" &&
                                  !hasRenderableStructured(
                                    selectedFile()?.structured,
                                  ) &&
                                  !hasRenderableStructured(structuredDiff()) &&
                                  !structuredDiffError() &&
                                  selectedFile()?.patch
                                }
                              >
                                <UnifiedDiffView
                                  rows={diffLines(selectedFile()!.patch)}
                                  language={languageFromPath(
                                    selectedFile()!.path,
                                  )}
                                />
                              </Show>
                              <Show
                                when={
                                  viewMode() !== "ast" &&
                                  !hasRenderableStructured(
                                    selectedFile()?.structured,
                                  ) &&
                                  !hasRenderableStructured(structuredDiff()) &&
                                  !structuredDiffError() &&
                                  !selectedFile()?.patch &&
                                  selectedFile()?.before
                                }
                              >
                                <div class="review-diff-content">
                                  <div class={styles.diffRaw}>
                                    <div class={styles.diffRawTitle}>
                                      Before
                                    </div>
                                    <pre>{selectedFile()!.before}</pre>
                                  </div>
                                </div>
                              </Show>
                              <Show
                                when={
                                  viewMode() !== "ast" &&
                                  !hasRenderableStructured(
                                    selectedFile()?.structured,
                                  ) &&
                                  !hasRenderableStructured(structuredDiff()) &&
                                  !structuredDiffError() &&
                                  !selectedFile()?.patch &&
                                  selectedFile()?.after
                                }
                              >
                                <div class="review-diff-content">
                                  <div class={styles.diffRaw}>
                                    <div class={styles.diffRawTitle}>After</div>
                                    <pre>{selectedFile()!.after}</pre>
                                  </div>
                                </div>
                              </Show>
                            </Show>
                          </div>
                        </Show>
                      </div>
                    );
                  }}
                </For>
              </div>
            </Show>
          }
        >
          <PanelState state="loading" title={t("review.readingChanges")} />
        </Show>
      </div>
    </div>
  );
}
