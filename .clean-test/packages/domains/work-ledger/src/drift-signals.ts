/**
 * Drift behaviour-signal derivation — work-ledger/drift-signals.ts (EI Phase 2,
 * 机制 2). Turns the session's recent event journal into the two L4 behaviour
 * signals the evaluator's no-progress and failure-loop rules consume:
 *
 * - `recentActions`: an ordered list of action kinds (tool_call / workspace_change
 *   / evidence.recorded / plan_step / completion.recorded). Counts only.
 * - `recentFailures`: failed tool calls as (toolName + a secret-safe normalized
 *   key). The key is a hash of the argument text, never the raw arguments — the
 *   evaluator only compares keys and reports the tool name + count.
 *
 * Pure: it reads event metadata (type, name, status, argumentsDelta) and never
 * content, diffs, results or reasoning.
 */
import type { RuntimeEvent } from "@anthelia/contracts";
import type { DriftActionKind } from "./drift-evaluator";

/** How many recent events to scan for behaviour signals. */
export const DRIFT_SIGNAL_WINDOW = 40;

/** A pure FNV-1a hash of a string, as a short base36 key (no node crypto dep). */
function hashKey(text: string): string {
  let hash = 2166136261;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    hash = Math.imul(hash, 16777619);
  }
  return (hash >>> 0).toString(36);
}

export type DriftBehaviorSignals = {
  recentActions: Array<{ kind: DriftActionKind }>;
  recentFailures: Array<{ toolName: string; key: string }>;
};

/**
 * Derive the behaviour signals from a session's recent events. `tool.update`
 * events with status "failed" become failure-loop entries; progress-marker
 * events (evidence / completion / plan step) and tool calls become actions.
 */
export function deriveDriftBehaviorSignals(
  events: readonly RuntimeEvent[],
  options?: { window?: number },
): DriftBehaviorSignals {
  const window = options?.window ?? DRIFT_SIGNAL_WINDOW;
  const tail = events.slice(-window);
  const recentActions: Array<{ kind: DriftActionKind }> = [];
  const recentFailures: Array<{ toolName: string; key: string }> = [];
  for (const event of tail) {
    switch (event.type) {
      case "evidence.recorded":
        recentActions.push({ kind: "evidence.recorded" });
        break;
      case "completion.recorded":
        recentActions.push({ kind: "completion.recorded" });
        break;
      case "plan.doc.updated":
        recentActions.push({ kind: "plan_step" });
        break;
      case "tool.update": {
        recentActions.push({ kind: "tool_call" });
        if (event.status === "failed") {
          recentFailures.push({
            toolName: event.name,
            key: hashKey(event.argumentsDelta ?? ""),
          });
        }
        break;
      }
      default:
        break;
    }
  }
  return { recentActions, recentFailures };
}
