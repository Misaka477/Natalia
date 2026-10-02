import { expect, test } from "bun:test";
import {
  requiresApproval,
  riskTierForChanges,
  riskTierForPath,
} from "../src/governance";

test("paths classify into risk tiers", () => {
  // The tool contract and the capability kernel are high risk.
  expect(riskTierForPath("packages/core/tools/src/types.ts")).toBe("high");
  expect(riskTierForPath("packages/core/capability/src/index.ts")).toBe("high");
  expect(riskTierForPath("packages/core/plugin/src/index.ts")).toBe("high");
  // Implementation source is medium.
  expect(riskTierForPath("packages/tool-fs/src/index.ts")).toBe("medium");
  expect(riskTierForPath("packages/framework/client/src/runtime/main.ts")).toBe(
    "medium",
  );
  // Data and config are low.
  expect(riskTierForPath(".natalia/config.json")).toBe("low");
  expect(riskTierForPath("docs/guide.md")).toBe("low");
});

test("a change set takes the highest of its changes", () => {
  expect(riskTierForChanges([{ kind: "modify", path: "docs/guide.md" }])).toBe(
    "low",
  );
  expect(
    riskTierForChanges([
      { kind: "modify", path: "docs/guide.md" },
      { kind: "modify", path: "packages/tool-fs/src/index.ts" },
    ]),
  ).toBe("medium");
  expect(
    riskTierForChanges([
      { kind: "modify", path: "packages/core/tools/src/types.ts" },
      { kind: "modify", path: "packages/tool-fs/src/index.ts" },
    ]),
  ).toBe("high");
});

test("approval gates are monotonic by tier", () => {
  expect(requiresApproval("medium", "low")).toBe(true);
  expect(requiresApproval("high", "high")).toBe(true);
  expect(requiresApproval("low", "high")).toBe(false);
  expect(requiresApproval("medium", "high")).toBe(false);
});
