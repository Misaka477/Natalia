import { expect, test } from "bun:test";
import {
  findCompositionKernelViolation,
  findPolicyHostDependencyViolation,
  findSourceTreeJsViolation,
  findSubstratePurityViolation,
  findWorkspaceManagerBoundaryViolation,
} from "../src/migrated-plugin-rules";

/**
 * The two P3 layer rules (decisions §1.1/§1.2, master plan P3 row) —
 * unit-tested here because the guard's own run only proves today's tree
 * is clean, not that the rules BITE.
 */

test("product policy never depends on the host layer — and only in shipped code", () => {
  const domainsFile = "packages/domains/work-ledger/src/controller.ts";
  expect(
    findPolicyHostDependencyViolation("@anthelia/platform", domainsFile),
  ).toContain("host layer");
  expect(
    findPolicyHostDependencyViolation(
      "@anthelia/object-store/extra",
      domainsFile,
    ),
  ).toContain("@anthelia/object-store");
  // Public engine API and siblings stay legal (§1.2: only через API/token).
  expect(
    findPolicyHostDependencyViolation("@anthelia/contracts", domainsFile),
  ).toBeUndefined();
  expect(
    findPolicyHostDependencyViolation(
      "@anthelia/runtime-services",
      domainsFile,
    ),
  ).toBeUndefined();
  expect(
    findPolicyHostDependencyViolation(
      "@anthelia/platform",
      "packages/framework/client/src/x.ts",
    ),
  ).toBeUndefined(); // scoped to domains
  expect(
    findPolicyHostDependencyViolation(
      "@anthelia/platform",
      domainsFile.replace("/src/", "/test/"),
    ),
  ).toBeUndefined(); // tests may reach anywhere
});

test("composition lives in the kernel layer — checked where it is declared", () => {
  expect(
    findCompositionKernelViolation(["packages/core/composition/src/index.ts"]),
  ).toBeUndefined();
  expect(
    findCompositionKernelViolation([
      "packages/framework/composition/src/index.ts",
    ]),
  ).toContain("kernel layer");
  expect(findCompositionKernelViolation(undefined)).toContain("missing");
});

test("substrate core carries no policy import — the boundary bites", () => {
  const core = "packages/framework/substrate/src/context.ts";
  expect(
    findSubstratePurityViolation(
      core,
      'import type { X } from "@natalia/work-ledger";',
    ),
  ).toContain("product-context");
  expect(
    findSubstratePurityViolation(
      core,
      'import type { X } from "@natalia/governance-ledger";',
    ),
  ).toContain("governance-ledger");
  // Generic machinery stays legal (InteractiveWaiter's package is not the
  // policy collaboration of runtime/collaboration).
  expect(
    findSubstratePurityViolation(
      core,
      'import type { X } from "@natalia/collaboration";',
    ),
  ).toBeUndefined();
  // Files not yet on the list are simply not checked (the list grows per
  // extraction step).
  expect(
    findSubstratePurityViolation(
      "packages/framework/client/src/runtime/ports.ts",
      'from "@natalia/work-ledger"',
    ),
  ).toBeUndefined();
  // context-ledger stays legal in substrate: the policy BAND governs the
  // prefix (it remains @natalia), while the import ban names §1.1's
  // concepts — context machinery underpins exec/initialize/ports.
  expect(
    findSubstratePurityViolation(
      core,
      'import type { L } from "@natalia/context-ledger";',
    ),
  ).toBeUndefined();
});

test("workspace-manager consumes only the composition root", () => {
  expect(
    findWorkspaceManagerBoundaryViolation(
      'import { createRealRuntimeClient } from "./runtime/main";',
    ),
  ).toBeUndefined();
  expect(
    findWorkspaceManagerBoundaryViolation(
      'import { wireFoundation } from "./runtime/composition/foundation";',
    ),
  ).toContain("composition root");
  expect(
    findWorkspaceManagerBoundaryViolation(
      'const x = await import("./runtime/ports");',
    ),
  ).toContain("composition root");
  // Package imports (substrate, session-store, contracts) are the
  // consumer's ordinary diet — only CLIENT-INTERNAL relatives are gated.
  expect(
    findWorkspaceManagerBoundaryViolation(
      'import type { RealRuntimeClientOptions } from "@anthelia/substrate";',
    ),
  ).toBeUndefined();
});

test("source-tree JS is banned by default; the six legacy sources stay", () => {
  // The orphan class: a compiled test whose .ts MOVED away — banned.
  expect(
    findSourceTreeJsViolation("packages/framework/client/test/old.test.js"),
  ).toContain("source-tree JS");
  expect(
    findSourceTreeJsViolation("packages/domains/collab/src/STRAY.jsx"),
  ).toContain("source-tree JS");
  // The genuine third-party/platform sources are allowlisted by path.
  expect(
    findSourceTreeJsViolation(
      "packages/plugins/browser/src/extension/chromium/background.js",
    ),
  ).toBeUndefined();
  // Not JS: untouched.
  expect(
    findSourceTreeJsViolation("packages/domains/collab/src/index.ts"),
  ).toBeUndefined();
});
