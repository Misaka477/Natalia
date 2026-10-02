import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import { sessionStoreController } from "@anthelia/session-store";
import { projectInteractiveRequests } from "@anthelia/session";
import type { SessionID } from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";
import type { ClientSurfaceOptions } from "./types";
import { perfLog } from "@anthelia/runtime-services";
import type { SessionStoreController } from "@anthelia/session-store";
type Surface = Pick<
  RuntimeServiceClient,
  "history" | "messages" | "pendingInteractive" | "submitInput"
>;
export function createTranscriptSurface(
  ctx: RuntimeContext,
  options: ClientSurfaceOptions,
): Surface {
  return {
    submitInput: ctx.ports.submitInput,
    async history(options = {}) {
      await ctx.ports.getReady();
      const sessionStore = ctx.state.serviceDirectory.get(
        sessionStoreController,
      );
      if (!sessionStore)
        throw new Error("session store unavailable (natalia-session-store)");
      const requestedID = (options.sessionID ??
        ctx.ports.getSessionID()) as SessionID;
      const attached = ctx.ports.getSession();
      const fallback =
        attached && attached.id === requestedID ? (attached.events ?? []) : [];
      return await sessionStore.history(requestedID, fallback, options);
    },
    async messages(options = {}) {
      await ctx.ports.getReady();
      const requestedID = (options.sessionID ??
        ctx.ports.getSessionID()) as SessionID;
      const exec = ctx.ports.getExecutionBySession().get(requestedID);
      const session = exec?.session ?? ctx.ports.getSession();
      if (!session) throw new Error("session initialization did not complete");
      const sessionStore = ctx.state.serviceDirectory.get(
        sessionStoreController,
      );
      if (!sessionStore)
        throw new Error("session store unavailable (natalia-session-store)");
      const start = performance.now();
      const page = await sessionStore.messages(requestedID, session, options);
      perfLog(
        `[perf] session.messages ${requestedID} ${(performance.now() - start).toFixed(1)}ms`,
      );
      return page;
    },
    async pendingInteractive(input = {}) {
      await ctx.ports.getReady();
      const requestedID = (input.sessionID ??
        ctx.ports.getSessionID()) as SessionID;
      const exec = await ctx.ports.ensureExecution(requestedID);
      return projectInteractiveRequests(exec.session.events ?? []);
    },
  };
}
