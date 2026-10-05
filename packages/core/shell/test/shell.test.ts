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
  ENCODING_PREAMBLE,
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

test("the platform mirror: pwsh on win32, zsh on darwin, bash elsewhere", () => {
  // THE requested behaviour: Windows pwsh, macOS zsh, Linux bash.
  expect(platformShell("win32")).toBe("pwsh");
  expect(platformShell("linux")).toBe("bash");
  expect(platformShell("darwin")).toBe("zsh");
  // Anything unrecognised is POSIX sh, which every shell-shaped caller speaks.
  expect(platformShell("freebsd")).toBe("bash");
});

test("an explicit shell name wins, and anything else is the platform's own", () => {
  // THE bug this replaced: an unset request used to fall back to bash, and on
  // Windows bash IS WSL — `cmd` not found, `node`/`bun` not on its PATH, and
  // every shell-adjacent tool died with "the command could not be started".
  // The user's terminal showed exactly that. Now an absent, empty, `auto`, or
  // typo'd request resolves to the shell this host already runs.
  expect(resolveShellName("pwsh", "win32")).toBe("pwsh");
  expect(resolveShellName("bash", "win32")).toBe("bash");
  expect(resolveShellName("auto", "win32")).toBe("pwsh");
  expect(resolveShellName("auto", "linux")).toBe("bash");
  expect(resolveShellName(undefined, "win32")).toBe("pwsh");
  expect(resolveShellName("", "win32")).toBe("pwsh");
  expect(resolveShellName("powershel", "win32")).toBe("pwsh");
  // A request for a shell this host HAS is honoured everywhere; zsh on Windows
  // is a caller explicitly asking for it, not an unknown name.
  expect(resolveShellName("zsh", "win32")).toBe("zsh");
  // And a POSIX host is untouched by any of it.
  expect(resolveShellName(undefined, "linux")).toBe("bash");
  expect(resolveShellName("", "linux")).toBe("bash");
});

test("with no opt-in a Windows host runs its own shell, not WSL's bash", () => {
  // THE behaviour change, pinned: no NATALIA_SHELL, on Windows, is pwsh.
  // Before it was BashLocalExecutor, which on Windows means
  // C:\Windows\System32\bash.exe — WSL.
  expect(selectExecutor({}, "win32")).toBeInstanceOf(PwshLocalExecutor);
  expect(selectExecutor({}, "linux")).toBeInstanceOf(BashLocalExecutor);
  expect(selectExecutor({}, "darwin")).toBeInstanceOf(BashLocalExecutor);
  // And the explicit opt-ins still reach the same places.
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

/**
 * The matrix.
 *
 * The property under test is that every executor inherits every policy, so the
 * same assertions run against both. That is only honest where the assertion does
 * not need the shell to EXECUTE anything: the pure construction is cross-checked
 * on both, and the execution tests stay bash-only with a note rather than being
 * silently skipped for pwsh — a matrix that quietly omits a shell on the rows it
 * cannot run is a matrix that lies about its coverage.
 */
const MATRIX: Array<[string, () => ShellExecutor]> = [
  ["bash", () => new BashLocalExecutor()],
  ["pwsh", () => new PwshLocalExecutor()],
];

for (const [name, make] of MATRIX) {
  test(`${name}: resolves a command into a spawnable argv with a capped timeout`, () => {
    const spec = make().resolve({
      command: "some command",
      workdir: "/work",
      timeoutMs: 90 * 60 * 1000,
    });
    // Every executable must be an absolute path or a PATH name, never empty: an
    // empty one spawns nothing and reads as a hang.
    expect(spec.command.length).toBeGreaterThan(0);
    expect(spec.args.length).toBeGreaterThan(0);
    expect(spec.cwd).toBe("/work");
    // The cap is the seam's, and it is shared by construction.
    expect(spec.timeoutMs).toBe(600_000);
    // The command text survives into the argv somewhere — no executor may drop
    // it, or the shell would run an empty line.
    expect([spec.command, ...spec.args].join(" ")).toContain("some command");
  });

  test(`${name}: the caller's environment is the base an executor's defaults sit on`, () => {
    const spec = make().resolve({
      command: "x",
      env: { NATALIA_PROBE: "caller-value" },
    });
    expect(spec.env?.NATALIA_PROBE).toBe("caller-value");
  });
}

test("pwsh's argv is exactly the four flags and one command element", () => {
  // Pinned specifically, and NOT executed. These are the option spellings and
  // the single-argv property that make quoting unnecessary, so a change to any
  // of them is a change to the reason this shell needs no shellQuote — and a
  // real pwsh host is what confirms pwsh accepts them.
  const spec = new PwshLocalExecutor().resolve({ command: "Get-Date" });
  expect(spec.args).toEqual([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    `${ENCODING_PREAMBLE}Get-Date`,
  ]);
  // The encoding prefix is part of the COMMAND, so it must precede it.
  expect(spec.args[4]!.startsWith(ENCODING_PREAMBLE)).toBe(true);
});

test("pwsh refuses the POSIX detached launcher, and says which combination cannot work", () => {
  // Not a stub that returns something plausible: pwsh has no `setsid` and no
  // `$!`, so any spelling would be a second mechanism nothing has executed.
  expect(() =>
    new PwshLocalExecutor().detachedPosixScript({
      command: "x",
      outputPath: "/tmp/x.log",
    }),
  ).toThrow(/setsid/u);
});

test("pwsh execution is covered where pwsh exists, and named where it does not", () => {
  // The honest statement of what this matrix does not cover, kept as a test so
  // it cannot be forgotten: the run/start paths above drive bash (and a
  // hand-written FixedExecutor that spawns sh).
  //
  // It used to assert `Bun.which("pwsh") === null` — a fact about the MACHINE,
  // not about the code, so it failed the moment a host had PowerShell on PATH
  // (and this project's own development host does). An environment fact is not
  // a contract. What is asserted instead is that the coverage statement is
  // accompanied by the real thing wherever pwsh exists:
  const pwsh = Bun.which("pwsh");
  if (pwsh === null) {
    // Named, not silently skipped: the matrix does not lie about its coverage.
    expect(pwsh).toBe(null);
    return;
  }
  // pwsh IS present, so the argv the executor builds must be one pwsh accepts.
  // Executing it is stronger than asserting a name, and it is what the comment
  // above always promised.
  const spec = new PwshLocalExecutor().resolve({ command: "exit 3" });
  const proc = Bun.spawnSync({
    cmd: [spec.command, ...spec.args],
    cwd: spec.cwd,
    env: { ...process.env, ...(spec.env ?? {}) },
    stdout: "pipe",
    stderr: "pipe",
  });
  expect(proc.exitCode).toBe(3);
});
