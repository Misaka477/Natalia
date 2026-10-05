// The launcher must not open a browser when the window host hands off.
//
// CEF's exit 38 is `CEF_RESULT_CODE_NORMAL_EXIT_AUTO_DE_ELEVATED` — "the browser
// process exited because it was re-launched without elevation" — which happens
// whenever the launcher runs elevated: Chromium's ProcessSingleton de-elevates a
// copy of the process, that copy puts the real window on screen, and the process
// the launcher spawned exits 38. Measured in an elevated launch: the CEF log
// carries `RunDeElevated: Started process, PID: <n>` and
// `AddKeepAlive(kBrowserWindow)` under that OTHER pid.
//
// Treating 38 as a failure therefore opens a second window over a working one.
// This pins the guard so that regression is visible without an elevated host.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(import.meta.dir, "..", "src", "start-app.ts"),
  "utf8",
);

test("exit 38 means the launch was handed off, not that it failed", () => {
  // The constant is named, and named for what the code means — not a bare 38.
  expect(source).toContain("CEF_EXIT_HANDED_OFF_TO_DE_ELEVATED");
  expect(source).toContain("= 38");
  // The branch returns before the browser fallback, and says why on stderr.
  const branch = source.slice(
    source.indexOf("CEF_EXIT_HANDED_OFF_TO_DE_ELEVATED)"),
    source.indexOf("opening the app in the default browser"),
  );
  expect(branch).toContain("return 0");
  expect(branch.toLowerCase()).toContain("de-elevated");
  // And the comment carries the evidence, so the next reader does not have to
  // rediscover why a nonzero exit code is a success.
  expect(source).toContain("CEF_RESULT_CODE_NORMAL_EXIT_AUTO_DE_ELEVATED");
  expect(source).toContain("RunDeElevated");
});
