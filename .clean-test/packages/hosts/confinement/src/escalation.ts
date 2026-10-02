import type { ConfinementMode } from "@anthelia/contracts";

/**
 * The sandbox escalation vocabulary and choreography.
 *
 * Ported from dsh's `sandbox/src/escalation.ts`
 * (`devref/deepseek-harness/packages/sandbox/sandbox/src/escalation.ts`):
 * the strictly-wider table, the argument-pairing validation, the
 * model-facing denial/hint markers, and the ordered fail-closed sequence
 * that resolves a `sandbox_permissions` request BEFORE anything executes.
 * Texts that the model and the audit read are kept verbatim so the
 * vocabulary matches the reference.
 *
 * Two deliberate adaptations, both structural:
 *
 * - The approval channel here is a TURN/SESSION-routed closure the runtime
 *   hands the tool (it owns tool/call/turn identity), so the port drops
 *   dsh's agent-routing requirement — same trick dsh itself uses to keep
 *   this module free of its approval/agent packages.
 * - The unknown-outcome branch throws a named error instead of an
 *   exhaustive-assert helper: our unknown-fallback discipline (interface
 *   spec §4.2, enforced by guard:events — which also rejects the helper's
 *   very name in production source, comments included) treats a future
 *   outcome as an unknown value, never as an unreachable one.
 */

/** What a call whose effective mode is the key may escalate TO. */
export const WIDER_MODES: Record<ConfinementMode, readonly ConfinementMode[]> =
  {
    "read-only": ["workspace-write", "danger-full-access"],
    "workspace-write": ["danger-full-access"],
    "danger-full-access": [],
  };

/**
 * The closed escalation-target vocabulary — every mode a call could escalate
 * TO (`read-only` is the floor; nothing escalates to it). This is what the
 * tool schema advertises.
 */
export const ESCALATION_TARGETS = [
  "workspace-write",
  "danger-full-access",
] as const satisfies readonly ConfinementMode[];

/**
 * `sandbox_permissions` and `justification` travel together — an approval
 * prompt without a reason, or a reason driving nothing, is malformed — and
 * the justification must be a non-empty sentence.
 */
export function validateEscalationArgs(
  sandboxPermissions: string | undefined,
  justification: string | undefined,
): void {
  if (sandboxPermissions !== undefined && justification === undefined)
    throw new Error(
      "invalid escalation: sandbox_permissions requires a justification",
    );
  if (justification !== undefined && sandboxPermissions === undefined)
    throw new Error(
      "invalid escalation: justification is only valid together with sandbox_permissions",
    );
  if (justification !== undefined && justification.trim().length === 0)
    throw new Error("invalid justification: expected a non-empty sentence");
}

/**
 * The same advertisement as one environment-block line (the agent layer's
 * production form): the turn runner passes the effective mode, the runner
 * renders it inside the per-turn `<environment_details>` block — the
 * dynamic layer, so the cached prefix (system prompt + tool schemas) is
 * untouched and ten sessions still share one cache entry.
 */
export function confinementContextLine(mode: ConfinementMode): string {
  const targets = WIDER_MODES[mode];
  return (
    `Confinement mode: ${mode} (file effects outside it are refused by the ` +
    `OS-level wrapper` +
    `${targets.length ? `; a wider mode is available only per call via sandbox_permissions with a justification and the user's approval — targets: ${targets.join(", ")}` : "; no wider mode exists from here"})`
  );
}

/** The model-facing denial marker (verbatim dsh vocabulary). */
export function sandboxDenialMarker(mode: ConfinementMode): string {
  return `[sandbox: file access denied under ${mode} mode]`;
}

/**
 * The same-turn escalation hint that rides a denial while a wider mode still
 * exists — the nudge lives at the decision point so the sanctioned retry does
 * not depend on the model recalling the tool description.
 */
export function escalationHintMarker(subject: string): string {
  return `[sandbox: escalation available — retry this exact ${subject} once with sandbox_permissions (the narrowest wider mode that suffices) + justification; the approval prompt asks the user]`;
}

/** The closed outcome vocabulary of one escalation ask. */
export type EscalationOutcome =
  | "allowed-once"
  | "rejected"
  | "cancelled"
  | "unavailable";

/**
 * The approval channel, structurally minimal: the runtime closes over its
 * tool/call/turn identity and the interactive approval seam, so this module
 * only judges outcomes.
 */
export interface EscalationApprover {
  request(input: {
    requestedMode: ConfinementMode;
    justification: string;
  }): Promise<EscalationOutcome>;
}

export interface EscalationApproval {
  approver: EscalationApprover | undefined;
  toolName: string;
}

export interface EscalationRequest {
  requestedMode: ConfinementMode;
  justification: string;
  effectiveMode: ConfinementMode;
  /** The family's noun for the escalated action (`command` for the shell). */
  subject: string;
}

/**
 * Resolve a sandbox permission request before execution: repeating the
 * call's effective mode returns it without approval; a strictly wider mode
 * requires approval and applies only to this call; narrower or unsupported
 * targets and non-grant outcomes throw before anything executes.
 */
export async function approveEscalation(
  request: EscalationRequest,
  approval: EscalationApproval,
): Promise<ConfinementMode> {
  const {
    requestedMode: mode,
    effectiveMode,
    justification,
    subject,
  } = request;
  if (mode === effectiveMode) return effectiveMode;
  if (!WIDER_MODES[effectiveMode].includes(mode))
    throw new Error(
      `sandbox escalation to "${mode}" is not strictly wider than this call's current "${effectiveMode}" mode`,
    );
  if (approval.approver === undefined)
    throw new Error(
      `sandbox escalation to "${mode}" requires approval, but no approval channel is available`,
    );
  const outcome = await approval.approver.request({
    requestedMode: mode,
    justification,
  });
  switch (outcome) {
    case "allowed-once":
      return mode;
    case "rejected":
      throw new Error(
        `the user rejected escalating this ${subject} to "${mode}"`,
      );
    case "cancelled":
      throw new Error(`approval for escalating to "${mode}" was cancelled`);
    case "unavailable":
      throw new Error(
        `sandbox escalation to "${mode}" requires approval, but no approval channel is available`,
      );
    default:
      // guard:events discipline: a future outcome is an unknown value.
      throw new Error(`unknown escalation outcome: ${String(outcome)}`);
  }
}
