import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelSelectionStatus, evaluatePolicy } from "../src/policy";
import { configV3Schema } from "@anthelia/contracts";
import { resolveConfig } from "../src/service";

test("provider policy defaults to the caller fallback", () => {
  expect(evaluatePolicy([], "provider.use", "anthropic", "allow")).toBe(
    "allow",
  );
});

test("model selection distinguishes configured, usable, policy allowed and selected", () => {
  const config = configV3Schema.parse({
    version: 3,
    providers: {
      company: {
        name: "Company",
        driver: "openai",
        connection: { apiKey: "local" },
      },
    },
    catalog: {
      providers: {
        company: {
          models: {
            "company-stable": { name: "company-stable" },
            "company-experimental-fast": { name: "company-experimental-fast" },
            "company-disabled": { name: "company-disabled" },
          },
        },
      },
    },
    modelOverrides: {
      "company/company-disabled": { enabled: false },
    },
    experimental: {
      policies: [
        { effect: "deny", action: "provider.use", resource: "company/*" },
        {
          effect: "allow",
          action: "provider.use",
          resource: "company/company-stable",
        },
      ],
    },
  });
  expect(
    modelSelectionStatus(config, {
      provider: "company",
      model: "company-stable",
    }),
  ).toMatchObject({
    configured: true,
    usable: true,
    policyAllowed: true,
    selected: true,
  });
  expect(
    modelSelectionStatus(config, {
      provider: "company",
      model: "company-experimental-fast",
    }),
  ).toMatchObject({
    usable: true,
    policyAllowed: false,
    reason: "provider_policy_denied",
  });
  expect(
    modelSelectionStatus(config, {
      provider: "company",
      model: "company-disabled",
    }),
  ).toMatchObject({
    usable: false,
    reason: "model_disabled",
  });
  // Canonical `provider/model` strings are accepted like model refs.
  expect(modelSelectionStatus(config, "company/company-stable").selected).toBe(
    true,
  );
});

test("provider policy applies the last matching wildcard rule", () => {
  const rules = [
    { effect: "deny" as const, action: "provider.use", resource: "*" },
    { effect: "allow" as const, action: "provider.use", resource: "company-*" },
    {
      effect: "deny" as const,
      action: "provider.use",
      resource: "company-experimental-*",
    },
  ];
  expect(evaluatePolicy(rules, "provider.use", "company-stable", "allow")).toBe(
    "allow",
  );
  expect(
    evaluatePolicy(rules, "provider.use", "company-experimental-fast", "allow"),
  ).toBe("deny");
  expect(evaluatePolicy(rules, "provider.use", "openai", "allow")).toBe("deny");
});

test("a rejected configuration file reports why, not just that it failed", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-config-invalid-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({
      version: 3,
      agentModes: {
        unattended: {
          approval: "not-a-mode",
        },
      },
    }),
  );
  const resolved = await resolveConfig({
    workspaceRoot: root,
    globalPath: join(root, "absent-global.json"),
  });
  const project = resolved.sources.find(
    (source) => source.scope === "project",
  )!;
  expect(project.applied).toBe(false);
  // The operator has to be able to find the offending field: an ignored file
  // silently drops the profiles and command rules they thought were in effect.
  expect(project.diagnostic).toContain("invalid_config:");
  expect(project.diagnostic).toContain("approval");
  expect(resolved.config.agentModes.unattended).toBeUndefined();
});
