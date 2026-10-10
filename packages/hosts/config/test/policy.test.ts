import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { modelSelectionStatus, evaluatePolicy } from "../src/policy";
import { replaceProjectConfig, resolveConfig } from "../src/service";
import { configV3Schema } from "@anthelia/contracts";

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

test("replaceProjectConfig removes the keys a full config does not mention", async () => {
  // A generation apply/rollback holds the WHOLE composition, so its write
  // must replace: `updateConfigAtScope` merges, and a field the new config
  // does not mention keeps the value already on disk. Rolling back to a
  // generation that never set `checkpoint.maxFiles` therefore left the
  // candidate's 12345 in place — the rollback restored nothing.
  const root = await mkdtemp(join(tmpdir(), "natalia-config-replace-"));
  const globalPath = join(root, "global.json");
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, checkpoint: { maxFiles: 12345 } }),
  );
  const before = await resolveConfig({ workspaceRoot: root, globalPath });
  expect(before.config.checkpoint.maxFiles).toBe(12345);

  await replaceProjectConfig(root, configV3Schema.parse({ version: 3 }), {
    globalPath,
  });
  const after = await resolveConfig({ workspaceRoot: root, globalPath });
  // The key is gone, not inherited: the opt-in ceiling reverts to unbounded
  // (T5-2) because the target configuration does not set it.
  expect(after.config.checkpoint.maxFiles).toBeUndefined();
  // And a value the new config DOES set still lands.
  await replaceProjectConfig(
    root,
    configV3Schema.parse({ version: 3, checkpoint: { maxFiles: 42 } }),
    { globalPath },
  );
  const set = await resolveConfig({ workspaceRoot: root, globalPath });
  expect(set.config.checkpoint.maxFiles).toBe(42);
});
