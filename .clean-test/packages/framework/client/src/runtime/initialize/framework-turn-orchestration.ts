/**
 * Framework subsystem composition — initialize/framework-turn-orchestration.ts.
 *
 * Durable turn admission, promotion and dispatch ordering is a framework-
 * internal subsystem, not a plugin: this module constructs the turn controller
 * directly and contributes it as the `turn.controller` service. It depends on
 * the session-store subsystem, which is wired before it.
 */
import { buildSubmittedTurn } from "@anthelia/session";
import type { ProductRuntimeContext } from "@natalia/collab";
import {
  createTurnController,
  turnController,
} from "@anthelia/turn-orchestration";
import { providerModelController } from "@anthelia/provider-model";
import { sessionStoreController } from "@anthelia/session-store";
import type { SessionID } from "@anthelia/contracts";
import type { SessionStoreController } from "@anthelia/session-store";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import type { ProviderModelController } from "@anthelia/provider-model";
import { logOf } from "@anthelia/operation-log";

export type TurnOrchestrationHandle = { close(): void };

/**
 * The `turn.submitted` fact for a turn that is actually starting, unless the
 * journal already has one (recovery/replay). The admitted input record carries
 * the attachments/resources/agents that a command otherwise never sees.
 */
function buildAnnouncedTurn(
  owner: SessionExecutionState,
  id: string,
  text: string,
) {
  if (owner.announcedTurnIDs.has(id)) return undefined;
  const input = owner.session.inbox?.find((item) => item.id === id);
  return buildSubmittedTurn({
    id,
    text,
    attachments: input?.attachments,
    resources: input?.resources,
    agents: input?.agents,
    internal: input?.internal,
  });
}

export function wireTurnOrchestration(
  ctx: ProductRuntimeContext,
): TurnOrchestrationHandle {
  const registry = ctx.state.capabilityRegistry;
  const deps = ctx.state.initialize;
  const owner = registry.registerOwner({
    id: "natalia-turn-orchestration",
    name: "Turn Orchestration",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services"],
  });
  const controller = createTurnController({
    session: ctx.ports.getSession,
    activeAbort: () => ctx.ports.getActiveExec()?.activeAbort,
    sessionFor: (id) =>
      ctx.state.executionBySession.get(id as SessionID)?.session ??
      ctx.ports.getSession(),
    activeAbortFor: (id) =>
      ctx.state.executionBySession.get(id as SessionID)?.activeAbort,
    persist: (fn) => {
      const persistence = ctx.ports
        .getSessionPersistence()
        .then(fn)
        .catch((error) =>
          ctx.ports.publish({
            type: "diagnostic",
            level: "warning",
            message: `session persistence deferred/failed: ${error instanceof Error ? error.message : String(error)}`,
          }),
        );
      ctx.ports.setSessionPersistence(persistence);
      return persistence;
    },
    saveInbox: async (snapshot) => {
      const sessionStore = ctx.state.serviceDirectory.get(
        sessionStoreController,
      );
      await sessionStore.saveInbox(snapshot);
    },
    // The claim authority: the durable inbox as it stands on disk. Two
    // live clients over one session each hold their own record, so a
    // claim made in the other's memory would be invisible here and the
    // turn would run twice — the CI red this closes.
    loadInbox: async (sessionID) => {
      const sessionStore = ctx.state.serviceDirectory.get(
        sessionStoreController,
      );
      return await sessionStore.loadInbox(sessionID as SessionID);
    },
    flush: async () => {
      await ctx.ports.getSessionPersistence();
    },
    runCommand: async (id, text, signal, ownerID) =>
      // §4.5: correlation injected on the record side — everything logged
      // inside a command/turn carries session+turn without any call site
      // passing them (the Hermes record factory, ported to ALS).
      logOf(ctx.state.serviceDirectory).runWithCorrelation(
        { sessionID: ownerID as string, turnID: id },
        async () => {
          const owner = await ctx.ports.ensureExecution(ownerID as SessionID);
          // Commands start a real turn too, so they announce it before it runs.
          const submitted = buildAnnouncedTurn(owner, id, text);
          if (submitted) {
            ctx.ports.publishForSession(owner, submitted);
            owner.announcedTurnIDs.add(id);
          }
          ctx.ports.publishForSession(owner, { type: "turn.started", id });
          try {
            return await deps.handleCommand(id, text, signal, owner);
          } catch (error) {
            ctx.ports.publishForSession(owner, {
              type: "turn.cancelled",
              id,
              reason: error instanceof Error ? error.message : String(error),
            });
            throw error;
          } finally {
            deps.scheduleTitleGeneration(ownerID as SessionID);
            ctx.state.selfReview?.schedule(ownerID);
          }
        },
      ),
    runTurn: async (input) =>
      logOf(ctx.state.serviceDirectory).runWithCorrelation(
        {
          sessionID: input.sessionID as string,
          turnID: input.id,
        },
        async () => {
          deps.deliverQueuedMailboxAtBoundary(
            ctx.state.executionBySession.get(input.sessionID as SessionID),
          );
          try {
            const controller = ctx.state.serviceDirectory.getOptional(
              providerModelController,
            );
            if (controller)
              await controller.runTurn(input.sessionID as SessionID, input);
            else {
              const exec = ctx.state.executionBySession.get(
                input.sessionID as SessionID,
              );
              ctx.ports.publishForSession(exec, {
                type: "diagnostic",
                level: "error",
                message: "Provider/model subsystem is unavailable.",
              });
              ctx.ports.publishForSession(exec, {
                type: "turn.finished",
                id: input.id,
                stopReason: "error",
              });
            }
          } finally {
            deps.scheduleTitleGeneration(input.sessionID as SessionID);
            ctx.state.selfReview?.schedule(input.sessionID);
          }
        },
      ),
  });
  ctx.state.serviceDirectory.provide(turnController, controller);
  return {
    close() {
      controller.dispose();
    },
  };
}
