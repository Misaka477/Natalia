import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  MACHINE_LOCAL_STATE_DIRS,
  isMachineLocalStatePath,
} from "../machine-local-state";

/**
 * One list for the state a checkout writes for itself.
 *
 * It was three copies of a rule — the copier in `build-standalone.ts`, that
 * script's own self-check, and the Windows install plan — which is why
 * `shared-plugin-store/` (the suite's shared official-plugin install, whose
 * lock pins this checkout by ABSOLUTE path) shipped in every release the build
 * assembled, landed in the deployed tree, and was refused by none of them.
 */
const root = join(import.meta.dir, "..", "..");
const source = (relative: string) => readFileSync(join(root, relative), "utf8");

test("every state directory is named, and only the state directories are", () => {
  // Named: the four measured offenders. The fourth is the one no list had.
  for (const name of [
    "plugin-store",
    "cli-dev-pty-stores",
    "client-test-workspaces",
    "shared-plugin-store",
  ])
    expect(MACHINE_LOCAL_STATE_DIRS).toContain(name as never);
});

test("the match is on the leading segment, in either separator", () => {
  // A walk yields a path INSIDE the offender, and the Windows plan yields
  // backslashes; a guard that reads only one separator passes the other.
  expect(isMachineLocalStatePath("shared-plugin-store")).toBe(true);
  expect(
    isMachineLocalStatePath("shared-plugin-store/node_modules/@natalia/x"),
  ).toBe(true);
  expect(
    isMachineLocalStatePath("plugin-store\\node_modules\\@natalia\\x"),
  ).toBe(true);
  // A release's own content is not state, including a name that merely starts
  // with one: `plugins/plugin-store-notes` is a file a plugin may ship.
  expect(isMachineLocalStatePath("plugins/natalia-browser/index.js")).toBe(
    false,
  );
  expect(isMachineLocalStatePath("plugins/plugin-store-notes/x.js")).toBe(
    false,
  );
  expect(isMachineLocalStatePath("natalia.exe")).toBe(false);
});

test("the three consumers read the one list instead of re-listing it", () => {
  // The copier and its self-check.
  const standalone = source("scripts/build-standalone.ts");
  expect(standalone).toContain(
    'import { MACHINE_LOCAL_STATE_DIRS } from "./machine-local-state"',
  );
  expect(standalone).toContain("new Set<string>(MACHINE_LOCAL_STATE_DIRS)");
  expect(standalone).toContain(
    "for (const forbidden of MACHINE_LOCAL_STATE_DIRS)",
  );
  // And no copy of the names is left behind to drift from it.
  expect(standalone).not.toContain('"cli-dev-pty-stores"');
  expect(standalone).not.toContain('"shared-plugin-store"');

  // The installer plan.
  const plan = source("scripts/windows-install-plan.ts");
  expect(plan).toContain(
    'import { isMachineLocalStatePath } from "./machine-local-state"',
  );
  expect(plan).toContain("return isMachineLocalStatePath(target);");
  expect(plan).not.toContain("EXCLUDED_PREFIXES");
  expect(plan).not.toContain('"client-test-workspaces"');
});
