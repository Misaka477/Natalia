import { expect, test } from "bun:test";
import type {
  ConfigV3,
  ConstitutionRule,
  RuntimeEvent,
} from "@anthelia/contracts";
import {
  GUARD_SCRIPTS,
  buildGeneration,
  capsCheck,
  constitutionCheck,
  guardsFace,
  runVerificationGate,
} from "../src/index";

/**
 * The verification gate (study §4.3): every face all-must-pass, one journal
 * record of what was checked. Each test breaks exactly one face so the
 * verdict's honesty is observable, not assumed.
 */

const FORBIDDEN: ConstitutionRule = {
  id: "C-REL-001",
  statement: "git 写操作强制审批",
  scope: "release",
  priority: "critical",
  source: "policy",
  enforcement: "deny",
  overridePolicy: "forbidden",
  evidenceRefs: [],
};

const SCOPED: ConstitutionRule = {
  id: "C-REL-099",
  statement: "提案需带证据",
  scope: "task",
  priority: "medium",
  source: "user",
  enforcement: "warn",
  overridePolicy: "user_scoped",
  evidenceRefs: [],
};

const CONFIG = { version: 3 } as unknown as ConfigV3;

function candidate(policyRows: ConstitutionRule[]) {
  return buildGeneration({
    config: CONFIG,
    catalog: [],
    policyRows,
    prompts: { perRoleStatic: {}, docs: [] },
  });
}

const passingFaces = {
  guards: () => ({ check: "guards", ok: true }),
  smoke: () => ({ check: "smoke", ok: true }),
  nia: () => ({ check: "nia", ok: true }),
};

function publishLog() {
  const events: RuntimeEvent[] = [];
  return { events, publish: (event: RuntimeEvent) => events.push(event) };
}

test("a candidate carrying the active rules passes every face", async () => {
  const { events, publish } = publishLog();
  const verdict = await runVerificationGate({
    candidateID: "gen-candidate",
    candidate: candidate([FORBIDDEN, SCOPED]),
    activeRules: [FORBIDDEN, SCOPED],
    faces: passingFaces,
    publish,
  });
  expect(verdict.verdict).toBe("passed");
  expect(verdict.checks.map((check) => check.check)).toEqual([
    "constitution",
    "guards",
    "smoke",
    "nia",
  ]);
  expect(events).toMatchObject([
    {
      type: "composition.verified",
      candidateID: "gen-candidate",
      verdict: "passed",
    },
  ]);
});

test("dropping a forbidden rule fails the constitution face by name", () => {
  const check = constitutionCheck(candidate([SCOPED]), [FORBIDDEN, SCOPED]);
  expect(check.ok).toBe(false);
  expect(check.detail).toContain("C-REL-001");
  expect(check.detail).toContain("dropped");
});

test("weakening a forbidden rule's enforcement fails", () => {
  const weakened: ConstitutionRule = {
    ...FORBIDDEN,
    enforcement: "approval",
  };
  const check = constitutionCheck(candidate([weakened]), [FORBIDDEN]);
  expect(check.ok).toBe(false);
  expect(check.detail).toContain("deny -> approval");
});

test("rewording a forbidden statement fails; scoped medium rules are free", () => {
  const reworded: ConstitutionRule = { ...FORBIDDEN, statement: "…" };
  const check = constitutionCheck(
    candidate([reworded, { ...SCOPED, statement: "changed" }]),
    [FORBIDDEN, SCOPED],
  );
  expect(check.ok).toBe(false);
  expect(check.detail).toContain("C-REL-001: statement changed");
  // SCOPED is medium + user_scoped: the gate is not a policy straitjacket,
  // it is the non-rollback rule for what the user marked untouchable.
  expect(check.detail).not.toContain("C-REL-099");
});

test("one failing face fails the verdict and the journal says which", async () => {
  const { events, publish } = publishLog();
  const verdict = await runVerificationGate({
    candidateID: "gen-bad",
    candidate: candidate([FORBIDDEN]),
    activeRules: [FORBIDDEN],
    faces: {
      ...passingFaces,
      smoke: () => ({
        check: "smoke",
        ok: false,
        detail: "runtime failed to boot",
      }),
    },
    publish,
  });
  expect(verdict.verdict).toBe("failed");
  const recorded = events.find(
    (event) => event.type === "composition.verified",
  );
  expect(recorded).toMatchObject({ verdict: "failed" });
  expect(
    (recorded as Extract<RuntimeEvent, { type: "composition.verified" }>)
      .checks,
  ).toContainEqual({
    check: "smoke",
    ok: false,
    detail: "runtime failed to boot",
  });
});

test("a face that throws is a failed gate, not a crashed gate", async () => {
  const verdict = await runVerificationGate({
    candidateID: "gen-throw",
    candidate: candidate([]),
    activeRules: [],
    faces: {
      ...passingFaces,
      nia: () => {
        throw new Error("audit provider unavailable");
      },
    },
  });
  // Promise.all rejects on a throwing face — the gate must translate that
  // into a failed verdict so the switch decision always has a verdict.
  expect(verdict.verdict).toBe("failed");
});

test("the guards face reports the failing guard by script name", async () => {
  const face = guardsFace({
    repoRoot: "/repo",
    run: (script) => ({
      status: script === "guard:deps" ? 1 : 0,
      output: script === "guard:deps" ? "service graph: cycle" : "ok",
    }),
  });
  const check = await face(candidate([]));
  expect(check.check).toBe("guards");
  expect(check.ok).toBe(false);
  expect(check.detail).toContain("guard:deps");
  expect(check.detail).toContain("service graph: cycle");
});

test("the guards face runs exactly the verify chain's guards", async () => {
  const ran: string[] = [];
  const face = guardsFace({
    repoRoot: "/repo",
    run: (script) => {
      ran.push(script);
      return { status: 0, output: "" };
    },
  });
  await face(candidate([]));
  expect(ran).toEqual([...GUARD_SCRIPTS]);
});

test("buildGeneration sorts policy rows, so order never changes the id", () => {
  const a = buildGeneration({
    config: CONFIG,
    catalog: [],
    policyRows: [FORBIDDEN, SCOPED],
    prompts: { perRoleStatic: {}, docs: [] },
  });
  const b = buildGeneration({
    config: CONFIG,
    catalog: [],
    policyRows: [SCOPED, FORBIDDEN],
    prompts: { perRoleStatic: {}, docs: [] },
  });
  expect(JSON.stringify(a)).toBe(JSON.stringify(b));
});

test("G6's caps face: a candidate's declared capability must be registered", () => {
  // The gate's second pair of eyes: a candidate reaches it from the
  // JOURNAL (a stored generation), not from a fresh compose, so its caps
  // are re-checked against the row's registered vocabulary.
  const clean = capsCheck({
    adapters: {
      "anthelia.objectstore": { impl: "rust", caps: { packRead: true } },
    },
  } as never);
  expect(clean).toEqual({ check: "caps", ok: true });

  const lying = capsCheck({
    adapters: {
      "anthelia.objectstore": { impl: "rust", caps: { mindReading: true } },
    },
  } as never);
  expect(lying.ok).toBe(false);
  expect(lying.detail).toContain("mindReading");

  // A row that declares no capabilities is fine, and so is no caps at all.
  expect(capsCheck({ adapters: { "anthelia.sandbox": {} } } as never).ok).toBe(
    true,
  );
  expect(capsCheck({ adapters: {} } as never).ok).toBe(true);
});
