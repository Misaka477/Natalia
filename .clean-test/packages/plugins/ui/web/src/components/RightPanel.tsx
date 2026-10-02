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
    runtime?: RuntimeClient;
    requestedTab?: ReviewSubTab;
    requestedCheckpointID?: string;
    sessionID?: string;
    workspaceID?: string;
    events?: {
      subscribe(listener: (event: RuntimeEvent) => void): () => void;
    };
  } = {},
) {
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
          await loadCheckpointPreview(selectedCheckpoint()!, {
            includePatch: false,
          });
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
      await loadSandboxDiff(firstSandboxID, { includePatch: false });
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
      await loadCheckpointPreview(latest, { includePatch: false });
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
    setGitSelected(pickGitSelection(mapped));
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
      if (mapped.length) setSandboxSelected(mapped[0]!.path);
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
    setCheckpointChanges(mapped);
    if (mapped.length) setCheckpointSelected(mapped[0]!.path);
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
    const title = checkpoint.name?.trim() || checkpoint.id;
    return `${title} · ${checkpoint.changes} changes · step ${checkpoint.step}`;
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

  async function loadStructuredDiffForFile(file: DiffItem) {
    // Runtime structured diffs are canonical. The worker path below is only a
    // fallback for before/after-only data that did not come with structured.
    if (file.structured) {
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
      setAstDiffError("当前 runtime 不支持 AST diff");
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
      setAstSearchError("当前没有可做 AST 搜索的文件内容");
      return;
    }
    setAstSearchLoading(true);
    setAstSearchError(undefined);
    setAstSearchResult(undefined);
    try {
      if (!props.runtime?.astService) {
        setAstSearchError("当前 runtime 不支持 AST 搜索");
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
      setAstBatchError("当前没有可做 AST diff 的文件内容");
      return;
    }
    setAstBatchLoading(true);
    setAstBatchError(undefined);
    setAstBatchResult(undefined);
    try {
      if (astBatchMode() === "refactor") {
        if (!props.runtime?.astRefactorPreview) {
          setAstBatchError("当前 runtime 不支持重构预览");
          return;
        }
        const result = await props.runtime.astRefactorPreview({
          operation: "custom",
          files,
        });
        setAstBatchResult(result);
      } else {
        if (!props.runtime?.astDiffBatch) {
          setAstBatchError("当前 runtime 不支持批量 AST diff");
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
      setAstPlanError("请输入旧名称和新名称");
      return;
    }
    const files = await collectAstSourceFiles();
    if (!files.length) {
      setAstPlanResult(undefined);
      setAstPlanError("当前没有可做重构计划的文件内容");
      return;
    }
    setAstPlanLoading(true);
    setAstPlanError(undefined);
    setAstPlanResult(undefined);
    try {
      if (!props.runtime?.astRefactorPlan) {
        setAstPlanError("当前 runtime 不支持重构计划");
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
      setAstApplyError("请输入旧名称和新名称");
      return;
    }
    const files = await collectAstSourceFiles();
    if (!files.length) {
      setAstApplyError("当前没有可做自动改写的文件内容");
      return;
    }
    setAstApplyLoading(true);
    setAstApplyError(undefined);
    setAstApplyResult(undefined);
    try {
      if (!props.runtime?.astApplyRefactor) {
        setAstApplyError("当前 runtime 不支持自动改写");
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

  const auditCheckpoints = () =>
    checkpoints().filter(
      (checkpoint) =>
        checkpoint.reason === "audit_round" || checkpoint.reason === "baseline",
    );
  const userCheckpoints = () =>
    checkpoints().filter((checkpoint) => checkpoint.reason === "manual");
  const autoCheckpoints = () =>
    checkpoints().filter(
      (checkpoint) =>
        checkpoint.reason !== "rollback_safety" &&
        checkpoint.reason !== "manual" &&
        checkpoint.reason !== "audit_round" &&
        checkpoint.reason !== "baseline",
    );
  const safetyCheckpoints = () =>
    checkpoints().filter(
      (checkpoint) => checkpoint.reason === "rollback_safety",
    );

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
          Git
        </button>
        <button
          type="button"
          class="review-subtab"
          data-active={tab() === "sandbox"}
          onClick={() => selectTab("sandbox")}
        >
          Sandbox / Team
        </button>
        <button
          type="button"
          class="review-subtab"
          data-active={tab() === "checkpoint"}
          onClick={() => selectTab("checkpoint")}
        >
          Checkpoint
        </button>
        <button
          type="button"
          class="review-subtab"
          data-active={tab() === "rounds"}
          onClick={() => selectTab("rounds")}
        >
          Rounds
        </button>
      </div>
      <Show when={tab() === "git"}>
        <div class="review-git-ranges">
          <NeuSelect
            value={gitFrom()}
            options={[
              { value: "HEAD", label: "HEAD" },
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
          <span class="review-git-arrow">→</span>
          <NeuSelect
            value={gitTo()}
            options={[
              { value: "WORKTREE", label: "Working Tree" },
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
      <Show when={tab() === "rounds"}>
        <div class="review-git-ranges">
          <NeuSelect
            value={roundPlanID()}
            options={[...new Set(auditRounds().map((item) => item.planID))].map(
              (planID) => ({
                value: planID,
                label: planID,
              }),
            )}
            onChange={(value) => {
              setRoundPlanID(value);
              const planRounds = auditRounds().filter(
                (item) => item.planID === value,
              );
              if (planRounds.length >= 2) {
                setRoundFrom(planRounds[planRounds.length - 2]!.round);
                setRoundTo(planRounds.at(-1)!.round);
              } else {
                setRoundFrom(planRounds[0]?.round);
                setRoundTo(planRounds[0]?.round);
              }
              void runRoundDiff();
            }}
          />
          <span class="review-git-arrow">→</span>
          <NeuSelect
            value={roundFrom() === undefined ? "" : String(roundFrom()!)}
            options={auditRounds()
              .filter((item) => item.planID === roundPlanID())
              .map((item) => ({
                value: String(item.round),
                label: `R${item.round} (${item.verdict})`,
              }))}
            onChange={(value) => {
              setRoundFrom(Number(value));
              void runRoundDiff();
            }}
          />
          <span class="review-git-arrow">→</span>
          <NeuSelect
            value={roundTo() === undefined ? "" : String(roundTo()!)}
            options={auditRounds()
              .filter((item) => item.planID === roundPlanID())
              .map((item) => ({
                value: String(item.round),
                label: `R${item.round} (${item.verdict})`,
              }))}
            onChange={(value) => {
              setRoundTo(Number(value));
              void runRoundDiff();
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
                class="review-entity-button"
                data-active={selectedSandbox() === pr.sandboxID}
                onClick={() => void selectSandbox(pr.sandboxID)}
              >
                {pr.id}
                <span class="review-entity-count">{pr.status}</span>
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
                class="review-entity-button"
                data-active={selectedSandbox() === sandbox.id}
                onClick={() => void selectSandbox(sandbox.id)}
              >
                {sandbox.id}
                <span class="review-entity-count">{sandbox.changedFiles}</span>
              </button>
            )}
          </For>
        </div>
      </Show>
      <Show when={tab() === "sandbox" && selectedTeamPR()}>
        <div class="review-pr-detail">
          <div class="review-pr-row">
            <span class="review-pr-label">Task</span>
            <span class="review-pr-text">{selectedTeamPR()!.task}</span>
          </div>
          <div class="review-pr-row">
            <span class="review-pr-label">Status</span>
            <span class="review-pr-text">{selectedTeamPR()!.status}</span>
          </div>
          <Show when={selectedTeamPR()!.result}>
            <div class="review-pr-row">
              <span class="review-pr-label">Result</span>
              <pre class="review-pr-result">{selectedTeamPR()!.result}</pre>
            </div>
          </Show>
          <Show when={selectedTeamPR()!.buildEvidence}>
            <div class="review-pr-row">
              <span class="review-pr-label">Build</span>
              <span class="review-pr-text">
                {selectedTeamPR()!.buildEvidence!.ok ? "passed" : "failed"} ·
                exit {selectedTeamPR()!.buildEvidence!.exitCode}
              </span>
            </div>
            <Show when={selectedTeamPR()!.buildEvidence!.output}>
              <pre class="review-pr-result">
                {selectedTeamPR()!.buildEvidence!.output}
              </pre>
            </Show>
          </Show>
        </div>
      </Show>
      <Show when={tab() === "checkpoint" && checkpoints().length}>
        <Show when={auditCheckpoints().length}>
          <div class="review-section-label">审计轮次</div>
          <div class="review-entity-control">
            <NeuSelect
              value={
                auditCheckpoints().some((c) => c.id === selectedCheckpoint())
                  ? (selectedCheckpoint() ?? "")
                  : ""
              }
              options={auditCheckpoints().map((checkpoint) => ({
                value: checkpoint.id,
                label: checkpointLabel(checkpoint),
              }))}
              onChange={(value) => void selectCheckpoint(value)}
            />
          </div>
        </Show>
        <Show when={userCheckpoints().length}>
          <div class="review-section-label">我的快照</div>
          <div class="review-entity-control">
            <NeuSelect
              value={
                userCheckpoints().some((c) => c.id === selectedCheckpoint())
                  ? (selectedCheckpoint() ?? "")
                  : ""
              }
              options={userCheckpoints().map((checkpoint) => ({
                value: checkpoint.id,
                label: checkpointLabel(checkpoint),
              }))}
              onChange={(value) => void selectCheckpoint(value)}
            />
          </div>
          <Show
            when={userCheckpoints().some(
              (checkpoint) => checkpoint.id === selectedCheckpoint(),
            )}
          >
            <div class="review-checkpoint-rename">
              <Show
                when={renamingCheckpointID() === selectedCheckpoint()}
                fallback={
                  <button
                    type="button"
                    class="review-checkpoint-rename-btn"
                    onClick={() => {
                      const selected = userCheckpoints().find(
                        (checkpoint) => checkpoint.id === selectedCheckpoint(),
                      );
                      if (selected) beginRenameCheckpoint(selected);
                    }}
                  >
                    重命名
                  </button>
                }
              >
                <input
                  class="review-checkpoint-rename-input"
                  value={checkpointNameDraft()}
                  placeholder="快照名称"
                  onInput={(event) =>
                    setCheckpointNameDraft(event.currentTarget.value)
                  }
                  onKeyDown={(event) => {
                    if (event.key === "Enter") void commitRenameCheckpoint();
                    if (event.key === "Escape") setRenamingCheckpointID(null);
                  }}
                />
                <button
                  type="button"
                  class="review-checkpoint-rename-btn"
                  onClick={() => void commitRenameCheckpoint()}
                >
                  保存
                </button>
              </Show>
            </div>
          </Show>
        </Show>
        <Show when={autoCheckpoints().length}>
          <div class="review-section-label">自动安全点</div>
          <div class="review-entity-control">
            <details>
              <summary>{autoCheckpoints().length} 个自动安全点</summary>
              <NeuSelect
                value={
                  autoCheckpoints().some((c) => c.id === selectedCheckpoint())
                    ? (selectedCheckpoint() ?? "")
                    : ""
                }
                options={autoCheckpoints().map((checkpoint) => ({
                  value: checkpoint.id,
                  label: checkpointLabel(checkpoint),
                }))}
                onChange={(value) => void selectCheckpoint(value)}
              />
            </details>
          </div>
        </Show>
        <Show when={safetyCheckpoints().length}>
          <div class="review-section-label">安全点</div>
          <div class="review-entity-control">
            <NeuSelect
              value={
                safetyCheckpoints().some((c) => c.id === selectedCheckpoint())
                  ? (selectedCheckpoint() ?? "")
                  : ""
              }
              options={safetyCheckpoints().map((checkpoint) => ({
                value: checkpoint.id,
                label: checkpointLabel(checkpoint),
              }))}
              onChange={(value) => void selectCheckpoint(value)}
            />
          </div>
        </Show>
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
          <span>
            {tab() === "git"
              ? "Git Changes"
              : tab() === "sandbox"
                ? "Sandbox Changes"
                : tab() === "rounds"
                  ? "Round Changes"
                  : "Checkpoint Changes"}
          </span>
        </div>
        <div class="review-meta">
          <span class="review-count">{changesForTab().length} files</span>
          <span class="review-additions">+{totalAdditions()}</span>
          <span class="review-deletions">-{totalDeletions()}</span>
        </div>
      </div>
      <div class="review-body">
        <Show
          when={!loaded()}
          fallback={
            <Show
              when={changesForTab().length}
              fallback={
                <div class="review-empty">
                  <div class="review-empty-icon">
                    <svg width="28" height="28" viewBox="0 0 28 28" fill="none">
                      <rect
                        x="3"
                        y="4"
                        width="22"
                        height="5"
                        rx="1.5"
                        stroke="currentColor"
                        stroke-width="1.6"
                      />
                      <rect
                        x="3"
                        y="12"
                        width="22"
                        height="5"
                        rx="1.5"
                        stroke="currentColor"
                        stroke-width="1.6"
                      />
                      <circle cx="6" cy="6.5" r="1.2" fill="currentColor" />
                      <circle cx="6" cy="14.5" r="1.2" fill="currentColor" />
                      <path
                        d="M22 6.5h3M22 14.5h3"
                        stroke="currentColor"
                        stroke-width="1.6"
                        stroke-linecap="round"
                      />
                    </svg>
                  </div>
                  <div class="review-empty-title">
                    {tab() === "rounds" ? "暂无审计轮次" : "暂无变更"}
                  </div>
                  <div class="review-empty-desc">
                    {tab() === "rounds"
                      ? "完成一次 audit_report 后会出现 Rounds 对比。"
                      : "当前工作区没有待审阅的变更。"}
                  </div>
                </div>
              }
            >
              <div
                class="review-files"
                data-narrow={fileWidth() < 170}
                style={{ width: `${fileWidth()}px` }}
              >
                <div class="review-files-heading">Files changed</div>
                <For each={changesForTab()}>
                  {(change) => (
                    <button
                      type="button"
                      class="review-file-row"
                      data-active={selectedForTab() === change.path}
                      onClick={() =>
                        tab() === "git"
                          ? void selectGitFile(change.path)
                          : tab() === "sandbox"
                            ? setSandboxSelected(change.path)
                            : setCheckpointSelected(change.path)
                      }
                    >
                      <span
                        class={`review-file-status ${change.operation === "added" ? "is-added" : change.operation === "deleted" ? "is-deleted" : "is-modified"}`}
                      >
                        {statusFor(change.operation)}
                      </span>
                      <span class="review-file-name">{change.path}</span>
                    </button>
                  )}
                </For>
              </div>
              <div
                class="review-resizer"
                role="separator"
                aria-orientation="vertical"
                onPointerDown={startFileResize}
              />
              <div class="review-diff">
                <div class="review-diff-header">
                  <span class="review-diff-path">
                    {selectedFile()?.path ?? ""}
                  </span>
                  <div class="review-diff-actions">
                    <button
                      type="button"
                      class="review-icon-btn"
                      data-active={diffScope() === "session"}
                      title="当前会话"
                      onClick={() => {
                        setDiffScope("session");
                        void loadGit();
                      }}
                    >
                      S
                    </button>
                    <button
                      type="button"
                      class="review-icon-btn"
                      data-active={diffScope() === "all"}
                      title="全局"
                      onClick={() => {
                        setDiffScope("all");
                        void loadGit();
                      }}
                    >
                      G
                    </button>
                    <button
                      type="button"
                      class="review-icon-btn"
                      data-active={diffIgnoreWhitespace()}
                      title="忽略空白"
                      onClick={() => {
                        setDiffIgnoreWhitespace((value) => !value);
                        void loadGit();
                      }}
                    >
                      W
                    </button>
                    <button
                      type="button"
                      class="review-icon-btn"
                      data-active={viewMode() === "unified"}
                      title="Unified"
                      onClick={() => setViewMode("unified")}
                    >
                      U
                    </button>
                    <button
                      type="button"
                      class="review-icon-btn"
                      data-active={viewMode() === "split"}
                      title="Split"
                      onClick={() => setViewMode("split")}
                    >
                      ⇄
                    </button>
                    <button
                      type="button"
                      class="review-icon-btn"
                      data-active={viewMode() === "ast" && !astBatchPanelOpen()}
                      title="AST"
                      onClick={() => {
                        setViewMode("ast");
                        setAstBatchPanelOpen(false);
                        void loadAstDiffForSelectedFile();
                      }}
                    >
                      A
                    </button>
                    <button
                      type="button"
                      class="review-icon-btn"
                      data-active={
                        viewMode() === "ast" &&
                        astBatchPanelOpen() &&
                        astBatchMode() === "structure"
                      }
                      title="批量 AST 结构总览"
                      onClick={() => {
                        setViewMode("ast");
                        setAstBatchPanelOpen(true);
                        setAstBatchMode("structure");
                        void loadAstBatch();
                      }}
                    >
                      B
                    </button>
                    <button
                      type="button"
                      class="review-icon-btn"
                      data-active={
                        viewMode() === "ast" &&
                        astBatchPanelOpen() &&
                        astBatchMode() === "refactor"
                      }
                      title="重构预览"
                      onClick={() => {
                        setViewMode("ast");
                        setAstBatchPanelOpen(true);
                        setAstBatchMode("refactor");
                        void loadAstBatch();
                      }}
                    >
                      R
                    </button>
                    <button
                      type="button"
                      class="review-icon-btn"
                      data-active={
                        viewMode() === "ast" &&
                        astBatchPanelOpen() &&
                        astBatchMode() === "search"
                      }
                      title="AST 搜索"
                      onClick={() => {
                        setViewMode("ast");
                        setAstBatchPanelOpen(true);
                        setAstBatchMode("search");
                        setAstSearchResult(undefined);
                        setAstSearchError(undefined);
                      }}
                    >
                      Q
                    </button>
                    <button
                      type="button"
                      class="review-icon-btn"
                      data-active={
                        viewMode() === "ast" &&
                        astBatchPanelOpen() &&
                        astBatchMode() === "plan"
                      }
                      title="重构计划"
                      onClick={() => {
                        setViewMode("ast");
                        setAstBatchPanelOpen(true);
                        setAstBatchMode("plan");
                        setAstPlanResult(undefined);
                        setAstPlanError(undefined);
                      }}
                    >
                      P
                    </button>
                  </div>
                </div>
                <Show
                  when={
                    (viewMode() === "ast" && astBatchPanelOpen()) ||
                    selectedFile()?.patch ||
                    selectedFile()?.before ||
                    selectedFile()?.after ||
                    selectedFile()?.structured ||
                    structuredDiff()
                  }
                  fallback={
                    <div class="review-diff-content">
                      <div class="review-empty">
                        <div class="review-empty-title">暂无内容级 diff</div>
                        <div class="review-empty-desc">
                          当前变更只有文件级信息，没有可展示的行级差异。
                        </div>
                      </div>
                    </div>
                  }
                >
                  <Show when={viewMode() === "ast"}>
                    <div class="review-diff-content">
                      <Show when={astBatchPanelOpen()}>
                        <Show when={astBatchMode() === "search"}>
                          <div class="ast-search-form">
                            <input
                              type="text"
                              placeholder="文本包含，例如 foo"
                              value={astSearchText()}
                              onInput={(event) =>
                                setAstSearchText(event.currentTarget.value)
                              }
                            />
                            <input
                              type="text"
                              placeholder="节点类型，例如 function_declaration"
                              value={astSearchNodeKind()}
                              onInput={(event) =>
                                setAstSearchNodeKind(event.currentTarget.value)
                              }
                            />
                            <button
                              type="button"
                              onClick={() => void loadAstSearch()}
                            >
                              搜索
                            </button>
                          </div>
                          <Show when={astSearchLoading()}>
                            <div class="review-empty">
                              <div class="review-empty-title">
                                AST 搜索中...
                              </div>
                            </div>
                          </Show>
                          <Show when={astSearchError()}>
                            <div class="review-empty">
                              <div class="review-empty-title">AST 搜索失败</div>
                              <div class="review-empty-desc">
                                {astSearchError()}
                              </div>
                            </div>
                          </Show>
                          <Show when={astSearchResult()}>
                            <div class="ast-diff-list">
                              <Show
                                when={
                                  !(astSearchResult()!.matches ?? []).length
                                }
                              >
                                <div class="review-empty">
                                  <div class="review-empty-title">
                                    没有匹配的结构节点
                                  </div>
                                </div>
                              </Show>
                              <For each={astSearchResult()!.matches ?? []}>
                                {(file) => (
                                  <div class="ast-change-group">
                                    <div class="ast-group-header">
                                      <span class="ast-group-name">
                                        {file.path ?? "?"}
                                      </span>
                                      <span class="ast-group-count">
                                        {file.nodes.length}
                                      </span>
                                    </div>
                                    <For each={file.nodes}>
                                      {(node) => (
                                        <div
                                          class="ast-change-row"
                                          data-kind={node.nodeKind}
                                        >
                                          <span class="ast-change-kind">
                                            {node.nodeKind}
                                          </span>
                                          <span class="ast-change-node">
                                            {node.text || "—"}
                                          </span>
                                          <span class="ast-change-pos">
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
                          <div class="ast-search-form">
                            <input
                              type="text"
                              placeholder="旧名称，例如 foo"
                              value={astPlanFrom()}
                              onInput={(event) =>
                                setAstPlanFrom(event.currentTarget.value)
                              }
                            />
                            <input
                              type="text"
                              placeholder="新名称，例如 bar"
                              value={astPlanTo()}
                              onInput={(event) =>
                                setAstPlanTo(event.currentTarget.value)
                              }
                            />
                            <button
                              type="button"
                              onClick={() => void loadAstPlan()}
                            >
                              生成计划
                            </button>
                            <button
                              type="button"
                              onClick={() => void applyAstPlan()}
                            >
                              应用改动
                            </button>
                          </div>
                          <Show when={astPlanLoading()}>
                            <div class="review-empty">
                              <div class="review-empty-title">
                                重构计划生成中...
                              </div>
                            </div>
                          </Show>
                          <Show when={astPlanError()}>
                            <div class="review-empty">
                              <div class="review-empty-title">重构计划失败</div>
                              <div class="review-empty-desc">
                                {astPlanError()}
                              </div>
                            </div>
                          </Show>
                          <Show when={astPlanResult()}>
                            <div class="ast-diff-list">
                              <Show when={!astPlanResult()!.targets.length}>
                                <div class="review-empty">
                                  <div class="review-empty-title">
                                    没有找到需要重构的节点
                                  </div>
                                </div>
                              </Show>
                              <For each={astPlanResult()!.targets}>
                                {(target) => (
                                  <div
                                    class="ast-change-row"
                                    data-kind={target.nodeKind}
                                  >
                                    <span class="ast-change-kind">
                                      {target.nodeKind}
                                    </span>
                                    <span class="ast-change-node">
                                      {target.text} →{" "}
                                      {target.suggestedText ?? "?"}
                                    </span>
                                    <span class="ast-change-pos">
                                      {target.path ?? "?"}
                                    </span>
                                  </div>
                                )}
                              </For>
                            </div>
                          </Show>
                          <Show when={astApplyLoading()}>
                            <div class="review-empty">
                              <div class="review-empty-title">
                                自动改写中...
                              </div>
                            </div>
                          </Show>
                          <Show when={astApplyError()}>
                            <div class="review-empty">
                              <div class="review-empty-title">自动改写失败</div>
                              <div class="review-empty-desc">
                                {astApplyError()}
                              </div>
                            </div>
                          </Show>
                          <Show when={astApplyResult()}>
                            <div class="review-empty">
                              <div class="review-empty-title">
                                已应用改动：
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
                            <div class="review-empty">
                              <div class="review-empty-title">
                                {astBatchMode() === "refactor"
                                  ? "重构预览计算中..."
                                  : "批量 AST 计算中..."}
                              </div>
                            </div>
                          </Show>
                          <Show when={astBatchError()}>
                            <div class="review-empty">
                              <div class="review-empty-title">
                                {astBatchMode() === "refactor"
                                  ? "重构预览失败"
                                  : "批量 AST 失败"}
                              </div>
                              <div class="review-empty-desc">
                                {astBatchError()}
                              </div>
                            </div>
                          </Show>
                          <Show when={astBatchResult()}>
                            <div class="ast-diff-list">
                              <Show when={!astBatchGroups().length}>
                                <div class="review-empty">
                                  <div class="review-empty-title">
                                    无批量结构性变更
                                  </div>
                                </div>
                              </Show>
                              <For each={astBatchGroups()}>
                                {(group) => (
                                  <div class="ast-change-group">
                                    <div class="ast-group-header">
                                      <span class="ast-group-name">
                                        {group.nodeKind}
                                      </span>
                                      <span class="ast-group-count">
                                        {group.items.length}
                                      </span>
                                    </div>
                                    <For each={group.items}>
                                      {(item) => (
                                        <div
                                          class="ast-change-row"
                                          data-kind={item.change.kind}
                                        >
                                          <span class="ast-change-kind">
                                            {item.change.kind}
                                          </span>
                                          <span class="ast-change-node">
                                            {item.change.nodeKind}
                                          </span>
                                          <span class="ast-change-pos">
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
                      </Show>

                      <Show when={!astBatchPanelOpen()}>
                        <Show
                          when={astDiffError()}
                          fallback={
                            <Show
                              when={astDiffResult()}
                              fallback={
                                <div class="review-empty">
                                  <div class="review-empty-title">
                                    加载 AST 变更...
                                  </div>
                                </div>
                              }
                            >
                              <div class="ast-diff-list">
                                <Show when={!astDiffResult()!.changes.length}>
                                  <div class="review-empty">
                                    <div class="review-empty-title">
                                      无结构性变更
                                    </div>
                                  </div>
                                </Show>
                                <For each={astGroups()}>
                                  {(group) => (
                                    <div class="ast-change-group">
                                      <button
                                        type="button"
                                        class="ast-group-header"
                                        onClick={() =>
                                          setCollapsedAstGroups((prev) => {
                                            const next = new Set(prev);
                                            if (next.has(group.nodeKind))
                                              next.delete(group.nodeKind);
                                            else next.add(group.nodeKind);
                                            return next;
                                          })
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
                                        <span class="ast-group-count">
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
                                          {(change) => (
                                            <div
                                              class="ast-change-row"
                                              data-kind={change.kind}
                                              onClick={() => {
                                                const file = selectedFile();
                                                if (!file) return;
                                                const source =
                                                  change.kind === "removed"
                                                    ? (file.before ?? "")
                                                    : (file.after ?? "");
                                                const start =
                                                  change.kind === "removed"
                                                    ? change.oldStart
                                                    : change.newStart;
                                                const end =
                                                  change.kind === "removed"
                                                    ? change.oldEnd
                                                    : change.newEnd;
                                                setAstSnippet({
                                                  kind: change.kind,
                                                  nodeKind: change.nodeKind,
                                                  text: source.slice(
                                                    start,
                                                    end,
                                                  ),
                                                });
                                              }}
                                            >
                                              <span class="ast-change-kind">
                                                {change.kind}
                                              </span>
                                              <span class="ast-change-node">
                                                {change.nodeKind}
                                              </span>
                                              <span class="ast-change-pos">
                                                {change.kind === "removed"
                                                  ? `${change.oldStart}-${change.oldEnd}`
                                                  : `${change.newStart}-${change.newEnd}`}
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
                                <pre class="ast-snippet">
                                  {astSnippet()!.text}
                                </pre>
                              </Show>
                            </Show>
                          }
                        >
                          <div class="review-empty">
                            <div class="review-empty-title">AST Diff 失败</div>
                            <div class="review-empty-desc">
                              {astDiffError()}
                            </div>
                          </div>
                        </Show>
                      </Show>
                    </div>
                  </Show>
                  <Show
                    when={
                      viewMode() !== "ast" &&
                      (selectedFile()?.structured || structuredDiff())
                    }
                  >
                    <Show
                      when={viewMode() === "split"}
                      fallback={
                        <UnifiedDiffView
                          rows={structuredRows(
                            selectedFile()?.structured ?? structuredDiff()!,
                          )}
                          language={languageFromPath(
                            selectedFile()?.path ?? "",
                          )}
                        />
                      }
                    >
                      <SplitDiffView
                        rows={buildSplitRows(
                          selectedFile()?.structured ?? structuredDiff()!,
                        )}
                        language={languageFromPath(selectedFile()?.path ?? "")}
                      />
                    </Show>
                  </Show>
                  <Show
                    when={
                      viewMode() !== "ast" &&
                      !selectedFile()?.structured &&
                      !structuredDiff() &&
                      structuredDiffError()
                    }
                  >
                    <div class="review-diff-content">
                      <div class="review-diff-raw">
                        <div class="review-diff-raw-title">Diff 计算失败</div>
                        <pre>{structuredDiffError()}</pre>
                      </div>
                    </div>
                  </Show>
                  <Show
                    when={
                      viewMode() !== "ast" &&
                      !selectedFile()?.structured &&
                      !structuredDiff() &&
                      !structuredDiffError() &&
                      selectedFile()?.patch
                    }
                  >
                    <UnifiedDiffView
                      rows={diffLines(selectedFile()!.patch)}
                      language={languageFromPath(selectedFile()!.path)}
                    />
                  </Show>
                  <Show
                    when={
                      viewMode() !== "ast" &&
                      !selectedFile()?.structured &&
                      !structuredDiff() &&
                      !structuredDiffError() &&
                      !selectedFile()?.patch &&
                      selectedFile()?.before
                    }
                  >
                    <div class="review-diff-content">
                      <div class="review-diff-raw">
                        <div class="review-diff-raw-title">Before</div>
                        <pre>{selectedFile()!.before}</pre>
                      </div>
                    </div>
                  </Show>
                  <Show
                    when={
                      viewMode() !== "ast" &&
                      !selectedFile()?.structured &&
                      !structuredDiff() &&
                      !structuredDiffError() &&
                      !selectedFile()?.patch &&
                      selectedFile()?.after
                    }
                  >
                    <div class="review-diff-content">
                      <div class="review-diff-raw">
                        <div class="review-diff-raw-title">After</div>
                        <pre>{selectedFile()!.after}</pre>
                      </div>
                    </div>
                  </Show>
                </Show>
              </div>
            </Show>
          }
        >
          <div class="review-empty">
            <div class="review-empty-title">正在读取变更...</div>
          </div>
        </Show>
      </div>
    </div>
  );
}
