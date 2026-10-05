// THE bug this pins: `checkpoint incomplete (pre_tool)`.
//
// Measured on a real workspace: 146 entries, 943MB, and
// `checkpoint byte guard exceeded: 536870912` — because the workspace held
// 4.68GB of minidumps under .btmp/dumps, and neither .nataliaignore nor the
// default set knew to ignore them. The guards then aborted the capture, the
// checkpoint was recorded incomplete, and every tool call in the turn failed
// with `invalid_request (400)`.
//
// The fix has two halves, and this test pins the half that can regress
// silently: the ignore rules must cover session scratch. The other half —
// actually removing the residue — cannot be asserted from here.
import { expect, test } from "bun:test";
import { DEFAULT_NATALIA_IGNORE_PATTERNS } from "@anthelia/platform";
import { parseSnapshotIgnore, isSnapshotIgnored } from "@anthelia/platform";

test("the default ignore set covers the session scratch that blew the guard", () => {
  // The measured shape: a minidump under a temp directory, and the harness's
  // redirected tool homes. None of it is source; all of it is regenerable.
  for (const required of [
    ".btmp/",
    ".bmp/",
    "node-compile-cache/",
    "*.dmp",
    ".bun-home/",
  ] as const) {
    expect(DEFAULT_NATALIA_IGNORE_PATTERNS as readonly string[]).toContain(
      required,
    );
  }
});

test("a minidump and a temp-dir artifact are ignored, not captured", () => {
  // The exact entries the failing capture took: parsed through the same
  // matcher the capture uses, so this fails if the rule shape drifts.
  const rules = parseSnapshotIgnore(DEFAULT_NATALIA_IGNORE_PATTERNS.join("\n"));
  expect(isSnapshotIgnored(".btmp/dumps/x.dmp", false, rules)).toBe(true);
  expect(isSnapshotIgnored(".btmp/whatever.log", false, rules)).toBe(true);
  expect(isSnapshotIgnored("node_modules/pkg/index.js", false, rules)).toBe(
    true,
  );
  expect(isSnapshotIgnored(".bmp/scratch.txt", false, rules)).toBe(true);
  // And real source is still captured: an ignore that eats the workspace is
  // not a fix either.
  expect(
    isSnapshotIgnored("packages/core/tools/src/validate.ts", false, rules),
  ).toBe(false);
  expect(isSnapshotIgnored("README.md", false, rules)).toBe(false);
});
