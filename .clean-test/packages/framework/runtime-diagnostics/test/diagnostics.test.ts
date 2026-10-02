import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  createRuntimeDiagnostics,
  type DiagnosticsReporter,
  type Invariant,
  type InvariantCheckInput,
} from "../src/index";

/**
 * An in-memory reporter double: the layer's DiagnosticsReporter is a
 * two-method seam by design (decoupling from the log package keeps the
 * composite graph acyclic), so the test doubles THAT — and asserting on
 * lines is stricter than asserting on files.
 */
function reporter(): { log: DiagnosticsReporter; lines: string[] } {
  const lines: string[] = [];
  return {
    lines,
    log: {
      component: (name) => ({
        error: (message, fields) =>
          lines.push(
            JSON.stringify({
              component: name,
              level: "error",
              message,
              fields,
            }),
          ),
        info: (message, fields) =>
          lines.push(
            JSON.stringify({ component: name, level: "info", message, fields }),
          ),
      }),
    },
  };
}

const always: Invariant = {
  id: "test.always",
  statement: "trips every time",
  check: () => [{ code: "test.trip", detail: "tripped" }],
};

const crasher: Invariant = {
  id: "test.crasher",
  statement: "throws instead of checking",
  check: () => {
    throw new Error("checker blew up");
  },
};

const input: InvariantCheckInput = {
  sessions: [
    {
      sessionID: "ses_a",
      events: [] as RuntimeEvent[],
      factStateComplete: true,
    },
  ],
};

test("a violating invariant becomes an attributed finding in the report", () => {
  const out = reporter();
  const diagnostics = createRuntimeDiagnostics({
    sets: [{ owner: "test-domain", invariants: [always] }],
    log: out.log,
  });
  const findings = diagnostics.tick(input);
  expect(findings).toHaveLength(1);
  expect(findings[0]).toMatchObject({
    owner: "test-domain",
    invariant: "test.always",
    code: "test.trip",
  });
  expect(diagnostics.state()).toMatchObject({ ticks: 1, findings: 1 });
  expect(diagnostics.state().byInvariant["test-domain"]).toEqual({
    "test.always": 1,
  });
  const line = out.lines.find((entry) => entry.includes("test.trip"));
  expect(line).toBeDefined();
  expect(line).toContain('"component":"invariants"');
  expect(line).toContain('"owner":"test-domain"');
});

test("the global switch silences checks without undeploying them", () => {
  const out = reporter();
  const diagnostics = createRuntimeDiagnostics({
    sets: [{ owner: "test-domain", invariants: [always] }],
    log: out.log,
  });
  diagnostics.setEnabled(false);
  expect(diagnostics.tick(input)).toHaveLength(0);
  expect(diagnostics.state().enabled).toBe(false);
  diagnostics.setEnabled(true);
  expect(diagnostics.tick(input)).toHaveLength(1);
});

test("owner filtering: block wins, allow narrows", () => {
  const out = reporter();
  const diagnostics = createRuntimeDiagnostics({
    sets: [
      { owner: "kept", invariants: [always] },
      { owner: "blocked", invariants: [always] },
    ],
    log: out.log,
  });
  diagnostics.setOwnerFilter({
    allow: ["kept", "blocked"],
    block: ["blocked"],
  });
  expect(diagnostics.tick(input).map((finding) => finding.owner)).toEqual([
    "kept",
  ]);
  diagnostics.setOwnerFilter({ allow: ["blocked"] });
  expect(diagnostics.tick(input).map((finding) => finding.owner)).toEqual([
    "blocked",
  ]);
});

test("a crashing checker is recorded as a finding, never as a crash", () => {
  const out = reporter();
  const diagnostics = createRuntimeDiagnostics({
    sets: [{ owner: "test-domain", invariants: [crasher] }],
    log: out.log,
  });
  const findings = diagnostics.tick(input);
  expect(findings).toHaveLength(1);
  expect(findings[0]!.code).toBe("test.crasher.checker_crashed");
  expect(findings[0]!.detail).toContain("checker blew up");
});

test("the interval runner ticks and stops", async () => {
  const out = reporter();
  const diagnostics = createRuntimeDiagnostics({
    sets: [{ owner: "test-domain", invariants: [always] }],
    log: out.log,
  });
  diagnostics.start(10, () => input);
  await new Promise((resolve) => setTimeout(resolve, 60));
  diagnostics.stop();
  const ticks = diagnostics.state().ticks;
  expect(ticks).toBeGreaterThan(0);
  await new Promise((resolve) => setTimeout(resolve, 40));
  expect(diagnostics.state().ticks).toBe(ticks); // stopped for real
});

test("the journal seam is edge-triggered: open once, resolve, re-open", async () => {
  // A controllable violation: the test decides when the problem stops.
  let offending = true;
  const controlled: Invariant = {
    id: "test.edge",
    statement: "controlled by the test",
    check: () =>
      offending
        ? [
            {
              code: "test.edge_tripped",
              detail: "still broken",
              sessionID: "ses_edge",
            },
          ]
        : [],
  };
  const published: RuntimeEvent[] = [];
  const out = reporter();
  const diagnostics = createRuntimeDiagnostics({
    sets: [{ owner: "test-domain", invariants: [controlled] }],
    log: out.log,
    publish: (event) => published.push(event),
  });

  // Ticks 1-3: the same violation — ONE opening event (no per-tick flood).
  diagnostics.tick(input);
  diagnostics.tick(input);
  diagnostics.tick(input);
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    type: "invariant.violation",
    owner: "test-domain",
    invariant: "test.edge",
    code: "test.edge_tripped",
    sessionID: "ses_edge",
  });

  // The problem clears: the closing edge publishes exactly once.
  offending = false;
  diagnostics.tick(input);
  diagnostics.tick(input);
  expect(published).toHaveLength(2);
  expect(published[1]).toMatchObject({
    type: "invariant.resolved",
    code: "test.edge_tripped",
    sessionID: "ses_edge",
  });

  // It comes back: a NEW opening (the lifecycle restarts).
  offending = true;
  diagnostics.tick(input);
  expect(published).toHaveLength(3);
  expect(published[2]).toMatchObject({ type: "invariant.violation" });
});

test("the tick budget is measured over every check (Discovery's unverified item)", async () => {
  // The interval tick rides the runtime's clock, so its cost is the budget
  // it must stay inside. The state now carries the measured numbers: the
  // last tick's wall-clock cost and the worst seen — a number, not an
  // assumption.
  const { log } = reporter();
  // A realistic load: 40 invariants over 40 sessions' windows — the tick
  // is a fold over the input, so the budget scales with both.
  const invariants: Invariant[] = Array.from({ length: 40 }, (_, index) => ({
    id: `test.load${index}`,
    statement: "a quiet check",
    check: (input) =>
      input.sessions.slice(0, 4).map((session) => ({
        code: "test.trip",
        detail: `tripped for ${session.sessionID}`,
      })),
  }));
  const diagnostics = createRuntimeDiagnostics({
    log,
    sets: [{ owner: "test", invariants }],
  });
  const heavy: InvariantCheckInput = {
    sessions: Array.from({ length: 40 }, (_, index) => ({
      sessionID: `ses_${index}`,
      events: Array.from({ length: 200 }, (_, event) => ({
        type: "agent.selection",
        id: `e${event}`,
        name: "main",
      })) as unknown as RuntimeEvent[],
      factStateComplete: true,
    })),
  };
  const startedAt = performance.now();
  diagnostics.tick(heavy);
  const wall = performance.now() - startedAt;
  const state = diagnostics.state();
  expect(state.ticks).toBe(1);
  expect(state.lastTickMs).toBeGreaterThan(0);
  expect(state.lastTickMs!).toBeLessThanOrEqual(wall + 1);
  // The budget: 40 invariants × 4 sessions × 40 windows of folded checks
  // stay well under a tick interval — measured here so the study's
  // unverified item is a number.
  expect(state.lastTickMs!).toBeLessThan(500);
  // The worst-so-far survives a cheaper second tick.
  diagnostics.tick({ sessions: [] });
  expect(diagnostics.state().maxTickMs).toBe(state.maxTickMs);
  expect(diagnostics.state().lastTickMs!).toBeLessThan(state.maxTickMs! + 1);
});
