import { SubagentRegistry } from "./registry";
import type { SubagentRunnerContext } from "@anthelia/tools";
import type { SubagentsService } from "@anthelia/runtime-services";

type SubagentRunner = (
  task: string,
  context: SubagentRunnerContext,
) => void | Promise<void>;

type SubagentsController = SubagentsService;

export function createSubagentsController(input: {
  workDir: string;
  sessionID?: () => string | undefined;
  /** Milliseconds one run may take; 0 disables the budget. */
  wallClockBudgetMs?: number;
  /** The settlement hook, bound by the composition to the spine. */
  onSettled?: (record: import("./types").SubagentRecord) => void;
  /** The child's mid-run message hook, bound by the composition. */
  onChildMessage?: (message: { agentId: string; text: string }) => void;
}): SubagentsController {
  let registry: SubagentRegistry | undefined;

  async function init(runner: SubagentRunner) {
    const next = new SubagentRegistry({
      workDir: input.workDir,
      runner,
      sessionID: input.sessionID?.(),
      wallClockBudgetMs: input.wallClockBudgetMs,
      onSettled: input.onSettled,
      onChildMessage: input.onChildMessage,
    });
    await next.load();
    registry = next;
  }

  /**
   * Install or clear the live-delivery hook for one subagent.
   *
   * The runtime that owns the child's ledger is the only thing that can reach
   * it, so it installs the hook for the duration of the child's run and clears
   * it when the run ends — after which a message queues instead of vanishing.
   */
  function setSteerHook(
    id: string,
    hook:
      | ((message: string) => "delivered" | "resumed" | undefined)
      | undefined,
  ) {
    requireRegistry().setSteerHook(id, hook);
  }

  function enabled() {
    return registry !== undefined;
  }

  function requireRegistry(): SubagentRegistry {
    if (!registry) throw new Error("subagent registry is not initialized");
    return registry;
  }

  function runningCount() {
    return registry?.runningCount() ?? 0;
  }

  return {
    init,
    enabled,
    spawn: async (task, options) =>
      await requireRegistry().spawn(task, options),
    list: () => requireRegistry().list(),
    runningCount,
    get: (id) => requireRegistry().get(id),
    status: (id) => requireRegistry().status(id),
    health: (id) => requireRegistry().health(id),
    requestStop: (id, reason, force) =>
      requireRegistry().requestStop(id, reason, force),
    stop: (id) => requireRegistry().stop(id),
    resume: async (id) => await requireRegistry().resume(id),
    setPendingMessages: (id, messages) =>
      requireRegistry().setPendingMessages(id, messages),
    setSteerHook,
    // Authority, live routing and the queueing fallback all live on the registry
    // now, so both a bare registry and this composition answer a steer the same
    // way instead of the composition being the only one that can.
    sendMessage: async (id, message, callerSession) =>
      await requireRegistry().sendMessage(id, message, callerSession),
    retry: async (id) => await requireRegistry().retry(id),
    attach: (id) => requireRegistry().attach(id),
    detach: (id) => requireRegistry().detach(id),
    cleanup: (dryRun) => requireRegistry().cleanup(dryRun),
    audit: (tail, format) => requireRegistry().audit(tail, format),
    subscribe: (fn) => requireRegistry().subscribe(fn),
    formatList: async () => await requireRegistry().formatList(),
    formatOutput: async (id, verbose) =>
      await requireRegistry().formatOutput(id, verbose),
    formatStatus: async (id) => await requireRegistry().formatStatus(id),
    wait: async (ids, until, timeoutMs, signal) =>
      await requireRegistry().wait(ids, until, timeoutMs, signal),
  } satisfies SubagentsController;
}
