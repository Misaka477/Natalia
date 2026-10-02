import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  BashLocalExecutor,
  PwshLocalExecutor,
  ShellExecutor,
  clampTimeout,
  platformShell,
  resolveShellName,
  selectExecutor,
  type ShellExecRequest,
  type ShellExecSpec,
} from "@anthelia/shell";

/**
 * The seam's own tests: the split between shell-specific and shared.
 *
 * These assert the properties that make the seam a seam, because a package whose
 * only test is "bash still works" has not proven that a SECOND shell can be
 * added. The decisive one is the last: an executor that has never heard of bash
 * inherits every policy.
 */

test("timeouts are clamped, not trusted", () => {
  // The caps are the ones the shell tool already carried; a caller asking for a
  // negative, zero or absurd budget gets a defined one rather than a
  // never-firing timer.
  expect(clampTimeout(undefined)).toBe(120_000);
  expect(clampTimeout(0)).toBe(120_000);
  expect(clampTimeout(-5)).toBe(120_000);
  expect(clampTimeout(1_000)).toBe(1_000);
  expect(clampTimeout(90 * 60 * 1000)).toBe(600_000);
});

test("the bash executor resolves to the isolated argv, cwd and a capped timeout", () => {
  const bash = new BashLocalExecutor();
  const spec = bash.resolve({
    command: "echo hi",
    workdir: "/tmp",
    timeoutMs: 90 * 60 * 1000,
  });
  // The exact argv `isolatedShellCommand` produced before the seam existed.
  // Behaviour-preserving is the whole point of this step, so the shape is
  // asserted rather than summarised.
  expect(spec.args).toEqual(["--noprofile", "--norc", "-c", "echo hi"]);
  expect(spec.cwd).toBe("/tmp");
  expect(spec.timeoutMs).toBe(600_000);
});

test("a run reports exit code, streams and outcome without rejecting on failure", async () => {
  const bash = new BashLocalExecutor();
  const run = await bash.run(
    bash.resolve({ command: "echo out; echo err 1>&2; exit 3" }),
  );
  // A NONZERO exit resolves. Rejecting on nonzero would collapse "the command
  // failed" into "the command could not be run", which the shell tool has always
  // distinguished.
  expect(run.outcome).toBe("exited");
  expect(run.exitCode).toBe(3);
  expect(run.stdout).toContain("out");
  expect(run.stderr).toContain("err");
});

test("a timeout resolves as a timeout and the process is actually gone", async () => {
  const bash = new BashLocalExecutor();
  // The command reports its own pid, so the leak check targets exactly the
  // process the timeout was supposed to kill. (An earlier version called `start`
  // AND `run` — two spawns — and checked the wrong one's pid, which is a test
  // bug that reads as a leak.)
  const spec = bash.resolve({
    command: "sh -c 'echo $$; sleep 30'",
    timeoutMs: 400,
  });
  const started = Date.now();
  const run = await bash.run(spec);
  const childPid = Number(run.stdout.trim().split("\n")[0]);

  expect(run.outcome).toBe("timeout");
  expect(run.exitCode).toBe(null);
  expect(childPid).toBeGreaterThan(0);
  expect(Date.now() - started).toBeLessThan(5_000);

  // The tree-kill sends SIGTERM and escalates to SIGKILL after a two-second
  // grace, so this waits past that window before asserting the tree is gone.
  //
  // `kill -0`, not `ps`: in a sandbox a process can be alive while `ps` will not
  // list it, which reads as a survivor that is not one. `kill -0` asks the kernel
  // about the one pid, which is the only thing being asserted.
  await Bun.sleep(2_600);
  const alive =
    Bun.spawnSync(
      ["sh", "-c", `kill -0 ${childPid} 2>/dev/null && echo yes || echo no`],
      { stdout: "pipe" },
    )
      .stdout.toString()
      .trim() === "yes";
  expect(alive, `pid ${childPid} outlived its timeout`).toBe(false);
});

test("an abort signal resolves as aborted", async () => {
  const bash = new BashLocalExecutor();
  const controller = new AbortController();
  setTimeout(() => controller.abort(), 200);
  const run = await bash.run(bash.resolve({ command: "sleep 30" }), {
    command: "sleep 30",
    signal: controller.signal,
  });
  expect(run.outcome).toBe("aborted");
});

test("a background process streams its output and reports its exit", async () => {
  const bash = new BashLocalExecutor();
  const work = await mkdtemp(join(tmpdir(), "shell-bg-"));
  try {
    const handle = await bash.start(
      bash.resolve({ command: "echo streamed; exit 4", workdir: work }),
    );
    expect(handle.pid).toBeGreaterThan(0);
    const chunks: string[] = [];
    const exit = new Promise<{ exitCode: number | null }>((resolveExit) => {
      handle.onExit((event) => resolveExit(event));
    });
    handle.onOutput((chunk) => chunks.push(chunk));
    const { exitCode } = await exit;
    expect(exitCode).toBe(4);
    expect(chunks.join("")).toContain("streamed");
  } finally {
    await rm(work, { recursive: true, force: true });
  }
});

test("a second shell inherits every policy without touching the seam", async () => {
  // THE reason this package exists. An executor that has never heard of bash —
  // its `resolve` returns a fixed argv — still gets the timeout, the abort, the
  // output capture and the outcome classification, because they live above the
  // seam. This is the shape a pwsh executor will have.
  class FixedExecutor extends ShellExecutor {
    resolve(request: ShellExecRequest): ShellExecSpec {
      return {
        command: "sh",
        args: ["-c", request.command],
        cwd: request.workdir ?? process.cwd(),
        timeoutMs: clampTimeout(request.timeoutMs),
      };
    }
  }
  const executor = new FixedExecutor();
  expect(executor.resolve({ command: "x" }).args).toEqual(["-c", "x"]);
  const run = await executor.run(
    executor.resolve({ command: "echo pwsh-shaped; exit 2" }),
  );
  expect(run.outcome).toBe("exited");
  expect(run.exitCode).toBe(2);
  expect(run.stdout).toContain("pwsh-shaped");
});

test("the caller's environment reaches the child, and an executor's overrides do not replace it", async () => {
  const bash = new BashLocalExecutor();
  // A variable only the caller set, and one the executor adds: both must reach
  // the child, and the caller's must survive word-for-word. This is the property
  // that was silently absent for two commits — the shell tool's env allowlist was
  // dropped when the seam was introduced, so `bash` inherited the runtime's whole
  // environment, and no test named it until the pwsh overrides forced the shape.
  // Through resolve, which is where an executor applies its environment — the
  // same path the shell tool takes. Passing it to `run` instead leaves the spec
  // without one, because the spawn reads the spec.
  const run = await bash.run(
    bash.resolve({
      command: "echo $NATALIA_PROBE_VAR",
      env: { NATALIA_PROBE_VAR: "from-the-caller", PATH: process.env.PATH },
    }),
  );
  expect(run.stdout.trim()).toBe("from-the-caller");

  // And the reverse: an executor that adds defaults must not clobber a value the
  // caller set deliberately. resolve is where defaults are applied, so this is
  // where the precedence is decided.
  const pwsh = new PwshLocalExecutor();
  const spec = pwsh.resolve({
    command: "x",
    env: { NO_COLOR: "0", PATH: process.env.PATH },
  });
  expect(spec.env?.NO_COLOR).toBe("0");
  expect(spec.env?.PAGER).toBe("cat");
});

test("a caller that passes no environment inherits, exactly as before", async () => {
  const bash = new BashLocalExecutor();
  const run = await bash.run(bash.resolve({ command: "echo $HOME" }));
  // Inherited, not replaced with an empty object: spawn(env=undefined) is what
  // the pre-seam code did by not passing env at all.
  expect(run.stdout.trim()).toBe(String(process.env.HOME));
});

test("the platform mirror: pwsh on win32, bash elsewhere", () => {
  // The mirror dsh expresses as inverted enablement rows. It is written and
  // tested here even though it is not the default, so the flip is one line and
  // both sides are already pinned.
  expect(platformShell("win32")).toBe("pwsh");
  expect(platformShell("linux")).toBe("bash");
  expect(platformShell("darwin")).toBe("bash");
});

test("an explicit shell name wins, and an unknown one falls back to bash", () => {
  // A typo must not select PowerShell by accident: the shell that has always run
  // is the safe reading of a request nothing understands.
  expect(resolveShellName("pwsh", "win32")).toBe("pwsh");
  expect(resolveShellName("bash", "win32")).toBe("bash");
  expect(resolveShellName("auto", "win32")).toBe("pwsh");
  expect(resolveShellName("auto", "linux")).toBe("bash");
  expect(resolveShellName(undefined, "win32")).toBe("bash");
  expect(resolveShellName("", "win32")).toBe("bash");
  expect(resolveShellName("powershel", "win32")).toBe("bash");
  expect(resolveShellName("zsh", "win32")).toBe("bash");
});

test("the default is bash on every platform, so enabling the mirror changes nothing", () => {
  // THE behaviour-preserving property of this step: with no opt-in, a Windows host
  // runs bash exactly as it did before the mirror existed.
  expect(selectExecutor({}, "win32")).toBeInstanceOf(BashLocalExecutor);
  expect(selectExecutor({}, "linux")).toBeInstanceOf(BashLocalExecutor);
  // And the opt-in reaches pwsh on Windows and bash elsewhere.
  expect(selectExecutor({ NATALIA_SHELL: "pwsh" }, "win32")).toBeInstanceOf(
    PwshLocalExecutor,
  );
  expect(selectExecutor({ NATALIA_SHELL: "auto" }, "win32")).toBeInstanceOf(
    PwshLocalExecutor,
  );
  expect(selectExecutor({ NATALIA_SHELL: "auto" }, "linux")).toBeInstanceOf(
    BashLocalExecutor,
  );
});
