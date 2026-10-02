import { expect, test } from "bun:test";
import { configV3Schema, type ConstitutionRule } from "@anthelia/contracts";
import { buildGeneration } from "@anthelia/composition";
import { smokeFace } from "../src/runtime/verification-faces";

/**
 * The smoke face (study §4.3): an isolated runtime boots with the
 * CANDIDATE's config and answers one turn — and the health criterion
 * refuses the silent fallback, because a smoke that booted defaults has
 * smoked nothing at all.
 */

const VALID_CONFIG = configV3Schema.parse({
  version: 3,
  providers: {
    smoke: {
      name: "Smoke",
      driver: "openai-compatible",
      connection: { apiKey: "test-secret" },
    },
  },
  catalog: {
    providers: { smoke: { models: { model: { name: "model" } } } },
  },
});

function candidate(config: unknown) {
  return buildGeneration({
    config: config as typeof VALID_CONFIG,
    catalog: [],
    policyRows: [] as ConstitutionRule[],
    prompts: { perRoleStatic: {}, docs: [] },
  });
}

test("a valid candidate boots, answers a turn, and reports healthy", async () => {
  const check = await smokeFace({ timeoutMs: 30_000 })(candidate(VALID_CONFIG));
  expect(check.check).toBe("smoke");
  expect(check.ok).toBe(true);
}, 40_000);

test("a candidate whose config violates the schema is refused by name", async () => {
  // A foreign config version: loadGeneration does not deep-validate a
  // stored generation's config and the runtime swallows config errors by
  // design, so without the smoke's own strict parse this forged candidate
  // would boot on defaults and "pass" — verifying nothing. (A bogus
  // provider driver would NOT do: driver names are open strings under the
  // caps-declaration model, and resolve at use time.)
  const broken = { ...VALID_CONFIG, version: 4 };
  const check = await smokeFace({ timeoutMs: 30_000 })(candidate(broken));
  expect(check.ok).toBe(false);
  expect(check.detail).toContain("candidate config invalid");
}, 40_000);

test("an impossible readiness deadline fails instead of hanging the gate", async () => {
  const check = await smokeFace({ timeoutMs: 1 })(candidate(VALID_CONFIG));
  expect(check.ok).toBe(false);
  expect(check.detail).toContain("session.ready");
}, 10_000);
