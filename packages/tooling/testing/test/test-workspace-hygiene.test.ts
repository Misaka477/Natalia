import { expect, test } from "bun:test";
import {
  createsTestWorkspace,
  importsTestWorkspaceHelpers,
  workspaceCreatorFilesMissingCleanup,
} from "../src/test-workspace-hygiene";

const helperImport = `import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";`;

test("a creator without the hook is a violation", () => {
  expect(
    workspaceCreatorFilesMissingCleanup([
      {
        path: "packages/x/test/a.test.ts",
        text: `${helperImport}\nconst root = await officialPluginWorkspace("a");\n`,
      },
    ]),
  ).toEqual(["packages/x/test/a.test.ts"]);
});

test("a creator WITH the hook is not", () => {
  expect(
    workspaceCreatorFilesMissingCleanup([
      {
        path: "packages/x/test/a.test.ts",
        text: `${helperImport}\nuseWorkspaceCleanup();\nconst root = await officialPluginWorkspace("a");\n`,
      },
    ]),
  ).toEqual([]);
});

test("a file that imports the helpers but creates nothing is not", () => {
  expect(
    workspaceCreatorFilesMissingCleanup([
      { path: "packages/x/test/b.test.ts", text: helperImport },
    ]),
  ).toEqual([]);
});

test("a MENTION of plugin-test-helpers in prose is not an import", () => {
  // Measured false positive: consumer-conformance.test.ts explains in a comment
  // that it copies what plugin-test-helpers.ts does, and imports the
  // @natalia/testing fixtures instead — whose workspaces live under another
  // root with their own registry.
  const text = [
    `// (plugin-test-helpers.ts), with a copy fallback for Windows hosts`,
    `const root = await officialPluginWorkspace("consumer");`,
  ].join("\n");
  expect(importsTestWorkspaceHelpers(text)).toBe(false);
  expect(createsTestWorkspace(text)).toBe(true);
  expect(
    workspaceCreatorFilesMissingCleanup([{ path: "c.test.ts", text }]),
  ).toEqual([]);
});

test("the violations come back sorted, for a stable failure message", () => {
  const text = `${helperImport}\nawait officialPluginWorkspace("x");`;
  expect(
    workspaceCreatorFilesMissingCleanup([
      { path: "packages/z/test/z.test.ts", text },
      { path: "packages/a/test/a.test.ts", text },
    ]),
  ).toEqual(["packages/a/test/a.test.ts", "packages/z/test/z.test.ts"]);
});
