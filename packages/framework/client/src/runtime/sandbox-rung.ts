/**
 * 洞 2's four-rung ladder: the session's confinement rung, switchable by
 * the human mid-session, and TOLD to the model.
 *
 * The ladder has four rungs (the sandbox study's, in our words):
 *
 *   1  read-only       every write refused
 *   2  ask             every write asks (the deployment default)
 *   3  workspace-write  in-domain writes automatic; outside refused, with a
 *                      per-call escalation available
 *   4  full            writes anywhere, asks nothing
 *
 * Rungs 1/3/4 are confinement modes the policy home resolves; the
 * ask/automatic distinction between 2 and 3 is the orthogonal approval axis
 * the design keeps (per-tool requiresApproval, the permission floors). What
 * this module adds is the SESSION-SCOPED rung: the human granting an
 * escalation "for session" instead of per-call moves the rung for the rest
 * of the session, and the model is told through the same durable,
 * latest-win `context.instructions` channel a generation switch uses — a
 * model that just received a wider sandbox and does not know it keeps
 * apologising for writes it is now allowed to make.
 *
 * The wire between the escalation's request and the response's grant is the
 * approval id: the escalation channel stamps the mode it asked for, and the
 * response hook reads it back. The id is the runtime's own matching handle
 * (the dialog shows the title and preview, never the id), so carrying the
 * mode there needs no second table that could disagree with the request.
 */

import { nextContextInstructionsRevision } from "@anthelia/session";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionExecutionState } from "@anthelia/substrate";
import type { ConfinementMode } from "@anthelia/confinement";
import { CONFINEMENT_MODES } from "@anthelia/contracts";
import type { ApprovalResponse, SessionID } from "@anthelia/contracts";

/** The escalation approval id's rung suffix (see the module doc). */
export const SANDBOX_ESCALATION_SUFFIX = ":sandbox:";

export function sandboxEscalationID(toolID: string, mode: ConfinementMode) {
  return `${toolID}${SANDBOX_ESCALATION_SUFFIX}${mode}`;
}

function isConfinementMode(mode: string): mode is ConfinementMode {
  return (CONFINEMENT_MODES as readonly string[]).includes(mode);
}

/**
 * The rung a sandbox-escalation approval id asked for, or undefined when
 * the id is not a rung-carrying escalation (a plain tool approval, a
 * question, an interactive request).
 */
export function rungFromApprovalID(id: string): ConfinementMode | undefined {
  const at = id.indexOf(SANDBOX_ESCALATION_SUFFIX);
  if (at === -1) return undefined;
  const mode = id.slice(at + SANDBOX_ESCALATION_SUFFIX.length);
  return isConfinementMode(mode) ? mode : undefined;
}

/** A session-scoped grant on a rung-carrying escalation, when it is one. */
export function rungGrantFromResponse(
  response: ApprovalResponse,
): ConfinementMode | undefined {
  if (response.decision !== "session") return undefined;
  return rungFromApprovalID(response.requestID);
}

/**
 * Apply a session-scoped rung grant to the session's execution state and
 * tell the model. Returns the notice that was published, or undefined when
 * nothing changed (the session already ran that rung, or the session is not
 * live) — a switch to the rung you are already on is not news.
 */
export function applySandboxRungGrant(
  ctx: RuntimeContext,
  sessionID: SessionID,
  mode: ConfinementMode,
): { from?: ConfinementMode; to: ConfinementMode } | undefined {
  const exec = ctx.ports.getExecutionBySession().get(sessionID);
  if (!exec) return undefined;
  const from = exec.sandboxModeOverride;
  if (from === mode) return undefined;
  exec.sandboxModeOverride = mode;
  publishSandboxRungNotice(ctx, exec, { from, to: mode });
  return { from, to: mode };
}

/**
 * The notice: a `context.instructions` record of kind `sandbox_rung`, the
 * same durable latest-win channel a generation switch rides. The summary
 * names the rung in the human's vocabulary (the four rungs, not the mode
 * string) so the model reads "you may now write anywhere in the workspace
 * without asking" rather than "workspace-write".
 */
export function publishSandboxRungNotice(
  ctx: RuntimeContext,
  exec: SessionExecutionState,
  input: { from?: ConfinementMode; to: ConfinementMode },
): void {
  const revision = nextContextInstructionsRevision(exec.session.events);
  ctx.ports.publishForSession(exec, {
    type: "context.instructions",
    id: `context:sandbox-rung:${Date.now().toString(36)}:${revision}`,
    kind: "sandbox_rung",
    at: new Date().toISOString(),
    revision,
    summary:
      `the human moved this session's sandbox rung to ${rungLabel(input.to)}` +
      (input.from ? ` (was ${rungLabel(input.from)})` : ""),
    detail: [
      `rung ${input.to}: ${rungMeaning(input.to)}`,
      ...(input.from
        ? [`previously rung ${input.from}: ${rungMeaning(input.from)}`]
        : []),
      "the change is scoped to this session; a new session starts at the deployment's rung",
    ],
  });
}

/** The rung's number in the ladder (the human's vocabulary). */
export function rungLabel(mode: ConfinementMode): string {
  switch (mode) {
    case "read-only":
      return "1 read-only";
    case "workspace-write":
      return "3 workspace-write";
    case "danger-full-access":
      return "4 full";
  }
}

function rungMeaning(mode: ConfinementMode): string {
  switch (mode) {
    case "read-only":
      return "every write is refused";
    case "workspace-write":
      return "writes inside the workspace are automatic; outside is refused unless the human grants it per call";
    case "danger-full-access":
      return "writes anywhere are automatic, with no confinement and no prompt";
  }
}
