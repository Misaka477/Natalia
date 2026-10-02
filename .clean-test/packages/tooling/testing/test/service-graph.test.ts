import { expect, test } from "bun:test";
import {
  analyzeServiceGraph,
  packageOf,
  type ScannedFile,
} from "../src/service-graph";

function file(path: string, text: string): ScannedFile {
  return { path, pkg: packageOf(path), text };
}

const TOKEN = (name: string, id: string, extra = "") =>
  `export const ${name} = defineService<object>("${id}", {\n  scope: "workspace",\n  capability: "services",${extra}\n});`;

test("packageOf classifies plugin and framework paths", () => {
  expect(packageOf("packages/plugins/team/src/team-plugin.ts")).toBe(
    "@natalia/team-plugin",
  );
  expect(packageOf("packages/framework/client/src/state.ts")).toBe(
    "@natalia/client",
  );
  expect(packageOf("apps/cli/src/main.ts")).toBe("@natalia/host");
});

test("a sound declaration set produces no problems", () => {
  // The real shape: the host binds the shared services, the plugin binds its
  // own and consumes the host's.
  const report = analyzeServiceGraph([
    file(
      "packages/core/runtime-services/src/service-tokens.ts",
      `${TOKEN("alphaService", "alpha.service")}\n${TOKEN("betaService", "beta.service")}\n${TOKEN("gammaService", "gamma.service")}`,
    ),
    file(
      "packages/framework/client/src/runtime/initialize/framework-services.ts",
      `import { alphaService, betaService } from "@anthelia/runtime-services";\nctx.state.serviceDirectory.provide(alphaService, {});\nctx.state.serviceDirectory.provide(betaService, {});`,
    ),
    file(
      "packages/plugins/team/src/team-plugin.ts",
      `import { alphaService, betaService, gammaService } from "@anthelia/runtime-services";\nexport const manifest = {\n  provides: [gammaService.id],\n  requires: [alphaService.id, betaService.id],\n};\nexport function setup(api) {\n  api.services.provide(gammaService.id, {});\n  const a = api.services.get<object>(alphaService.id);\n}`,
    ),
  ]);
  expect(report.problems).toEqual([]);
  expect(report.tokens.map((t) => t.id).sort()).toEqual([
    "alpha.service",
    "beta.service",
    "gamma.service",
  ]);
});

test("duplicate ids fail with both sites named", () => {
  const report = analyzeServiceGraph([
    file(
      "packages/framework/retry/src/service-token.ts",
      TOKEN("retryService", "retry.service"),
    ),
    file(
      "packages/framework/compaction/src/service-token.ts",
      TOKEN("retryService", "retry.service"),
    ),
  ]);
  expect(
    report.problems.some((p) =>
      p.startsWith('duplicate service id "retry.service"'),
    ),
  ).toBe(true);
});

test("a required service without a provider fails", () => {
  const report = analyzeServiceGraph([
    file(
      "packages/plugins/team/src/team-plugin.ts",
      `export const manifest = { provides: [], requires: ["ghost.service"] };`,
    ),
  ]);
  expect(
    report.problems.some((p) =>
      p.includes(
        'service "ghost.service" is required by @natalia/team-plugin but no package provides it',
      ),
    ),
  ).toBe(true);
});

test("a service provided by two packages fails with Chord's wording", () => {
  const report = analyzeServiceGraph([
    file(
      "packages/core/runtime-services/src/service-tokens.ts",
      TOKEN("sandboxService", "sandbox.service"),
    ),
    file(
      "packages/framework/client/src/runtime/initialize/framework-services.ts",
      `import { sandboxService } from "@anthelia/runtime-services";\nctx.state.serviceDirectory.provide(sandboxService, {});`,
    ),
    file(
      "packages/plugins/team/src/team-plugin.ts",
      `import { sandboxService } from "@anthelia/runtime-services";\nexport const manifest = { provides: [sandboxService.id], requires: [] };`,
    ),
  ]);
  expect(
    report.problems.some((p) =>
      p.includes('service "sandbox.service" is provided by both'),
    ),
  ).toBe(true);
});

test("two plugins requiring each other's services are a cycle", () => {
  const report = analyzeServiceGraph([
    file(
      "packages/core/runtime-services/src/service-tokens.ts",
      `${TOKEN("leftService", "left.service")}\n${TOKEN("rightService", "right.service")}`,
    ),
    file(
      "packages/plugins/team/src/team-plugin.ts",
      `import { leftService, rightService } from "@anthelia/runtime-services";\nexport const manifest = { provides: [leftService.id], requires: [rightService.id] };`,
    ),
    file(
      "packages/plugins/skills/src/skills-plugin.ts",
      `import { leftService, rightService } from "@anthelia/runtime-services";\nexport const manifest = { provides: [rightService.id], requires: [leftService.id] };`,
    ),
  ]);
  expect(report.problems.some((p) => p.startsWith("dependency cycle:"))).toBe(
    true,
  );
});

test("a declared token nobody provides is an orphan stub", () => {
  const report = analyzeServiceGraph([
    file(
      "packages/framework/retry/src/service-token.ts",
      TOKEN("retryService", "retry.service"),
    ),
  ]);
  expect(
    report.problems.some((p) =>
      p.includes(
        'token "retry.service" is declared in packages/framework/retry/src/service-token.ts but never provided',
      ),
    ),
  ).toBe(true);
});

test("invalid scope and missing capability fail validation", () => {
  const report = analyzeServiceGraph([
    file(
      "packages/framework/retry/src/service-token.ts",
      `export const retryService = defineService<object>("retry.service", {\n  scope: "galaxy",\n});`,
    ),
  ]);
  expect(
    report.problems.some((p) => p.includes('declares invalid scope "galaxy"')),
  ).toBe(true);
  expect(
    report.problems.some((p) => p.includes("declares no capability")),
  ).toBe(true);
});
