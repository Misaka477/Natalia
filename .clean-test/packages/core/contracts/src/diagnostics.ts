import type { RuntimeEvent } from "./events";

/**
 * The domain-invariant vocabulary (Discovery D1): declared by the domains,
 * owned by contracts — the kernel, because an invariant is a relation over
 * JOURNAL EVENTS and the event union is the kernel's. Keeping the types
 * here also keeps declaration packages free of any dependency on the
 * layer that ticks them (the composite graph would otherwise close a
 * cycle through runtime-services).
 */

/** One session's check window: its full event list + projection health. */
export type InvariantSessionWindow = {
  sessionID: string;
  events: RuntimeEvent[];
  /** The runtime's projection flag (client exec state) — checked, not trusted. */
  factStateComplete: boolean;
};

export type InvariantCheckInput = {
  sessions: InvariantSessionWindow[];
};

export type Violation = {
  /** Machine-readable code (dsh pattern): stable, greppable, per-invariant. */
  code: string;
  detail: string;
  /**
   * The window this violation cites, when it is session-scoped — D2's
   * journal event carries it into the correlation fields; invariants
   * spanning windows leave it absent.
   */
  sessionID?: string;
};

export type Invariant = {
  /** Unique within the declaring set, e.g. "work-ledger.contract-machine". */
  id: string;
  /** One sentence the operator reads when the check trips. */
  statement: string;
  check(input: InvariantCheckInput): Violation[];
};
