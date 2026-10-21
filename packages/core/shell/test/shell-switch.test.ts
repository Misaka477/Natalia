/**
 * The session's shell is switchable mid-session, and the model is told.
 *
 * Two properties worth pinning, none of which a UI click can check for
 * itself: the executor seam resolves PER CALL so a later choice is hot, and
 * the notice rides the durable latest-win `context.instructions` channel
 * rather than the system prompt (whose cached prefix a per-session fact would
 * invalidate).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { beforeEach, expect, test } from "bun:test";
import { BashLocalExecutor } from "../src/bash-local";
import { PwshLocalExecutor } from "../src/pwsh-local";
import {
  configuredShellName,
  executorFor,
  resolveShellName,
  selectExecutor,
  setConfiguredShell,
} from "../src/select";

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");

beforeEach(() => {
  // The slot is the only channel left: no test may leak a shell into the next.
  setConfiguredShell(undefined);
});

test("the shell resolves per call, so a later choice is hot", () => {
  // The defect this pins: a module-level `const shell = selectExecutor()` is
  // evaluated at import time — process start — so a shell chosen later never
  // reached it and the human had to restart the app. Resolving per call is what
  // makes the choice take effect on the next command.
  setConfiguredShell("bash");
  expect(selectExecutor()).toBeInstanceOf(BashLocalExecutor);
  setConfiguredShell("pwsh");
  expect(selectExecutor()).toBeInstanceOf(PwshLocalExecutor);
  // And the caller's own choice still outranks the recorded one.
  expect(selectExecutor(process.platform, "bash")).toBeInstanceOf(
    BashLocalExecutor,
  );
});

test("the recorded shell outranks nothing but the caller, and the platform answers when absent", () => {
  // Precedence lives in `selectExecutor`, which is the seam every caller goes
  // through — `resolveShellName` only maps a name and reads no environment.
  // There is no environment tier any more: `NATALIA_SHELL` was one and was
  // deleted, so "nothing recorded" goes straight to the platform's own shell,
  // which on Windows is pwsh — the assertion names the platform rather than
  // assuming POSIX.
  setConfiguredShell(undefined);
  expect(selectExecutor()).toBeInstanceOf(
    process.platform === "win32" ? PwshLocalExecutor : BashLocalExecutor,
  );
});

test("an absent or unrecognised choice is the platform's own shell", () => {
  // A typo resolving to the platform shell is a smaller surprise than a typo
  // resolving to another operating system's shell — on Windows, bash is WSL.
  setConfiguredShell(undefined);
  expect(resolveShellName(undefined, "win32")).toBe("pwsh");
  expect(resolveShellName("nonsense", "win32")).toBe("pwsh");
  // macOS and Linux both default to bash: zsh is the login shell on a Mac but
  // bash is the POSIX shell a script can rely on, and one default for both
  // keeps "自动" meaning one thing.
  expect(resolveShellName(undefined, "darwin")).toBe("bash");
  expect(resolveShellName(undefined, "linux")).toBe("bash");
});

test("pwsh is not honoured off Windows", () => {
  // PowerShell is not the shell Linux or macOS ships, and a human who picks it
  // there gets bash rather than a shell whose `cmd` and `node` are unreachable.
  expect(selectExecutor("linux", "pwsh")).toBeInstanceOf(BashLocalExecutor);
  expect(selectExecutor("darwin", "pwsh")).toBeInstanceOf(BashLocalExecutor);
  // On Windows every choice is honoured.
  expect(selectExecutor("win32", "pwsh")).toBeInstanceOf(PwshLocalExecutor);
  expect(selectExecutor("win32", "bash")).toBeInstanceOf(BashLocalExecutor);
});

test("the switch notice is a context.instructions record, not a prompt line", () => {
  // The channel is the contract: a per-session fact injected into the system
  // prompt would change the prompt's cached prefix on every switch and throw
  // the cache away. The journal record is durable and latest-win instead.
  const source = readFileSync(
    join(repoRoot, "packages/framework/client/src/runtime/shell-switch.ts"),
    "utf8",
  );
  expect(source).toContain('kind: "shell_switch"');
  expect(source).toContain("nextContextInstructionsRevision");
  // And the kind is part of the event union, so the projection keeps the latest
  // revision per kind rather than accumulating one record per switch.
  const events = readFileSync(
    join(repoRoot, "packages/core/contracts/src/events.ts"),
    "utf8",
  );
  expect(events).toContain('| "shell_switch"');
});

test("the switch is session-scoped and dies with the session", () => {
  // The field lives on the exec, which is per-session: a restart starts at the
  // deployment's shell and the journal record is the durable half.
  const state = readFileSync(
    join(
      repoRoot,
      "packages/framework/substrate/src/session-execution-state.ts",
    ),
    "utf8",
  );
  expect(state).toContain("shellOverride?");
});
