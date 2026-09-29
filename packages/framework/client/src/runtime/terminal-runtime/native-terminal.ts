import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import { terminalController } from "@anthelia/runtime-services";
import { RuntimeRefusal } from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import {
  ensureSessionEventWindow,
  sessionWindowEvents,
} from "@anthelia/substrate";

type ClientSurfaceOptions = Pick<
  RealRuntimeClientOptions,
  "episodeID" | "globalConfigPath"
>;
type Surface = Pick<
  RuntimeServiceClient,
  | "nativeTerminalList"
  | "nativeTerminalRead"
  | "nativeTerminalOpenHub"
  | "nativeTerminalRevokeApprovalScope"
  | "nativeTerminalClaimHumanInput"
  | "nativeTerminalReleaseHumanControl"
  | "nativeTerminalBeginSecureInput"
  | "nativeTerminalEndSecureInput"
  | "nativeTerminalStop"
  | "nativeTerminalStart"
  | "nativeTerminalWrite"
  | "nativeTerminalResize"
  | "subscribeTerminalOutput"
>;

function refusalFromRegistry(error: unknown): RuntimeRefusal {
  return new RuntimeRefusal(
    error instanceof Error ? error.message : String(error),
  );
}

function sessionExec(ctx: RuntimeContext, sessionID?: string) {
  return sessionID
    ? ctx.ports
        .getExecutionBySession()
        .get(sessionID as import("@anthelia/contracts").SessionID)
    : ctx.ports.getActiveExec();
}

async function terminalIDsFor(
  ctx: RuntimeContext,
  exec: import("@anthelia/substrate").SessionExecutionState | undefined,
) {
  if (!exec?.session) return new Set<string>();
  const window = await ensureSessionEventWindow(ctx, exec);
  const events = window
    ? sessionWindowEvents(exec, window)
    : exec.session.events;
  return new Set(
    events
      .filter((event) => event.type === "terminal.timeline")
      .map((event) => event.id),
  );
}

async function assertTerminalOwned(
  ctx: RuntimeContext,
  exec: import("@anthelia/substrate").SessionExecutionState,
  id: string,
) {
  if (!(await terminalIDsFor(ctx, exec)).has(id))
    throw new Error(
      `terminal ${id} does not belong to session ${exec.session.id}`,
    );
}

export function createNativeTerminalSurface(
  ctx: RuntimeContext,
  options: ClientSurfaceOptions,
): Surface {
  return {
    async nativeTerminalList(sessionID?: string) {
      await ctx.ports.getReady();
      const terminal =
        ctx.state.serviceDirectory.getOptional(terminalController);
      return (await terminal?.list(sessionID)) ?? [];
    },
    async nativeTerminalRead(id, sessionID?: string) {
      await ctx.ports.getReady();
      const exec = sessionExec(ctx, sessionID);
      if (sessionID && exec) await assertTerminalOwned(ctx, exec, id);
      const terminal = ctx.state.serviceDirectory.get(terminalController);
      const { text } = await terminal.read(id, {
        maxLines: 200,
        ...(sessionID ? { sessionID } : {}),
      });
      return { id, text };
    },
    async nativeTerminalOpenHub() {
      await ctx.ports.getReady();
      const terminal = ctx.state.serviceDirectory.get(terminalController);
      return await terminal.openHub();
    },
    async nativeTerminalRevokeApprovalScope(id, _sessionID?: string) {
      await ctx.ports.getReady();
      const terminal = ctx.state.serviceDirectory.get(terminalController);
      return ctx.ports.getInteractive().revokeTerminalApprovalScope(id);
    },
    async nativeTerminalClaimHumanInput(id, sessionID?: string) {
      await ctx.ports.getReady();
      const exec = sessionExec(ctx, sessionID);
      if (sessionID && exec) await assertTerminalOwned(ctx, exec, id);
      const terminal =
        ctx.state.serviceDirectory.getOptional(terminalController);
      if (!terminal?.claimHumanInput)
        throw new Error("Native Terminal Host is unavailable");
      return await terminal.claimHumanInput(id, sessionID);
    },
    async nativeTerminalReleaseHumanControl(id, sessionID) {
      await ctx.ports.getReady();
      const exec = sessionExec(ctx, sessionID);
      if (sessionID && exec) await assertTerminalOwned(ctx, exec, id);
      const terminal = ctx.state.serviceDirectory.get(terminalController);
      const sessionView = terminal.releaseHumanControl(id, sessionID);
      // TERM-M.3 (c): the remote release path triggers the same continuation
      // as the local timeline-detach path. Pass the owning session so a
      // background session's terminal release does not fall back to active.
      void ctx.ports.maybeContinueAfterHumanInput(
        id,
        sessionID as import("@anthelia/contracts").SessionID | undefined,
      );
      return sessionView;
    },
    async nativeTerminalBeginSecureInput(id, sessionID?: string) {
      await ctx.ports.getReady();
      const exec = sessionExec(ctx, sessionID);
      if (sessionID && exec) await assertTerminalOwned(ctx, exec, id);
      const terminal = ctx.state.serviceDirectory.get(terminalController);
      return terminal.beginSecureInput(id, sessionID);
    },
    async nativeTerminalEndSecureInput(id, sessionID?: string) {
      await ctx.ports.getReady();
      const exec = sessionExec(ctx, sessionID);
      if (sessionID && exec) await assertTerminalOwned(ctx, exec, id);
      const terminal = ctx.state.serviceDirectory.get(terminalController);
      return terminal.endSecureInput(id, sessionID);
    },
    async nativeTerminalStop(id, sessionID?: string) {
      await ctx.ports.getReady();
      const exec = sessionExec(ctx, sessionID);
      if (sessionID && exec) await assertTerminalOwned(ctx, exec, id);
      const terminal = ctx.state.serviceDirectory.get(terminalController);
      return {
        ...(await terminal.stop(id, "human", sessionID)),
        status: "exited",
      };
    },
    // --- P0-H: the terminal write surface, host-gated at the transport ---
    // Remote callers are treated as model-side actors: ownership, secure-input
    // and geometry arbitration are the same ones the model tools go through.
    async nativeTerminalStart(input: {
      command: string;
      cwd?: string;
      id?: string;
      sessionID?: string;
      agentID?: string;
      rows?: number;
      cols?: number;
    }) {
      await ctx.ports.getReady();
      const owner = ctx.ports.getActiveExec();
      const sessionID = input.sessionID ?? owner?.session.id;
      if (!sessionID) throw new RuntimeRefusal("session is not initialized");
      if (
        input.sessionID &&
        !ctx.ports
          .getExecutionBySession()
          .get(input.sessionID as import("@anthelia/contracts").SessionID)
      )
        throw new RuntimeRefusal(`session not found: ${input.sessionID}`);
      const terminal = ctx.state.serviceDirectory.get(terminalController);
      try {
        return await terminal.start({
          command: input.command,
          cwd: input.cwd ?? ctx.ports.getWorkspaceRoot(),
          id: input.id,
          sessionID,
          ...(input.agentID ? { agentID: input.agentID } : {}),
          ...(input.rows !== undefined ? { rows: input.rows } : {}),
          ...(input.cols !== undefined ? { cols: input.cols } : {}),
        });
      } catch (error) {
        throw refusalFromRegistry(error);
      }
    },
    async nativeTerminalWrite(input: {
      id: string;
      input: string;
      idempotencyKey?: string;
      sessionID?: string;
      /** Defaults to the model: a tool call writing into a terminal. */
      actor?: "model" | "human";
    }) {
      await ctx.ports.getReady();
      const exec = sessionExec(ctx, input.sessionID);
      if (input.sessionID && exec)
        await assertTerminalOwned(ctx, exec, input.id);
      const terminal = ctx.state.serviceDirectory.get(terminalController);
      try {
        const result = await terminal.write(input.id, input.input, {
          idempotencyKey: input.idempotencyKey,
          ...(input.sessionID ? { sessionID: input.sessionID } : {}),
          ...(input.actor ? { actor: input.actor } : {}),
        });
        return { id: input.id, ...result };
      } catch (error) {
        throw refusalFromRegistry(error);
      }
    },
    async nativeTerminalResize(input: {
      id: string;
      rows: number;
      cols: number;
      sessionID?: string;
      /**
       * Who is resizing. Defaults to human: this RPC is the UI pane's path
       * (the browser's xterm fitting its host), and auditing a human's pane
       * drag as the model's action made the audit surface lie about who
       * touched the geometry.
       */
      actor?: "model" | "human";
    }) {
      await ctx.ports.getReady();
      const exec = sessionExec(ctx, input.sessionID);
      if (input.sessionID && exec)
        await assertTerminalOwned(ctx, exec, input.id);
      const terminal = ctx.state.serviceDirectory.get(terminalController);
      try {
        return await terminal.resize(
          input.id,
          input.rows,
          input.cols,
          input.actor ?? "human",
          input.sessionID,
        );
      } catch (error) {
        throw refusalFromRegistry(error);
      }
    },
    subscribeTerminalOutput(id, listener) {
      const terminal =
        ctx.state.serviceDirectory.getOptional(terminalController);
      if (!terminal?.subscribeOutput)
        throw new RuntimeRefusal("Native Terminal Host is unavailable");
      return terminal.subscribeOutput(id, listener);
    },
  };
}
