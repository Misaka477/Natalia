/**
 * Does the configured shell actually reach the executor?
 *
 * The chain is: settings panel → config.runtime.shell.executable →
 * `setConfiguredShell` → `selectExecutor`. Every earlier check read source or
 * ran a unit test that passed its own argument in; none of them proved the
 * RUNTIME's write reaches the executor the six call sites use.
 *
 * This writes the slot the way the runtime does and asks the executor.
 */
import { expect, test } from "bun:test";
import { BashLocalExecutor } from "../src/bash-local";
import { PwshLocalExecutor } from "../src/pwsh-local";
import {
  configuredShellName,
  selectExecutor,
  setConfiguredShell,
} from "../src/select";

test("the runtime's write reaches the executor", () => {
  // What the runtime does at config load and on every reload.
  setConfiguredShell("bash");
  expect(configuredShellName()).toBe("bash");
  expect(selectExecutor()).toBeInstanceOf(BashLocalExecutor);

  setConfiguredShell("pwsh");
  expect(configuredShellName()).toBe("pwsh");
  expect(selectExecutor()).toBeInstanceOf(PwshLocalExecutor);

  // 自动 records nothing, so the executor falls back to the platform default.
  setConfiguredShell(undefined);
  expect(configuredShellName()).toBeUndefined();
  expect(selectExecutor()).toBeInstanceOf(
    process.platform === "win32" ? PwshLocalExecutor : BashLocalExecutor,
  );
});
