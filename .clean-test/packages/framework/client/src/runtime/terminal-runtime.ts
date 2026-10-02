/**
 * Native terminal persistence and live events — runtime/terminal-runtime
 * module.
 *
 * Owns the pending-human-terminal metadata writes (persist/clear and the
 * automatic continuation resume), plus the live `terminal.update`/`action`/
 * `timeline`/`viewer` event publishers. Reads live state through
 * `RuntimeContext` at call time.
 */
import type {
  RuntimeTerminalObservationSession,
  RuntimeTerminalSession,
  TerminalAction,
} from "@anthelia/contracts";
import type { SessionStoreController } from "@anthelia/session-store";
import { sessionStoreController as sessionStoreControllerToken } from "@anthelia/session-store";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";
export function createTerminalRuntime(ctx: RuntimeContext) {
  return {
    setPendingHumanTerminal,
    clearPendingHumanTerminal,
    maybeContinueAfterHumanInput,
    publishTerminalSession,
    terminalLiveUpdate,
    publishTerminalViewer,
  };

  async function setPendingHumanTerminal(
    forSessionID: SessionID,
    input: { terminalID: string; reason: string },
  ) {
    const {
      getExecutionBySession,
      getSessionPersistence,
      setSessionPersistence,
      publishForSession,
    } = ctx.ports;
    const target = getExecutionBySession().get(forSessionID);
    const targetSession = target?.session;
    if (!targetSession) return;
    const sessionStoreController = ctx.state.serviceDirectory.get(
      sessionStoreControllerToken,
    );
    targetSession.metadata = { ...targetSession.metadata };
    targetSession.metadata.pendingHumanTerminal = {
      terminalID: input.terminalID,
      reason: input.reason,
      since: new Date().toISOString(),
    };
    const pendingSnapshot = targetSession.metadata.pendingHumanTerminal;
    const sessionPersistence =
      ctx.ports.getSessionPersistenceForSession(forSessionID);
    const next = sessionPersistence
      .then(() =>
        sessionStoreController.updateMetadata(forSessionID, {
          pendingHumanTerminal: pendingSnapshot,
        }),
      )
      .catch((error) =>
        publishForSession(target, {
          type: "diagnostic",
          level: "warning",
          message: `pending human terminal persistence failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    ctx.ports.setSessionPersistenceForSession(forSessionID, next);
    setSessionPersistence(
      Promise.allSettled([getSessionPersistence(), next]).then(() => undefined),
    );
    await next;
  }

  async function clearPendingHumanTerminal(forSessionID: SessionID) {
    const {
      getExecutionBySession,
      getSessionPersistence,
      setSessionPersistence,
      publishForSession,
    } = ctx.ports;
    const target = getExecutionBySession().get(forSessionID);
    const targetSession = target?.session;
    if (!targetSession?.metadata?.pendingHumanTerminal) return false;
    const sessionStoreController = ctx.state.serviceDirectory.get(
      sessionStoreControllerToken,
    );
    targetSession.metadata = { ...targetSession.metadata };
    delete targetSession.metadata.pendingHumanTerminal;
    const sessionPersistence =
      ctx.ports.getSessionPersistenceForSession(forSessionID);
    const next = sessionPersistence
      .then(() =>
        sessionStoreController.updateMetadata(forSessionID, {
          pendingHumanTerminal: undefined,
        }),
      )
      .catch((error) =>
        publishForSession(target, {
          type: "diagnostic",
          level: "warning",
          message: `pending human terminal clear failed: ${error instanceof Error ? error.message : String(error)}`,
        }),
      );
    ctx.ports.setSessionPersistenceForSession(forSessionID, next);
    setSessionPersistence(
      Promise.allSettled([getSessionPersistence(), next]).then(() => undefined),
    );
    await next;
    return true;
  }

  /**
   * TERM-M.3 (c): when the human finishes the requested input on the pending
   * terminal, a new turn resumes the task automatically. Idempotent by
   * construction: the pending state is cleared first, so a second release
   * cannot double-resume.
   */
  async function maybeContinueAfterHumanInput(
    terminalID: string,
    forSessionID?: SessionID,
  ) {
    const {
      getExecutionBySession,
      getActiveExec,
      publishForSession,
      submitInput,
    } = ctx.ports;
    const exec = forSessionID
      ? getExecutionBySession().get(forSessionID)
      : getActiveExec();
    if (!exec) return;
    const pending = exec.session.metadata?.pendingHumanTerminal;
    if (!pending || pending.terminalID !== terminalID) return;
    await clearPendingHumanTerminal(exec.session.id);
    publishForSession(exec, {
      type: "diagnostic",
      level: "info",
      message: `human completed input on terminal ${terminalID}; continuing the task`,
    });
    await submitInput(
      {
        text: `[automated continuation] The human finished providing input on terminal ${terminalID}. Check the terminal output and continue the original task.`,
        delivery: "next-turn",
      },
      exec.session.id,
    );
  }

  function publishTerminalSession(
    terminal: RuntimeTerminalObservationSession,
    action?: TerminalAction,
    redacted = false,
  ) {
    const { publish, scheduleRuntimeStatusSnapshot } = ctx.ports;
    const { terminalStatusByID } = ctx.state;
    publish(terminalLiveUpdate(terminal, action));
    if (action) {
      publish({
        type: "terminal.action",
        id: terminal.id,
        action,
        redacted,
        target: { kind: "host", cwd: terminal.cwd },
      });
      publish({
        type: "terminal.timeline",
        id: terminal.id,
        actor: "user",
        action,
        status: "executed",
        summary: redacted ? "sensitive input supplied" : `${action} executed`,
        at: new Date().toISOString(),
      });
    }
    if (terminalStatusByID.get(terminal.id) !== terminal.status) {
      if (terminal.status === "exited") terminalStatusByID.delete(terminal.id);
      else terminalStatusByID.set(terminal.id, terminal.status);
      scheduleRuntimeStatusSnapshot();
    }
  }

  function terminalLiveUpdate(
    terminal: RuntimeTerminalObservationSession,
    action?: TerminalAction,
  ): Extract<RuntimeEvent, { type: "terminal.update" }> {
    // Framebuffers and transcripts are read on demand. Sending either with every
    // output revision makes the live event stream retain and clone large snapshots.
    return {
      type: "terminal.update",
      id: terminal.id,
      command: terminal.command,
      cwd: terminal.cwd,
      status: terminal.status,
      attached: terminal.attached,
      rows: terminal.rows,
      cols: terminal.cols,
      activity: terminal.status === "running" ? "running" : "waiting",
      tail: terminal.tail,
      lastAction: action,
      target: { kind: "host", cwd: terminal.cwd },
      ownership: terminal.inputOwner?.type === "viewer" ? "user" : "model",
      revision: terminal.revision,
      lastOutputAt: terminal.lastOutputAt,
      viewers: terminal.viewers,
      inputOwner: terminal.inputOwner,
      geometryOwner: terminal.geometryOwner,
    };
  }

  function publishTerminalViewer(
    terminal: RuntimeTerminalSession,
    viewerID: string,
    action: Extract<RuntimeEvent, { type: "terminal.viewer" }>["action"],
    viewerKind?: "external" | "embedded",
  ) {
    publishTerminalSession(terminal);
    const { publish } = ctx.ports;
    publish({
      type: "terminal.viewer",
      id: terminal.id,
      viewerID,
      viewerKind,
      action,
      inputOwner: terminal.inputOwner ?? { type: "model" },
      geometryOwner: terminal.geometryOwner ?? { type: "model" },
      at: new Date().toISOString(),
    });
  }
}
