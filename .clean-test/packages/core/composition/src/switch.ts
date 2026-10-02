import type {
  ConfigV3,
  ConstitutionRule,
  Generation,
  RuntimeEvent,
} from "@anthelia/contracts";
import {
  runVerificationGate,
  type VerificationFace,
  type VerificationVerdict,
} from "./verification";

/**
 * The switch orchestration (NGM study §4.3): stage -> verify -> approve ->
 * epoch switch -> health check, with automatic rollback and incident
 * evidence on failure. Three hard rules from the study are structural:
 *
 * 1. **Deferred by default** ("cache-aware", after hermes): a switch is
 *    applied to the durable config source but taken live only at the next
 *    session/epoch boundary — the next boot's reload producer journals the
 *    switch it actually performs. `"now"` is the explicit opt-in that
 *    reloads the live runtime immediately.
 * 2. Monotonic guards are not weakened by candidates — the gate's
 *    constitution face owns that check.
 * 3. L3 boundary: generations never contain core source (out of scope
 *    here; the content shape enforces it).
 *
 * Every side effect crosses a seam, so the flow is testable end to end
 * without booting anything, and the client wires the real implementations
 * (config file write, live reload, runtime health, approval channel).
 */

export type ApprovalOutcome = "granted" | "refused";

/** Rule 1: the boundary timing of a switch. */
export type SwitchWhen = "next-session" | "now";

export type SwitchStage =
  | "gate-failed"
  | "approval-refused"
  | "apply-failed"
  | "rolled-back"
  | "applied"
  | "deferred";

export type SwitchResult = {
  switched: boolean;
  stage: SwitchStage;
  verdict: VerificationVerdict;
  detail?: string;
};

export interface SwitchGenerationInput {
  /** The active profile at switch time: its §6.6 hash rides the event. */
  profile?: import("./profile").CompositionProfile;
  candidateID: string;
  candidate: Generation;
  activeRules: readonly ConstitutionRule[];
  faces: {
    guards: VerificationFace;
    smoke: VerificationFace;
    nia: VerificationFace;
  };
  /** Why the switch is being attempted (journal reason). */
  reason: string;
  /** Default "next-session": rule 1's deferred boundary. */
  when?: SwitchWhen;
  /** The running generation this switch would leave — the rollback handle. */
  currentGenerationID?: string;
  /** The config currently in force — what a rollback restores verbatim. */
  currentConfig: ConfigV3;
  /**
   * The approval channel (composition changes default to human
   * confirmation; production wires the interactive approval seam).
   */
  requestApproval(input: {
    reason: string;
    candidateID: string;
  }): Promise<ApprovalOutcome>;
  /** Durably apply the config source (production: write the config file). */
  applyConfig(config: ConfigV3): Promise<void>;
  /** Take the applied config live — required for `when: "now"`. */
  reloadRuntime?: () => Promise<void>;
  /** Post-switch health of the live runtime — required for `when: "now"`. */
  healthCheck?: () => Promise<{ ok: boolean; detail?: string }>;
  publish(event: RuntimeEvent): void;
}

function incident(message: string): RuntimeEvent {
  return { type: "diagnostic", level: "error", message };
}

/**
 * Runs the full gated switch. Nothing switches unless every face passed AND
 * the channel granted; a failed health check after a live switch restores
 * the current config verbatim and records both the rollback switch and the
 * incident.
 */
export async function switchGeneration(
  input: SwitchGenerationInput,
): Promise<SwitchResult> {
  const when = input.when ?? "next-session";
  const verdict = await runVerificationGate({
    candidateID: input.candidateID,
    candidate: input.candidate,
    activeRules: input.activeRules,
    faces: input.faces,
    publish: input.publish,
  });
  if (verdict.verdict !== "passed")
    return { switched: false, stage: "gate-failed", verdict };

  const approval = await input.requestApproval({
    reason: input.reason,
    candidateID: input.candidateID,
  });
  if (approval !== "granted")
    return {
      switched: false,
      stage: "approval-refused",
      verdict,
      detail: "the user refused the generation switch",
    };

  try {
    await input.applyConfig(input.candidate.config);
  } catch (error) {
    return {
      switched: false,
      stage: "apply-failed",
      verdict,
      detail: error instanceof Error ? error.message : String(error),
    };
  }

  if (when === "next-session") {
    // Durable source updated; the live runtime keeps running the current
    // generation and the NEXT boot's reload producer journals the switch it
    // actually performs (G2's stage/commit flow) — journaling here would
    // claim a switch that has not happened yet.
    return { switched: false, stage: "deferred", verdict };
  }

  if (!input.reloadRuntime || !input.healthCheck)
    throw new Error(
      'when: "now" requires reloadRuntime and healthCheck seams — an immediate switch without a health check would have no path back',
    );

  await input.reloadRuntime();
  input.publish({
    type: "composition.switched",
    ...(input.currentGenerationID ? { from: input.currentGenerationID } : {}),
    ...(input.profile ? { compositionHash: input.profile.hash } : {}),
    to: input.candidateID,
    reason: input.reason,
  });

  const health = await input.healthCheck();
  if (health.ok) return { switched: true, stage: "applied", verdict };

  // Auto-rollback: restore the config verbatim, take it live, and record
  // both the reversal and the incident (study: "自动回退 previous +
  // incident evidence").
  await input.applyConfig(input.currentConfig);
  await input.reloadRuntime();
  if (input.currentGenerationID)
    input.publish({
      type: "composition.switched",
      from: input.candidateID,
      to: input.currentGenerationID,
      ...(input.profile ? { compositionHash: input.profile.hash } : {}),
      reason: "health-check-failed: automatic rollback",
    });
  input.publish(
    incident(
      `generation switch failed its post-switch health check${health.detail ? `: ${health.detail}` : ""} — rolled back to the previous composition (candidate ${input.candidateID})`,
    ),
  );
  return {
    switched: false,
    stage: "rolled-back",
    verdict,
    detail: health.detail,
  };
}
