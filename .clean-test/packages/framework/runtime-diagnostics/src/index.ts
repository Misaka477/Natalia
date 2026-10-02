import type {
  Invariant,
  SessionID,
  InvariantCheckInput,
  RuntimeEvent,
  Violation,
} from "@anthelia/contracts";

/**
 * The domain-invariant layer (Discovery study D1, the deficiency study's
 * own "first" — highest leverage, no behavior change: every domain
 * declares its data relations and the runtime checks them live instead of
 * at CI time).
 *
 * The dsh invariants pattern (comparative study §4.2) on our strongest
 * carrier: the journal is the single source of truth, so an invariant is
 * a predicate over folded events — replays, unit-tests, and every finding
 * can point at the events it derives from (design law 4: a finding that
 * cannot cite events is a guess, not a finding).
 *
 * Declarations live IN the domain packages (owner declares, owner is
 * blamed); this layer only collects, ticks, attributes, reports — and the
 * report goes to the operation log (the telemetry zone), because a
 * violation is a finding about now, not a durable fact (the journal
 * event-channel is Discovery D2's work).
 */

// The shared vocabulary lives in contracts (kernel): a domain declares its
// invariants against the event union WITHOUT depending on the layer that
// ticks them — the composite graph has no reason to close a cycle through
// runtime-services.
export type {
  Invariant,
  InvariantCheckInput,
  InvariantSessionWindow,
  Violation,
} from "@anthelia/contracts";

export type InvariantSet = {
  /** The declaring domain package — violations attribute here. */
  owner: string;
  invariants: readonly Invariant[];
};

export type InvariantFinding = {
  at: string;
  owner: string;
  invariant: string;
  code: string;
  detail: string;
  sessionID?: string;
};

export type RuntimeDiagnosticsState = {
  enabled: boolean;
  ticks: number;
  findings: number;
  lastTickAt?: string;
  /**
   * The tick budget, measured (Discovery's unverified item, now verified):
   * the last tick's wall-clock cost and the worst seen. The interval tick
   * runs on the runtime's clock, so its cost is the budget it must stay
   * inside — a number, not an assumption.
   */
  lastTickMs?: number;
  maxTickMs?: number;
  /** owner -> invariant id -> finding count (attributed from the start). */
  byInvariant: Record<string, Record<string, number>>;
};

/**
 * The minimal reporting surface this layer consumes. The runtime's
 * OperationLog satisfies it structurally — deliberately NOT imported:
 * depending on the log package would close a composite reference cycle
 * (operation-log -> runtime-services -> … -> this package), and a
 * two-method consumer interface is the decoupling seam, not a copy.
 */
export type DiagnosticsReporter = {
  component(name: string): {
    error(message: string, fields?: Record<string, unknown>): void;
    info(message: string, fields?: Record<string, unknown>): void;
  };
};

export type RuntimeDiagnosticsOptions = {
  sets: readonly InvariantSet[];
  /** Where findings are reported — the runtime's operation log. */
  log: DiagnosticsReporter;
  /** The global switch (dsh): checks off, declarations stay. */
  enabled?: boolean;
  /** Owner allow/block lists (dsh's package filter): block wins. */
  owners?: { allow?: readonly string[]; block?: readonly string[] };
  /**
   * The journal seam (Discovery D2): findings cross into the journal EDGE-
   * TRIGGERED — `invariant.violation` when one OPENS, `invariant.resolved`
   * when it clears — so a 30s tick can never flood the single source of
   * truth with the same fact.
   */
  publish?: (event: RuntimeEvent) => void;
};

export interface RuntimeDiagnostics {
  /** Run every eligible invariant once. Returns this tick's findings. */
  tick(input: InvariantCheckInput): InvariantFinding[];
  /** The global switch. */
  setEnabled(enabled: boolean): void;
  /** The dsh package filter: block beats allow; absent allow = all. */
  setOwnerFilter(filter: {
    allow?: readonly string[];
    block?: readonly string[];
  }): void;
  state(): RuntimeDiagnosticsState;
  /**
   * Start the interval tick. `collect` builds the input at tick time (the
   * caller owns where session windows come from); the timer is unref'd so
   * diagnostics never hold the process open. Stops any previous run.
   */
  start(intervalMs: number, collect: () => InvariantCheckInput): void;
  stop(): void;
}

export function createRuntimeDiagnostics(
  options: RuntimeDiagnosticsOptions,
): RuntimeDiagnostics {
  const log = options.log.component("invariants");
  let enabled = options.enabled ?? true;
  let allow = options.owners?.allow;
  let block = options.owners?.block ?? [];
  let timer: ReturnType<typeof setInterval> | undefined;
  const state: RuntimeDiagnosticsState = {
    enabled,
    ticks: 0,
    findings: 0,
    byInvariant: {},
  };
  /** key -> the payload that opened it: only transitions reach the journal. */
  const open = new Map<
    string,
    {
      at: string;
      owner: string;
      invariant: string;
      code: string;
      detail: string;
      sessionID?: string;
    }
  >();
  const findingKey = (finding: {
    owner: string;
    invariant: string;
    code: string;
    detail: string;
  }) =>
    `${finding.owner}|${finding.invariant}|${finding.code}|${finding.detail}`;

  function eligible(owner: string): boolean {
    if (block.includes(owner)) return false;
    if (allow && !allow.includes(owner)) return false;
    return true;
  }

  return {
    tick(input) {
      state.ticks += 1;
      state.lastTickAt = new Date().toISOString();
      const startedAt = performance.now();
      const findings: InvariantFinding[] = [];
      if (!enabled) return findings;
      const seen = new Set<string>();
      for (const set of options.sets) {
        if (!eligible(set.owner)) continue;
        for (const invariant of set.invariants) {
          let violations: Violation[];
          try {
            violations = invariant.check(input);
          } catch (error) {
            // A crashing check is itself a diagnostic failure — recorded,
            // never allowed to take the tick (or the runtime) down.
            violations = [
              {
                code: `${invariant.id}.checker_crashed`,
                detail: error instanceof Error ? error.message : String(error),
              },
            ];
          }
          for (const violation of violations) {
            const finding: InvariantFinding = {
              at: new Date().toISOString(),
              owner: set.owner,
              invariant: invariant.id,
              code: violation.code,
              detail: violation.detail,
              ...(violation.sessionID
                ? { sessionID: violation.sessionID }
                : {}),
            };
            findings.push(finding);
            const key = findingKey(finding);
            seen.add(key);
            if (!open.has(key)) {
              open.set(key, finding);
              options.publish?.({
                type: "invariant.violation",
                at: finding.at,
                owner: finding.owner,
                invariant: finding.invariant,
                code: finding.code,
                detail: finding.detail,
                ...(finding.sessionID
                  ? { sessionID: finding.sessionID as SessionID }
                  : {}),
              });
            }
            state.findings += 1;
            const owned = (state.byInvariant[set.owner] ??= {});
            owned[invariant.id] = (owned[invariant.id] ?? 0) + 1;
            log.error("invariant violated", {
              owner: set.owner,
              invariant: invariant.id,
              code: violation.code,
              detail: violation.detail,
            });
          }
        }
      }
      for (const [key, finding] of [...open]) {
        if (seen.has(key)) continue;
        open.delete(key);
        options.publish?.({
          type: "invariant.resolved",
          at: new Date().toISOString(),
          owner: finding.owner,
          invariant: finding.invariant,
          code: finding.code,
          detail: finding.detail,
          ...(finding.sessionID
            ? { sessionID: finding.sessionID as SessionID }
            : {}),
        });
      }
      // The tick budget, measured over every check including the crash
      // guard — the number the discovery study left unverified.
      const elapsed = performance.now() - startedAt;
      state.lastTickMs = Number(elapsed.toFixed(3));
      state.maxTickMs = Number(
        Math.max(state.maxTickMs ?? 0, elapsed).toFixed(3),
      );
      return findings;
    },
    setEnabled(next) {
      enabled = next;
      state.enabled = next;
      log.info("global switch", { enabled: next });
    },
    setOwnerFilter(filter) {
      allow = filter.allow;
      block = filter.block ?? [];
      log.info("owner filter", {
        allow: allow ? [...allow] : "all",
        block: [...block],
      });
    },
    state: () => ({
      ...state,
      byInvariant: structuredClone(state.byInvariant),
    }),
    start(intervalMs, collect) {
      this.stop();
      timer = setInterval(() => {
        void this.tick(collect());
      }, intervalMs);
      timer.unref?.();
    },
    stop() {
      if (timer) clearInterval(timer);
      timer = undefined;
    },
  };
}

// The SERVICE TOKEN lives in @anthelia/runtime-services (the boundary-token
// rule from P1 — and structurally required: runtime-services already
// depends on framework/session, so a token here would close a composite
// reference cycle session -> this package -> runtime-services -> session).
