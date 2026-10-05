import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import {
  createPtyTerminalController,
  nativeTerminalPaneSpawn,
} from "../src/index";

// The override, then the WSL drop (~/.local/bin), then PATH. The third is what
// a Windows host — and a GitHub windows-latest runner — has: pwsh ships with
// the OS image and `Bun.which` finds it. Without it this file skipped on every
// Windows machine, which is where the ONLY pane shell PowerShell integration
// would ever run for real.
const pwshPath =
  process.env.NATALIA_PWSH ??
  Bun.which("pwsh") ??
  `${process.env.HOME}/.local/bin/pwsh`;

const havePwsh = async (): Promise<boolean> => {
  if (!existsSync(pwshPath)) return false;
  // All three, not just the cache: pwsh resolves its data home through HOME as well, and
  // setting only XDG_CACHE_HOME leaves it writing to a read-only $HOME and dying before
  // the first prompt.
  const home = await mkdtemp(join(tmpdir(), "natalia-pwsh-probe-"));
  const probe = Bun.spawnSync([pwshPath, "-NoLogo", "-Command", '"ok"'], {
    env: {
      ...process.env,
      HOME: home,
      XDG_CACHE_HOME: home,
      XDG_DATA_HOME: home,
    },
    stderr: "ignore",
  });
  await rm(home, { recursive: true, force: true });
  return probe.exitCode === 0;
};

/**
 * A PowerShell pane, through the controller.
 *
 * PowerShell has no preexec hook, so this is where the integration is either real or
 * not: the command line comes from `PSConsoleHostReadLine`'s return value, and that only
 * runs once PSReadLine is the reader. Two things have to hold for it to fire at all —
 * the pane is started with `-Interactive` (otherwise PSReadLine is not the reader), and
 * the pty bridge answers the cursor-position query PSReadLine sends on start before it
 * draws anything.
 *
 * Input is `\r`, not `\n`: PSReadLine reads raw bytes and in raw mode Enter is CR.
 *
 * The writable HOME is a harness concession for this sandbox, not something the product
 * needs from a real user. It is set on `process.env` because the child's environment is
 * a copy of it, and restored afterwards.
 */
test("a PowerShell pane reports commands and exit codes", async () => {
  if (!(await havePwsh())) {
    console.warn(`skipped: no runnable pwsh at ${pwshPath}`);
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "natalia-pwsh-e2e-"));
  const xdg = join(root, "xdg");
  await mkdir(xdg, { recursive: true });
  const saved = {
    HOME: process.env.HOME,
    XDG_CACHE_HOME: process.env.XDG_CACHE_HOME,
    XDG_DATA_HOME: process.env.XDG_DATA_HOME,
  };
  process.env.HOME = xdg;
  process.env.XDG_CACHE_HOME = xdg;
  process.env.XDG_DATA_HOME = xdg;
  const controller = createPtyTerminalController({
    workspaceRoot: root,
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => undefined,
    windowMode: () => "windowless",
  });
  try {
    await controller.start({
      // The pwsh PATH, not the word: the spawn spec execs its first argv element as
      // given, and a bare `pwsh` is not on PATH here. That failed as "terminal session
      // has exited", naming nothing.
      command: pwshPath,
      cwd: root,
      id: "term_pwsh",
    });
    // Let pwsh finish starting up before typing. PSReadLine loads and the first prompt
    // draws some way in, and input written before that lands nowhere.
    await Bun.sleep(3000);
    const lastCommand = controller.lastCommand?.bind(controller);
    expect(typeof lastCommand).toBe("function");
    if (!lastCommand) throw new Error("unreachable: asserted above");

    controller.write("term_pwsh", "echo pwsh-command-level\r");
    // The command state arrives with the shell-integration markers, which on a
    // loaded runner land later than the startup window — CI measured the same
    // test passing on windows-terminal at 7756ms and failing on Ubuntu at
    // 10492ms with `commandLine: undefined`, because a fixed 4s sleep ran out
    // while the markers were still in flight. A bounded wait keeps the test
    // honest about WHAT it waits for (the command state) instead of how long.
    let command: ReturnType<typeof lastCommand> | undefined;
    for (let waited = 0; waited < 20_000; waited += 100) {
      command = lastCommand("term_pwsh");
      if (
        command?.commandLine === "echo pwsh-command-level" &&
        command?.exitCode === 0
      )
        break;
      await Bun.sleep(100);
    }
    expect(command?.commandLine).toBe("echo pwsh-command-level");
    expect(command?.exitCode).toBe(0);
    expect(command?.output).toContain("pwsh-command-level");

    // One command, then exit -- the shape this was verified in. A second command
    // written straight after the first found the session gone ("terminal session
    // has exited"), and pinning that down is separate work; what is pinned here is
    // that a pwsh command's line, code and output reach the reader at all.
    controller.write("term_pwsh", "exit\r");
    await Bun.sleep(500);
  } finally {
    process.env.HOME = saved.HOME;
    process.env.XDG_CACHE_HOME = saved.XDG_CACHE_HOME;
    process.env.XDG_DATA_HOME = saved.XDG_DATA_HOME;
    await controller.close().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}, 45_000);

test("the pwsh spawn spec is interactive and dot-sources the script", () => {
  const { argv, env } = nativeTerminalPaneSpawn("pwsh", "linux");
  // -Interactive is load-bearing: without it PSReadLine is not the reader, the command
  // line comes back empty, and nothing about the argv looks wrong.
  expect(argv).toContain("-Interactive");
  expect(argv).toContain("-NoExit");
  const command = argv[argv.indexOf("-Command") + 1] ?? "";
  expect(command.startsWith(". '")).toBe(true);
  expect(command).toContain("shell-integration-pwsh.ps1");
  // Unlike zsh there is no rc directory to point at: the script is dot-sourced on the
  // command line.
  expect(env).toEqual({});
});
