import type {
  InitializeOptions,
  RuntimeContext,
  RuntimeEvent,
  SandboxService,
  SessionExecutionState,
  SessionID,
  StreamingProvider,
  SubagentRunnerContext,
  SubagentSupport,
  SubagentsService,
} from "@anthelia/substrate";
import { createInitializeRuntime } from "./runtime";
import { ensureUsableResult } from "./subagent-result-gate";
import { forkSeedEntries } from "./subagent-fork-seed";
import { parentMessageContent } from "./subagent-steer";
import {
  DEFAULT_SETTLED_NOTICE_BUDGET,
  settledNoticeAllowed,
  settledNoticeEntryID,
  subagentSettledNoticeContent,
} from "./subagent-settled-notice";
import { activePlanForExec } from "@natalia/collab";
import { sandboxService, subagentsService } from "@anthelia/runtime-services";
import { sandboxSelfDiffTool } from "@anthelia/sandbox";
import { uniqueProviderToolCallIds } from "@anthelia/runtime";
import type { RuntimeContextLedger } from "@natalia/context-ledger";

/**
 * The active plan pointer for a subagent (ADR D4/B2): planID + documentPath +
 * version only. The plan正文 is never injected into the subagent's context;
 * the subagent reads the plan file itself with read_file.
 */
function subagentPlanPointer(ctx: RuntimeContext, exec: SessionExecutionState) {
  const plan = activePlanForExec(ctx, exec);
  if (!plan) return undefined;
  return {
    planID: plan.planID,
    // documentPath is relative to the plan dir; the subagent reads the file
    // through the workspace root, so the pointer carries the full
    // workspace-relative path.
    documentPath: `.natalia/plans/${plan.documentPath}`,
    // The plan document has no persisted version counter; the pointer only
    // needs a stable, honest value, and the plan file read carries the truth.
    version: 1,
  };
}

/**
 * The system prompt for a subagent spawned as a configured agent type.
 *
 * The type's own prompt replaces the generic one rather than being appended to
 * it: a type exists to say "you are this kind of worker", and a generic
 * instruction bolted in front of it dilutes exactly that. `undefined` when the
 * subagent was not spawned as a type, so the generic prompt still applies.
 */
function agentTypeSystemPrompt(
  scope: ReturnType<typeof createInitializeRuntime>,
  agentType: string | undefined,
): string | undefined {
  if (!agentType) return undefined;
  const definition = scope.agentRegistry?.get(agentType);
  return definition?.systemPrompt || undefined;
}

/**
 * Appends the runner's own tools to a child's visible set, displacing any
 * host tool of the same name.
 *
 * The provider refuses a tool list with two entries of one name ("Tool names
 * must be unique"), so a pushed tool must REPLACE its host counterpart rather
 * than sit beside it. `sandboxSelfDiffTool()` is named `sandbox_diff` — the
 * same name the host's sandbox family registers — so pushing it without this
 * displacement handed the provider two `sandbox_diff` entries and every
 * sandboxed child died on its first step with that error. `team_fanout`
 * spawns sandboxed children, which is why the whole team path was down while
 * `agent_spawn` (the non-sandboxed path, which pushes nothing) worked.
 */
export function withRunnerTools<T extends { name: string }>(
  visible: T[],
  pushed: T[],
): T[] {
  if (!pushed.length) return visible;
  const names = new Set(pushed.map((tool) => tool.name));
  return [...visible.filter((tool) => !names.has(tool.name)), ...pushed];
}

export async function installSubagents(
  ctx: RuntimeContext,
  _options: InitializeOptions,
  support: SubagentSupport & {
    executeSubagentToolCall: ReturnType<
      typeof import("./subagent-tools").createSubagentTools
    > extends Promise<infer T>
      ? T extends { executeSubagentToolCall: infer F }
        ? F
        : never
      : never;
  },
) {
  const scope = createInitializeRuntime(ctx);
  const subagents = scope.serviceDirectory.get(subagentsService);
  const subagentsController = subagents;
  const sandbox = scope.serviceDirectory.getOptional(sandboxService);
  const {
    acquireSandboxedSubagentSlot,
    releaseSandboxedSubagentSlot,
    publishSubagentEvent,
    subagentTurnID,
    beginSubagentConversation,
    finishSubagentConversation,
    createSubagentContext,
    registerSubagentLedger,
    unregisterSubagentLedger,
    liveSubagentLedger,
    loadSubagentLedgerCheckpoint,
    writeSubagentLedgerCheckpoint,
    runSubagentProviderStep,
    appendSubagentAssistant,
    appendSubagentToolResult,
    executeSubagentToolCall,
  } = support;
  /**
   * Adopt the ledger this subagent's run writes to, so a parent can steer it.
   *
   * The ledger is registered before the run begins and dropped when it ends,
   * which is what makes "is there a live runner" a fact rather than a guess from
   * the recorded status. Messages the parent queued while no runner was live are
   * drained here, before the first step, so nothing sent during a gap is lost.
   */
  /**
   * Drop a subagent's live ledger and steer hook when its run ends.
   *
   * Until this runs the child is steerable; after it a message queues instead.
   * Leaving either in place would let a parent steer a subagent whose ledger no
   * longer exists, which would look like a delivery that went nowhere.
   */
  async function releaseSubagentSteering(runner: SubagentRunnerContext) {
    // Persist the conversation BEFORE the ledger is dropped: this is the one
    // point every run passes through, so the checkpoint exists whether the
    // child completed, failed or was cancelled. A failed write must not fail
    // the run's own teardown.
    const ledger = liveSubagentLedger(runner.agentId);
    if (ledger)
      await writeSubagentLedgerCheckpoint(runner.agentId, ledger).catch(
        () => undefined,
      );
    unregisterSubagentLedger(runner.agentId);
    subagentsController.setSteerHook?.(runner.agentId, undefined);
  }

  function adoptSubagentLedger(
    runner: SubagentRunnerContext,
    record:
      | {
          id: string;
          pendingMessages?: string[];
          parentAgentID?: string;
        }
      | undefined,
    create: () => RuntimeContextLedger,
  ): RuntimeContextLedger {
    const ledger = create();
    registerSubagentLedger(runner.agentId, ledger);
    // Live-delivery hook: a message appended here is in front of the child at its
    // nearest step, because its provider messages are rebuilt from this ledger
    // every step. Registered for the run and dropped with it.
    subagentsController.setSteerHook?.(runner.agentId, (message) => {
      ledger.add({
        id: `steer:${runner.agentId}:${ledger.snapshot().entries.length + 1}`,
        role: "dynamic",
        content: parentMessageContent(
          record?.parentAgentID ?? "parent",
          runner.agentId,
          message,
        ),
      });
      return "delivered";
    });
    for (const message of record?.pendingMessages ?? []) {
      ledger.add({
        id: `pending:${runner.agentId}:${ledger.snapshot().entries.length + 1}`,
        role: "dynamic",
        content: parentMessageContent(
          record?.id ?? "parent",
          runner.agentId,
          message,
        ),
      });
    }
    if (record?.pendingMessages?.length)
      subagentsController.setPendingMessages(runner.agentId, []);
    return ledger;
  }

  async function runSandboxedSubagent(
    task: string,
    runner: SubagentRunnerContext,
    exec: SessionExecutionState,
    activeProvider: StreamingProvider,
  ) {
    await acquireSandboxedSubagentSlot(runner.signal);
    try {
      await runSandboxedSubagentInner(task, runner, exec, activeProvider);
    } finally {
      releaseSandboxedSubagentSlot();
      await releaseSubagentSteering(runner);
    }
  }
  async function runSandboxedSubagentInner(
    task: string,
    runner: SubagentRunnerContext,
    exec: SessionExecutionState,
    activeProvider: StreamingProvider,
  ) {
    const record = subagentsController.get(runner.agentId);
    if (!record)
      throw new Error(`subagent record not found: ${runner.agentId}`);
    const allowed = record.allowedTools ?? [];
    const excluded = new Set(record.excludeTools ?? []);
    // The sub-agent's own worktree, created through the sandbox backend.
    const manifest = await sandbox?.create(runner.agentId);
    if (!manifest)
      throw new Error("sandbox controller unavailable for subagent worktree");
    const sandboxRoot = manifest.root;
    // The ownership map's domain: paths (relative to the sub-agent's
    // worktree) it may write. Absent = unrestricted (same authority as the
    // main agent).
    const writePaths = record.writePaths;
    const writeAuthorize = writePaths?.length
      ? async ({ toolName, path }: { toolName: string; path: string }) => {
          const relative = path.startsWith(sandboxRoot + "/")
            ? path.slice(sandboxRoot.length + 1)
            : path;
          const inDomain = writePaths.some(
            (domain) =>
              relative === domain ||
              relative.startsWith(domain.endsWith("/") ? domain : `${domain}/`),
          );
          if (!inDomain)
            throw new Error(
              `subagent write outside file domain (${toolName}): ${relative}`,
            );
        }
      : undefined;
    runner.log(`accepted (sandboxed): ${task}`);
    runner.setStatus("running");
    beginSubagentConversation(runner, task);
    const resume = await loadSubagentLedgerCheckpoint(runner.agentId);
    const ledger = adoptSubagentLedger(runner, record, () =>
      createSubagentContext(
        scope.teamBehavior()?.sandboxedSubagentSystemPrompt(writePaths) ??
          agentTypeSystemPrompt(scope, record.agentType) ??
          "You are a focused Natalia TS/Bun subagent. Use the provided native tools to inspect, edit, and validate the workspace. Return a concise factual final result. Never claim a tool action you did not run. Do not reveal private reasoning.",
        task,
        subagentPlanPointer(ctx, exec),
        // A fork inherits the parent's completed turns; a fresh subagent gets
        // nothing but its task. The seed comes from the *parent's* ledger — the
        // `exec` this runner resolves — so it is the conversation the child is
        // meant to continue.
        record?.context === "fork"
          ? { entries: forkSeedEntries(exec.context.snapshot().entries) }
          : undefined,
        // A continuation continues: the durable checkpoint (the child's own
        // conversation, written when its last run ended) is restored instead
        // of starting from nothing — which is what makes `agent_retry` and
        // `agent_resume` continue work rather than re-derive it.
        resume,
      ),
    );
    const repeatedCalls = new Map<string, number[]>();
    const maxSubagentSteps = scope.effectiveMaxSteps(exec);
    const activeContextConfig = { ...exec.runtimeContextConfig };
    for (let step = 1; step <= maxSubagentSteps; step++) {
      const isLastStep =
        Number.isFinite(maxSubagentSteps) && step >= maxSubagentSteps;
      let visibleTools = [...scope.tools.values()].filter(
        (tool) =>
          scope.isToolAllowed(tool.name, exec) &&
          (exec.permissionMode !== "read_only" || !tool.requiresApproval) &&
          !excluded.has(tool.name) &&
          (!allowed.length || allowed.includes(tool.name)),
      );
      // T6-4: the child's OWN candidate's diff, as the only sandbox tool it
      // may call. The host's `sandbox_diff` (which takes an id) is not
      // exposed to a sandboxed child at all — its sandbox service is not
      // handed over, so it would throw "sandbox runtime unavailable" — and
      // this one answers for the sandbox the child runs in. Reading its own
      // diff is what lets it self-review before settling; merging and
      // promoting stay the parent's.
      // The child's own channel to its parent, as a tool: the model can
      // only call tools, and a mid-run finding must be reportable while
      // it is being found (the send_result channel). Always visible,
      // never approval-gated — it is a message, not an action.
      //
      // Both of the runner's own tools displace a same-named host tool: a
      // provider handed two entries of one name refuses the whole list.
      visibleTools = withRunnerTools(visibleTools, [
        ...(sandbox && !excluded.has("sandbox_diff")
          ? [sandboxSelfDiffTool()]
          : []),
        {
          name: "send_to_parent",
          description:
            "Send a message to the session that spawned you (and to the user watching it), live: a finding worth hearing NOW — one decomposed task done, a blocker, the result. Never wait for your whole run to end to report. One fact per message.",
          requiresApproval: false,
          parameters: {
            type: "object",
            properties: { text: { type: "string" } },
            required: ["text"],
            additionalProperties: false,
          },
          async execute(parsed) {
            const args = parsed as { text?: string };
            if (typeof args.text !== "string" || !args.text.trim())
              return "send_to_parent requires a non-empty text";
            runner.sendToParent(args.text.trim());
            return JSON.stringify({ sent: true });
          },
        },
      ]);
      if (isLastStep)
        ledger.add({
          id: `${runner.agentId}:${step}:max-steps`,
          role: "assistant",
          content: scope.MAX_STEPS_PROMPT,
        });
      const { output, calls, thinking } = await runSubagentProviderStep(
        ledger,
        visibleTools,
        runner,
        step,
        activeProvider,
        activeContextConfig,
        !isLastStep,
      );
      if (!calls.length || isLastStep) {
        // A one-word answer leaves the parent with nothing to act on, so give
        // it one turn to say more before settling for it.
        const usable = await ensureUsableResult({
          ledger,
          setStatus: runner.setStatus,
          step,
          output,
          minChars: scope.tsRuntimeConfig?.runtime.subagentMinResultChars ?? 0,
          // No tools: a follow-up that could start new work would spend the
          // budget again instead of reporting what it already did.
          runStep: (extraStep) =>
            runSubagentProviderStep(
              ledger,
              [],
              runner,
              extraStep,
              activeProvider,
              activeContextConfig,
              false,
            ),
        });
        const finalOutput =
          usable.trim() ||
          (isLastStep || step > 1
            ? scope.MISSING_FINAL_RESPONSE_FALLBACK
            : usable);
        appendSubagentAssistant(ledger, runner, step, finalOutput, []);
        if (isLastStep && calls.length)
          publishSubagentEvent(runner, {
            type: "diagnostic",
            level: "warning",
            message:
              "Provider emitted a subagent tool call after tools were disabled; ignored the call and finalized with text",
          });
        if (!output.trim() && (isLastStep || step > 1)) {
          publishSubagentEvent(runner, {
            type: "content.delta",
            id: subagentTurnID(runner),
            text: finalOutput,
          });
          publishSubagentEvent(runner, {
            type: "content.done",
            id: subagentTurnID(runner),
            text: finalOutput,
          });
        }
        runner.log(finalOutput.trim() || "completed without text output");
        finishSubagentConversation(runner, "done");
        await releaseSubagentSteering(runner);
        return;
      }
      // The same normalization the main runner applies before executing a
      // batch: an OpenAI-compatible gateway can emit one id on two streamed
      // calls, and two ledger entries sharing a `pairID` make the replay fold
      // drop one of them — a tool result that silently vanishes from the
      // conversation the provider is shown next step.
      const normalizedCalls = uniqueProviderToolCallIds(calls).calls;
      appendSubagentAssistant(ledger, runner, step, output, normalizedCalls, {
        ...(thinking ? { content: thinking } : {}),
      });
      for (const call of calls) {
        const result = await executeSubagentToolCall({
          call,
          step,
          runner,
          visibleTools,
          childWorkspaceRoot: sandboxRoot,
          repeatedCalls,
          exec,
          writeAuthorize,
          // The child's OWN candidate, read-only (T6-4): a sandboxed subagent
          // used to get no sandbox surface at all, so every `sandbox_*` tool
          // threw "sandbox runtime unavailable" — it could not look at the
          // diff it was about to hand back, and settled blind. It gets a
          // preview of its own candidate and nothing else: no merge, no
          // promotion, no promotion's approval gate. Those stay the parent's.
          sandboxSelf: sandbox
            ? {
                id: runner.agentId,
                preview: async () =>
                  (await sandbox.previewMerge(runner.agentId)).map(
                    (change) => ({
                      ...change,
                      path: change.path,
                    }),
                  ),
              }
            : undefined,
        });
        appendSubagentToolResult(ledger, runner, step, call, result);
      }
    }
    throw new Error("subagent step limit reached");
  }
  await subagentsController.init(async (task, runner) => {
    try {
      const record = subagentsController.get(runner.agentId);
      const parentSessionID = record?.parentSessionID;
      if (!parentSessionID) throw new Error("subagent has no parent session");
      const exec = await scope.ensureExecution(parentSessionID as SessionID);
      const activeProvider = exec.provider;
      if (!activeProvider) throw new Error("provider unavailable for subagent");
      // `mode: "sandbox"` routes to the sub-agent's own worktree; everything
      // else keeps the shared-context loop unchanged.
      if (record?.mode === "sandbox")
        return await runSandboxedSubagent(task, runner, exec, activeProvider);
      const allowed = record?.allowedTools ?? [];
      const excluded = new Set(record?.excludeTools ?? []);
      const resume = await loadSubagentLedgerCheckpoint(runner.agentId);
      const ledger = adoptSubagentLedger(runner, record, () =>
        createSubagentContext(
          agentTypeSystemPrompt(scope, record.agentType) ??
            "You are a focused Natalia TS/Bun subagent. Use the provided native tools for filesystem work. When a tool is needed, call it through the provider's native structured tool-calling interface; never write XML, JSON, Markdown, or prose that imitates a tool call in assistant content. Send findings to the session that spawned you as they happen with send_to_parent — one discovered fact per message, never waiting for the whole run to end; it hears you live and can steer. Return a concise factual final result. Never claim a tool action you did not run. Do not reveal private reasoning.",
          task,
          subagentPlanPointer(ctx, exec),
          // A fork inherits the parent's completed turns; a fresh subagent gets
          // nothing but its task. The seed comes from the *parent's* ledger —
          // the `exec` this runner resolves — so it is the conversation the
          // child is meant to continue.
          record?.context === "fork"
            ? { entries: forkSeedEntries(exec.context.snapshot().entries) }
            : undefined,
          // A continuation continues: the durable checkpoint (the child's own
          // conversation, written when its last run ended) is restored instead
          // of starting from nothing — which is what makes `agent_retry` and
          // `agent_resume` continue work rather than re-derive it.
          resume,
        ),
      );
      const repeatedCalls = new Map<string, number[]>();
      runner.log(`accepted: ${task}`);
      beginSubagentConversation(runner, task);
      const maxSubagentSteps = scope.effectiveMaxSteps(exec);
      const activeContextConfig = { ...exec.runtimeContextConfig };
      for (let step = 1; step <= maxSubagentSteps; step++) {
        const isLastStep =
          Number.isFinite(maxSubagentSteps) && step >= maxSubagentSteps;
        const visibleTools = [...scope.tools.values()].filter(
          (tool) =>
            scope.isToolAllowed(tool.name, exec) &&
            (exec.permissionMode !== "read_only" || !tool.requiresApproval) &&
            !excluded.has(tool.name) &&
            (!allowed.length || allowed.includes(tool.name)),
        );
        // This path pushes no tool of its own, so the filtered set is already
        // unique by name (the registry is keyed by it). The displacement rule
        // lives in `withRunnerTools` for the path that does.
        if (isLastStep)
          ledger.add({
            id: `${runner.agentId}:${step}:max-steps`,
            role: "assistant",
            content: scope.MAX_STEPS_PROMPT,
          });
        const { output, calls, thinking } = await runSubagentProviderStep(
          ledger,
          visibleTools,
          runner,
          step,
          activeProvider,
          activeContextConfig,
          !isLastStep,
        );
        if (!calls.length || isLastStep) {
          // A one-word answer leaves the parent with nothing to act on, so give
          // it one turn to say more before settling for it.
          const usable = await ensureUsableResult({
            ledger,
            setStatus: runner.setStatus,
            step,
            output,
            minChars:
              scope.tsRuntimeConfig?.runtime.subagentMinResultChars ?? 0,
            runStep: (extraStep) =>
              runSubagentProviderStep(
                ledger,
                [],
                runner,
                extraStep,
                activeProvider,
                activeContextConfig,
                false,
              ),
          });
          const finalOutput =
            usable.trim() ||
            (isLastStep || step > 1
              ? scope.MISSING_FINAL_RESPONSE_FALLBACK
              : usable);
          appendSubagentAssistant(ledger, runner, step, finalOutput, []);
          if (isLastStep && calls.length)
            publishSubagentEvent(runner, {
              type: "diagnostic",
              level: "warning",
              message:
                "Provider emitted a subagent tool call after tools were disabled; ignored the call and finalized with text",
            });
          if (!output.trim() && (isLastStep || step > 1)) {
            publishSubagentEvent(runner, {
              type: "content.delta",
              id: subagentTurnID(runner),
              text: finalOutput,
            });
            publishSubagentEvent(runner, {
              type: "content.done",
              id: subagentTurnID(runner),
              text: finalOutput,
            });
          }
          runner.log(finalOutput.trim() || "completed without text output");
          finishSubagentConversation(runner, "done");
          releaseSubagentSteering(runner);
          return;
        }
        const normalizedCalls = uniqueProviderToolCallIds(calls).calls;
        appendSubagentAssistant(ledger, runner, step, output, normalizedCalls, {
          ...(thinking ? { content: thinking } : {}),
        });
        for (const call of calls) {
          const result = await executeSubagentToolCall({
            call,
            step,
            runner,
            visibleTools,
            childWorkspaceRoot: scope.workspaceRoot,
            repeatedCalls,
            exec,
            exposeSandboxes: true,
          });
          appendSubagentToolResult(ledger, runner, step, call, result);
        }
      }
      throw new Error("subagent step limit reached");
    } catch (error) {
      finishSubagentConversation(
        runner,
        runner.signal.aborted ? "cancelled" : "error",
      );
      releaseSubagentSteering(runner);
      throw error;
    }
  });
  subagentsController.subscribe((event) => {
    const record = subagentsController.get(event.agentId);
    const update = {
      type: "subagent.update",
      id: event.agentId,
      event: event.event as Extract<
        RuntimeEvent,
        { type: "subagent.update" }
      >["event"],
      status: event.status as Extract<
        RuntimeEvent,
        { type: "subagent.update" }
      >["status"],
      attached: event.attached,
      task: record?.task,
      text: event.text,
      parentSessionID: event.parentSessionID,
      parentAgentID: event.parentAgentID,
      continuation: event.continuation,
      phase: event.phase ?? record?.phase,
      activityDetail: event.activityDetail ?? record?.activityDetail,
      health: subagentsController.health(event.agentId),
      lastActivityAt: record?.lastActivityAt,
      startedAt: record?.startedAt,
      endedAt: record?.endedAt,
      stopReason: event.stopReason,
      requestedBy: event.requestedBy,
      force: event.force,
    } satisfies Extract<RuntimeEvent, { type: "subagent.update" }>;
    // Registry events can arrive after the UI attaches to another scope.session.
    // Persist them with the spawning scope.session, rather than whichever scope.session
    // happens to be active when the asynchronous subagent reports progress.
    scope.publishForSession(
      scope.executionBySession.get(event.parentSessionID as SessionID),
      update,
    );
    if (event.event === "created" || event.event === "done")
      scope.scheduleRuntimeStatusSnapshot();
    // A subagent settles whenever it likes, and the turn that spawned it is
    // usually elsewhere by then — so the outcome is written into the parent's
    // ledger as runtime context rather than left for it to poll for.
    if (event.event === "done" || event.event === "stopped")
      reportSubagentSettled(event);
  });

  /**
   * Write one terminal outcome into the spawning session's ledger.
   *
   * The entry id is stable per subagent and continuation, so a re-settled
   * continuation replaces its earlier notice instead of stacking duplicates, and
   * the budget caps how much of a session's context the notices may consume.
   */
  function reportSubagentSettled(event: {
    agentId: string;
    status: string;
    parentSessionID?: string;
    continuation?: number;
    stopReason?: string;
  }) {
    if (!event.parentSessionID) return;
    const exec = scope.executionBySession.get(
      event.parentSessionID as SessionID,
    );
    if (!exec) return;
    const continuation = event.continuation ?? 0;
    const entryID = settledNoticeEntryID(event.agentId, continuation);
    // The ledger rejects a duplicate id, so an already-reported continuation is
    // skipped rather than rewritten: the outcome has not changed.
    if (exec.context.snapshot().entries.some((entry) => entry.id === entryID))
      return;
    const existing = exec.context
      .snapshot()
      .entries.filter((entry) =>
        entry.id.startsWith("subagent_settled:"),
      ).length;
    if (
      !settledNoticeAllowed(
        existing,
        scope.tsRuntimeConfig?.runtime.subagentSettledNotices ??
          DEFAULT_SETTLED_NOTICE_BUDGET,
      )
    )
      return;
    const record = subagentsController.get(event.agentId);
    exec.context.add({
      id: entryID,
      role: "dynamic",
      content: subagentSettledNoticeContent({
        agentId: event.agentId,
        status: event.status,
        continuation,
        ...(event.stopReason ? { stopReason: event.stopReason } : {}),
        // The subagent's own last output, so the parent does not have to make a
        // second call to learn what it got.
        finalResult: record?.outputs.at(-1)?.text,
      }),
    });
  }
}
