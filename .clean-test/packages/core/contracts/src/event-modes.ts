import type { RuntimeEvent } from "./events";

/**
 * Event modes (interface spec §4.6, decision 6).
 *
 * An event's mode declares how its consumers treat failure, and the same
 * declaration serves the mode system and the log discipline ("同一份声明可被
 * 模式系统与日志系统核对"):
 *
 * - `emit` — observation only: a consumer's failure never propagates into the
 *   flow that published the event.
 * - `waterfall` — every registered consumer runs; one consumer's failure is
 *   isolated and does not stop the chain.
 * - `bail` — the event carries an obligation: a consumer's failure stops the
 *   flow and surfaces (fail-fast, never silently dropped).
 *
 * The table is keyed by event *family* (the first dotted segment, or the whole
 * type for unnamespaced ones), so a new family in the union fails compilation
 * until its mode is declared — that is the mechanical cross-check: the mode
 * decision happens when the event is created, not after.
 *
 * Honesty note on the current values: every family is `emit` because that is
 * what the runtime does today — events are appended to the journal and
 * fan out to observers without any consumer able to stop the publisher. The
 * deviation slots (`bail` for the obligation-carrying families, `waterfall`
 * where several consumers must all see an event) are flipped by the
 * generation machine, whose verification pipe is the first consumer with real
 * bail semantics. Flipping a row before that consumer exists would be a
 * declaration without a meaning.
 */

export type EventMode = "bail" | "waterfall" | "emit";

/** The family of an event type: everything before the first dot. */
export type EventFamilyOf<T extends string> =
  T extends `${infer Family}.${string}` ? Family : T;

export type EventFamilies = EventFamilyOf<RuntimeEvent["type"]>;

/**
 * Every family in the event union, exactly once: the mapped type is the
 * cross-check — a missing or unknown family is a compile error.
 */
export type EventModeTable = { readonly [Family in EventFamilies]: EventMode };

export const EVENT_MODES: EventModeTable = {
  agent: "emit",
  approval: "emit",
  // Sandbox study §6b①: an escalation grant is an audit fact — emit, never
  // flow-stopping; the danger indicator and the audit trail read the same
  // event.
  confinement: "emit",
  audit: "emit",
  capability: "emit",
  checkpoint: "emit",
  composition: "emit",
  // Discovery D2: findings are observation — emit, never flow-stopping.
  invariant: "emit",
  // D4: a background review is observation — emit, never flow-stopping.
  self_review: "emit",
  // The settlement spine's notices are observation — emit, never
  // flow-stopping: a notice is an input the model reads when it chooses,
  // and a failed delivery degrades without touching the thing that
  // settled.
  settlement: "emit",
  // G-c: an external run's join is a recorded fact — emit, and the
  // comparison it unlocks is a read, not a flow gate.
  external_run: "emit",
  // G-a's growth.proposed and block ②'s growth.promoted share this key:
  // both are recorded facts that apply nothing — emit, never
  // flow-stopping (the approval policy gates what becomes real).
  growth: "emit",
  // D6a: feedback is observation — emit, never flow-stopping.
  feedback: "emit",
  collab: "emit",
  compaction: "emit",
  completion: "emit",
  constitution: "emit",
  content: "emit",
  context: "emit",
  decision: "emit",
  detour: "emit",
  diagnostic: "emit",
  dialog: "emit",
  drift: "emit",
  evidence: "emit",
  goal: "emit",
  input: "emit",
  interactive: "emit",
  mailbox: "emit",
  mcp: "emit",
  model: "emit",
  navi: "emit",
  nia: "emit",
  chat: "emit",
  natalia: "emit",
  plan: "emit",
  plugin: "emit",
  policy: "emit",
  projections: "emit",
  question: "emit",
  resource: "emit",
  rollback: "emit",
  runtime: "emit",
  sandbox: "emit",
  session: "emit",
  settings: "emit",
  snapshot: "emit",
  status: "emit",
  step: "emit",
  subagent: "emit",
  terminal: "emit",
  thinking: "emit",
  tool: "emit",
  turn: "emit",
  work_contract: "emit",
  workgraph: "emit",
  workspace: "emit",
};

/** The declared mode of an event type. */
export function eventMode(type: RuntimeEvent["type"]): EventMode {
  const family = type.split(".")[0] as EventFamilies;
  return EVENT_MODES[family];
}
