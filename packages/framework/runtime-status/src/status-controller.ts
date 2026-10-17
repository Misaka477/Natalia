import type {
  ContributedCommand,
  RuntimeEvent,
  SessionID,
} from "@anthelia/contracts";

export type StatusProvider = { provider: string; model: string };
export type StatusContextLedger = {
  journalStatus(): { tokenEstimate: number; messageCount: number };
};
export interface StatusSnapshotController {
  snapshot(): Promise<Extract<RuntimeEvent, { type: "status.snapshot" }>>;
  snapshotFor(overrides?: {
    provider?: StatusProvider;
    context?: StatusContextLedger;
    permissionMode?: "ask" | "auto" | "read_only";
    /**
     * Provider steps the session has run (one per `runtime.step_usage`). The
     * caller owns the figure because only a session knows it; without one the
     * snapshot carries no `steps` rather than the journal's entry count, which
     * is a different measure under the same word.
     */
    steps?: number;
  }): Promise<Extract<RuntimeEvent, { type: "status.snapshot" }>>;
  schedule(): void;
  dispose(): void;
}

export type RuntimeStatusInput = {
  provider(): StatusProvider | undefined;
  context(): StatusContextLedger;
  workspaceRoot: string;
  permissionMode(): "ask" | "auto" | "read_only";
  runningCount(): Promise<number>;
  publish(event: RuntimeEvent): void;
  /**
   * Provider steps the active session has run, when the wiring can answer.
   * `schedule()` publishes without a session in hand, so an unwired runtime
   * simply omits the figure instead of guessing.
   */
  stepCount?(): number;
  commands?: {
    list(): ContributedCommand[];
    session(sessionID: SessionID): Promise<RuntimeStatusCommandSession>;
    publish(sessionID: SessionID, event: RuntimeEvent): void;
    egressAdvisory: string;
  };
};

export type RuntimeStatusCommandSession = {
  provider?: StatusProvider;
  providerSource: string;
  workspaceRoot: string;
  sessionID: SessionID;
  toolsSize: number;
  selectedAgentName?: string;
  skillsCount: number;
  diagnostics: Array<
    Extract<RuntimeEvent, { type: "diagnostic" }> & { at: string }
  >;
  snapshot: Extract<RuntimeEvent, { type: "status.snapshot" }>;
};

export function createStatusSnapshotController(
  input: RuntimeStatusInput,
): StatusSnapshotController {
  let refreshQueued = false;
  let disposed = false;

  async function snapshotFor(overrides?: {
    provider?: StatusProvider;
    context?: StatusContextLedger;
    permissionMode?: "ask" | "auto" | "read_only";
    steps?: number;
  }) {
    const running = await input.runningCount();
    return statusSnapshot(
      overrides?.provider ?? input.provider(),
      overrides?.context ?? input.context(),
      input.workspaceRoot,
      overrides?.permissionMode ?? input.permissionMode(),
      running,
      overrides?.steps ?? input.stepCount?.(),
    );
  }

  async function snapshot() {
    return await snapshotFor();
  }

  function schedule() {
    if (refreshQueued || disposed) return;
    refreshQueued = true;
    queueMicrotask(() => {
      refreshQueued = false;
      if (disposed) return;
      void snapshot()
        .then((event) => {
          if (!disposed) input.publish(event);
        })
        .catch((error) =>
          !disposed
            ? input.publish({
                type: "diagnostic",
                level: "warning",
                message: `runtime status refresh failed: ${error instanceof Error ? error.message : String(error)}`,
              })
            : undefined,
        );
    });
  }

  return {
    snapshot,
    snapshotFor,
    schedule,
    dispose() {
      disposed = true;
    },
  };
}

export function statusSnapshot(
  provider: StatusProvider | undefined,
  context: StatusContextLedger,
  cwd: string,
  permissionMode: "ask" | "auto" | "read_only",
  running: number,
  steps?: number,
  platform: string = process.platform,
): Extract<RuntimeEvent, { type: "status.snapshot" }> {
  const status = context.journalStatus();
  return {
    type: "status.snapshot",
    model: provider?.model ?? "not-configured",
    provider: provider?.provider ?? "not-configured",
    context: `${status.tokenEstimate} tokens`,
    step: `${status.messageCount}`,
    // The provider-step figure rides only when a session supplied it: an
    // absent field is "nobody counted", while the journal's entry count under
    // the same word is how two faces came to report one run as two numbers.
    ...(steps !== undefined ? { steps } : {}),
    permissions: permissionMode,
    cwd,
    background: `${running} running`,
    platform,
  };
}
