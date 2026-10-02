import { expect, test } from "bun:test";
import type {
  ConfigV3,
  ConstitutionRule,
  RuntimeEvent,
} from "@anthelia/contracts";
import { configV3Schema } from "@anthelia/contracts";
import {
  buildGeneration,
  switchGeneration,
  type SwitchGenerationInput,
} from "../src/index";

/**
 * The switch orchestration (study §4.3): every side effect crosses a seam,
 * so each invariant gets a direct assertion — gate before approval, no
 * apply without a grant, deferred by default (rule 1), verbatim restore on
 * a failed health check, incident in the journal.
 */

const CONFIG_A = configV3Schema.parse({ version: 3 });
const CONFIG_B = configV3Schema.parse({
  version: 3,
  runtime: { permissions: { mode: "read_only" } },
} as never);

const RULE: ConstitutionRule = {
  id: "C-SW-001",
  statement: "切换必须过闸",
  scope: "release",
  priority: "critical",
  source: "policy",
  enforcement: "deny",
  overridePolicy: "forbidden",
  evidenceRefs: [],
};

function faces(overrides: Partial<SwitchGenerationInput["faces"]> = {}) {
  return {
    guards: () => ({ check: "guards", ok: true }),
    smoke: () => ({ check: "smoke", ok: true }),
    nia: () => ({ check: "nia", ok: true }),
    ...overrides,
  };
}

function harness(overrides: Partial<SwitchGenerationInput> = {}) {
  const events: RuntimeEvent[] = [];
  const applied: ConfigV3[] = [];
  const calls = { approval: 0, reload: 0, health: 0 };
  const input: SwitchGenerationInput = {
    candidateID: "gen-candidate",
    candidate: buildGeneration({
      config: CONFIG_B,
      catalog: [],
      policyRows: [RULE],
      prompts: { perRoleStatic: {}, docs: [] },
    }),
    activeRules: [RULE],
    faces: faces(),
    reason: "test switch",
    currentGenerationID: "gen-current",
    currentConfig: CONFIG_A,
    requestApproval: async () => {
      calls.approval += 1;
      return "granted";
    },
    applyConfig: async (config) => {
      applied.push(config);
    },
    reloadRuntime: async () => {
      calls.reload += 1;
    },
    healthCheck: async () => {
      calls.health += 1;
      return { ok: true };
    },
    publish: (event) => events.push(event),
    ...overrides,
  };
  return { input, events, applied, calls };
}

function switchedEvents(events: RuntimeEvent[]) {
  return events.filter((event) => event.type === "composition.switched");
}

test("a failed gate stops everything: no approval, no apply, no switch", async () => {
  const { input, events, applied, calls } = harness({
    faces: faces({
      smoke: () => ({ check: "smoke", ok: false, detail: "boot failed" }),
    }),
    when: "now",
  });
  const result = await switchGeneration(input);
  expect(result.stage).toBe("gate-failed");
  expect(result.switched).toBe(false);
  expect(calls.approval).toBe(0); // the gate runs BEFORE the human is asked
  expect(applied).toHaveLength(0);
  expect(switchedEvents(events)).toHaveLength(0);
  expect(
    events.find((event) => event.type === "composition.verified"),
  ).toMatchObject({ verdict: "failed" });
});

test("a refused approval applies nothing", async () => {
  const { input, events, applied, calls } = harness({
    when: "now",
    requestApproval: async () => {
      calls.approval += 1;
      return "refused";
    },
  });
  const result = await switchGeneration(input);
  expect(result.stage).toBe("approval-refused");
  expect(applied).toHaveLength(0);
  expect(switchedEvents(events)).toHaveLength(0);
  expect(
    events.find((event) => event.type === "composition.verified"),
  ).toMatchObject({ verdict: "passed" });
});

test("now: apply, live reload, switch journal, healthy done", async () => {
  const { input, events, applied, calls } = harness({ when: "now" });
  const result = await switchGeneration(input);
  expect(result.stage).toBe("applied");
  expect(result.switched).toBe(true);
  expect(applied).toEqual([CONFIG_B]);
  expect(calls.reload).toBe(1);
  expect(switchedEvents(events)).toMatchObject([
    { from: "gen-current", to: "gen-candidate" },
  ]);
});

test("a failed health check rolls back verbatim and records the incident", async () => {
  const { input, events, applied, calls } = harness({
    when: "now",
    healthCheck: async () => {
      calls.health += 1;
      return { ok: false, detail: "config reload diagnostics after switch" };
    },
  });
  const result = await switchGeneration(input);
  expect(result.stage).toBe("rolled-back");
  expect(result.switched).toBe(false);
  // Candidate first, then the PREVIOUS config object restored verbatim.
  expect(applied).toHaveLength(2);
  expect(applied[0]).toBe(CONFIG_B);
  expect(applied[1]).toBe(CONFIG_A);
  expect(calls.reload).toBe(2);
  expect(switchedEvents(events)).toMatchObject([
    { from: "gen-current", to: "gen-candidate" },
    { from: "gen-candidate", to: "gen-current" },
  ]);
  const incident = events.find((event) => event.type === "diagnostic");
  expect(incident).toMatchObject({
    level: "error",
    message: expect.stringContaining("rolled back to the previous composition"),
  });
});

test("deferred by default (rule 1): the source updates, nothing claims a switch", async () => {
  const { input, events, applied, calls } = harness();
  const result = await switchGeneration(input);
  expect(result.stage).toBe("deferred");
  expect(result.switched).toBe(false);
  expect(applied).toEqual([CONFIG_B]); // durable source updated
  expect(calls.reload).toBe(0); // live runtime untouched
  expect(switchedEvents(events)).toHaveLength(0); // the next boot's producer journals the switch it performs
});

test("an immediate switch without a health check is refused loudly", async () => {
  const { input } = harness({ when: "now", healthCheck: undefined });
  await expect(switchGeneration(input)).rejects.toThrow(
    /requires reloadRuntime and healthCheck/u,
  );
});
