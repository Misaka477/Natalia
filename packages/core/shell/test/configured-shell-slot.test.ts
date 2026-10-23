/**
 * Does the configured shell actually reach the executor?
 *
 * The chain is: settings panel → config.runtime.shell.executable →
 * `setConfiguredShell` → `selectExecutor`. Every earlier check read source or
 * ran a unit test that passed its own argument in; none of them proved the
 * RUNTIME's write reaches the executor the six call sites use.
 *
 * This writes the slot the way the runtime does and asks the executor.
 *
 * The pwsh half is a PLATFORM-MIRRORED assertion, not a universal one:
 * `selectExecutor` refuses pwsh off Windows (a Linux host that asked for
 * PowerShell gets bash, because `cmd` and the Windows `node` are not
 * reachable there), so the same write earns a different executor per host.
 * Asserting `PwshLocalExecutor` unconditionally is what made this file red
 * on every Linux run from the day the refusal landed — measured: the
 * ubuntu-latest `core-1` job failed on `toBeInstanceOf(PwshLocalExecutor)`
 * receiving `BashLocalExecutor`, and the same test passed on Windows.
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

  // pwsh is honoured on Windows and refused off it: the slot is WRITTEN
  // either way (the settings row and config.get must still read what the
  // user chose), and only the executor differs.
  setConfiguredShell("pwsh");
  expect(configuredShellName()).toBe("pwsh");
  expect(selectExecutor()).toBeInstanceOf(
    process.platform === "win32" ? PwshLocalExecutor : BashLocalExecutor,
  );

  // 自动 records nothing, so the executor falls back to the platform default.
  setConfiguredShell(undefined);
  expect(configuredShellName()).toBeUndefined();
  expect(selectExecutor()).toBeInstanceOf(
    process.platform === "win32" ? PwshLocalExecutor : BashLocalExecutor,
  );
});

test("the refusal is the host's, not the caller's spelling", () => {
  // The same EXPLICIT argument lands differently per host, which is the
  // property the slot cannot express and this selector can: a Windows host
  // honours every choice, a POSIX host maps pwsh to bash rather than to a
  // shell whose commands cannot run.
  expect(selectExecutor("win32", "pwsh")).toBeInstanceOf(PwshLocalExecutor);
  expect(selectExecutor("linux", "pwsh")).toBeInstanceOf(BashLocalExecutor);
  expect(selectExecutor("darwin", "pwsh")).toBeInstanceOf(BashLocalExecutor);
  // bash is honoured everywhere, including on Windows (Git Bash).
  expect(selectExecutor("win32", "bash")).toBeInstanceOf(BashLocalExecutor);
  expect(selectExecutor("linux", "bash")).toBeInstanceOf(BashLocalExecutor);
});
