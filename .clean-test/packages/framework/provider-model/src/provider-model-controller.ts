import type { SessionID } from "@anthelia/contracts";
import type {
  ProviderChatTurnInput,
  ProviderModelController,
  ProviderModelControllerInput,
  ProviderTurnInput,
} from "./contracts";
import { createProviderRunner } from "./provider-runner";
import { noopOperationLog } from "@anthelia/operation-log";

export function createProviderModelController(
  input: ProviderModelControllerInput,
): ProviderModelController {
  const runners = new Map<SessionID, ReturnType<typeof createProviderRunner>>();
  const navi = {
    aborts: new Map<SessionID, AbortController>(),
    tasks: new Map<SessionID, Promise<void>>(),
    wakePending: new Set<SessionID>(),
    wakeTasks: new Map<SessionID, Promise<void>>(),
  };
  const nia = {
    aborts: new Map<SessionID, AbortController>(),
    tasks: new Map<SessionID, Promise<void>>(),
    wakePending: new Set<SessionID>(),
    wakeTasks: new Map<SessionID, Promise<void>>(),
  };
  let disposed = false;
  // T3: the collaborator turns' telemetry rides the operation log — leveled,
  // correlated by the ambient scope the runtime zone wraps the turn body in,
  // rotated — not the raw console.
  const turnLog = input.log ?? noopOperationLog;
  input.initialize();

  async function runTurn(sessionID: SessionID, turn: ProviderTurnInput) {
    if (disposed) throw new Error("provider/model controller disposed");
    let runner = runners.get(sessionID);
    if (!runner) {
      runner = createProviderRunner(input.runnerInput(sessionID));
      runners.set(sessionID, runner);
    }
    await runner.runTurn(turn);
  }

  async function runNaviChatTurn(turn: ProviderChatTurnInput) {
    if (disposed) throw new Error("provider/model controller disposed");
    const key = turn.sessionID;
    if (!input.navi.available(key))
      throw new Error("provider unavailable for Navi");
    if (navi.aborts.has(key)) {
      if (turn.internal) return;
      throw new Error("navi is already busy for this session");
    }
    const startedAt = Date.now();
    const abort = new AbortController();
    navi.aborts.set(key, abort);
    turnLog.info("[navi-turn]", "start", {
      sessionID: turn.sessionID,
      responseMessageID: turn.responseMessageID,
      internal: turn.internal === true,
      model: turn.model?.modelID,
    });
    // Reserve ownership before publishing or invoking user-provided callbacks.
    const task = Promise.resolve().then(() => {
      abort.signal.throwIfAborted();
      return input.navi.runBody(turn, abort.signal);
    });
    navi.tasks.set(key, task);
    try {
      input.navi.publish(key, {
        type: "navi.chat.turn.started",
        id: `${turn.responseMessageID}:started`,
        messageID: turn.responseMessageID,
        startedAt,
        ...(turn.internal ? { internal: true } : {}),
      });
      await task;
      const naviStop = abort.signal.aborted ? "cancelled" : "done";
      turnLog.info("[navi-turn]", "finished", {
        sessionID: turn.sessionID,
        responseMessageID: turn.responseMessageID,
        internal: turn.internal === true,
        stopReason: naviStop,
      });
      input.navi.publish(key, {
        type: "navi.chat.turn.finished",
        id: `${turn.responseMessageID}:finished`,
        messageID: turn.responseMessageID,
        stopReason: naviStop,
        startedAt,
        endedAt: Date.now(),
      });
    } catch (cause) {
      const cancelled = abort.signal.aborted;
      const naviStop = cancelled ? "cancelled" : "error";
      turnLog.error("[navi-turn]", "finished", {
        sessionID: turn.sessionID,
        responseMessageID: turn.responseMessageID,
        internal: turn.internal === true,
        stopReason: naviStop,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      abort.abort(cause);
      await task.catch(() => undefined);
      input.navi.publish(key, {
        type: "navi.chat.turn.finished",
        id: `${turn.responseMessageID}:finished`,
        messageID: turn.responseMessageID,
        stopReason: naviStop,
        startedAt,
        endedAt: Date.now(),
        ...(!cancelled
          ? { error: cause instanceof Error ? cause.message : String(cause) }
          : {}),
      });
      throw cause;
    } finally {
      if (navi.tasks.get(key) === task) navi.tasks.delete(key);
      if (navi.aborts.get(key) === abort) navi.aborts.delete(key);
    }
  }

  async function runNiaChatTurn(turn: ProviderChatTurnInput) {
    if (disposed) throw new Error("provider/model controller disposed");
    const key = turn.sessionID;
    if (!input.nia.available(key))
      throw new Error("provider unavailable for Nia");
    if (nia.aborts.has(key)) {
      if (turn.internal) return;
      throw new Error("nia is already busy for this session");
    }
    const startedAt = Date.now();
    const abort = new AbortController();
    nia.aborts.set(key, abort);
    turnLog.info("[nia-turn]", "start", {
      sessionID: turn.sessionID,
      responseMessageID: turn.responseMessageID,
      internal: turn.internal === true,
      model: turn.model?.modelID,
    });
    const task = Promise.resolve().then(() => {
      abort.signal.throwIfAborted();
      return input.nia.runBody(turn, abort.signal);
    });
    nia.tasks.set(key, task);
    try {
      input.nia.publish(key, {
        type: "nia.chat.turn.started",
        id: `${turn.responseMessageID}:started`,
        messageID: turn.responseMessageID,
        startedAt,
        ...(turn.internal ? { internal: true } : {}),
      });
      await task;
      const niaStop = abort.signal.aborted ? "cancelled" : "done";
      turnLog.info("[nia-turn]", "finished", {
        sessionID: turn.sessionID,
        responseMessageID: turn.responseMessageID,
        internal: turn.internal === true,
        stopReason: niaStop,
      });
      input.nia.publish(key, {
        type: "nia.chat.turn.finished",
        id: `${turn.responseMessageID}:finished`,
        messageID: turn.responseMessageID,
        stopReason: niaStop,
        startedAt,
        endedAt: Date.now(),
      });
    } catch (cause) {
      const cancelled = abort.signal.aborted;
      const niaStop = cancelled ? "cancelled" : "error";
      turnLog.error("[nia-turn]", "finished", {
        sessionID: turn.sessionID,
        responseMessageID: turn.responseMessageID,
        internal: turn.internal === true,
        stopReason: niaStop,
        error: cause instanceof Error ? cause.message : String(cause),
      });
      abort.abort(cause);
      await task.catch(() => undefined);
      input.nia.publish(key, {
        type: "nia.chat.turn.finished",
        id: `${turn.responseMessageID}:finished`,
        messageID: turn.responseMessageID,
        stopReason: niaStop,
        startedAt,
        endedAt: Date.now(),
        ...(!cancelled
          ? { error: cause instanceof Error ? cause.message : String(cause) }
          : {}),
      });
      throw cause;
    } finally {
      if (nia.tasks.get(key) === task) nia.tasks.delete(key);
      if (nia.aborts.get(key) === abort) nia.aborts.delete(key);
    }
  }

  function requestNaviWake(sessionID: SessionID) {
    if (disposed) return;
    navi.wakePending.add(sessionID);
    if (navi.wakeTasks.has(sessionID)) return;
    const task = Promise.resolve()
      .then(async () => {
        while (navi.wakePending.has(sessionID) && !disposed) {
          await navi.tasks.get(sessionID)?.catch(() => undefined);
          if (!navi.wakePending.delete(sessionID)) break;
          if (!disposed && input.navi.available(sessionID))
            await input.navi.wake(sessionID);
        }
      })
      .finally(() => {
        if (navi.wakeTasks.get(sessionID) === task)
          navi.wakeTasks.delete(sessionID);
        if (navi.wakePending.has(sessionID) && !disposed)
          requestNaviWake(sessionID);
      });
    navi.wakeTasks.set(sessionID, task);
    void task.catch(() => undefined);
  }

  function requestNiaWake(sessionID: SessionID) {
    if (disposed) return;
    nia.wakePending.add(sessionID);
    if (nia.wakeTasks.has(sessionID)) return;
    const task = Promise.resolve()
      .then(async () => {
        while (nia.wakePending.has(sessionID) && !disposed) {
          await nia.tasks.get(sessionID)?.catch(() => undefined);
          if (!nia.wakePending.delete(sessionID)) break;
          if (!disposed && input.nia.available(sessionID))
            await input.nia.wake(sessionID);
        }
      })
      .finally(() => {
        if (nia.wakeTasks.get(sessionID) === task)
          nia.wakeTasks.delete(sessionID);
        if (nia.wakePending.has(sessionID) && !disposed)
          requestNiaWake(sessionID);
      });
    nia.wakeTasks.set(sessionID, task);
    void task.catch(() => undefined);
  }

  function abortNavi(sessionID: SessionID) {
    const abort = navi.aborts.get(sessionID);
    if (!abort) return false;
    navi.wakePending.delete(sessionID);
    abort.abort(new Error("navi aborted"));
    return true;
  }

  function abortNia(sessionID: SessionID) {
    const abort = nia.aborts.get(sessionID);
    if (!abort) return false;
    nia.wakePending.delete(sessionID);
    abort.abort(new Error("nia aborted"));
    return true;
  }

  async function dispose() {
    if (disposed) return;
    disposed = true;
    navi.wakePending.clear();
    nia.wakePending.clear();
    for (const abort of [...navi.aborts.values(), ...nia.aborts.values()])
      abort.abort(new Error("provider/model controller disposed"));
    await Promise.allSettled([
      ...navi.tasks.values(),
      ...nia.tasks.values(),
      ...navi.wakeTasks.values(),
      ...nia.wakeTasks.values(),
    ]);
    runners.clear();
  }

  return {
    runTurn,
    runNaviChatTurn,
    runNiaChatTurn,
    requestNaviWake,
    requestNiaWake,
    abortNavi,
    abortNia,
    naviBusy: (id) => navi.aborts.has(id),
    niaBusy: (id) => nia.aborts.has(id),
    dispose,
  };
}
