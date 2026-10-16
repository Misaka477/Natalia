/**
 * The pane's default shell is decided in ONE place, and on Windows that place
 * answers pwsh.
 *
 * The defect this pins: the terminal panel carried a shell `<select>` whose
 * options were POSIX-first (bash, zsh, sh, pwsh, powershell) and whose bound
 * value started empty — and a native `<select>` normalises an unmatched value
 * to its FIRST option, so the panel sent `command=bash` for every pane. On
 * Windows the host had resolved pwsh correctly and was overridden by its own
 * UI.
 *
 * Two guards here:
 *
 *   * behaviour — the platform's discovery answers pwsh on a Windows host even
 *     when the environment defines a POSIX `SHELL` (Git for Windows does),
 *     which is also why the transport route must not invent its own chain;
 *   * wiring — the panel no longer chooses a shell, and the route no longer
 *     builds a default of its own.
 *
 * Wiring is asserted from the sources because there is no DOM harness here, and
 * a pane's shell is a spawn decision, not a render one.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { discoverDefaultShell, shellInvocation } from "@anthelia/platform";
import { integratedShellArgv } from "../src/shell-integration-argv";

const root = join(import.meta.dir, "..", "..", "..", "..");
const source = (relative: string) => readFileSync(join(root, relative), "utf8");

test("a Windows host answers pwsh, whatever SHELL says", () => {
  // `SHELL` is not a Windows convention; a pane that inherits it from a shell
  // that happens to have one (Git for Windows, MSYS, a CI job) must still get
  // the shell this OS always has. The environment is spelled out and the finder
  // is injected so this answer is the platform's, not this machine's.
  const probed: string[] = [];
  const windows = discoverDefaultShell({
    os: "win32",
    env: { SHELL: "bash", ProgramFiles: "C:\\Program Files", PATH: "" },
    exists: (path) => {
      probed.push(path);
      return path.toLowerCase().endsWith("pwsh.exe");
    },
  });
  expect(windows?.name).toBe("pwsh");
  // PowerShell 7 where it is installed; the OS's own 5.1 otherwise — which is
  // the finder's own order, and never a bash.
  expect(probed[0]?.toLowerCase()).toContain("powershell\\7\\pwsh.exe");
  expect(windows?.path?.toLowerCase()).toContain("pwsh.exe");

  // And the invocation the pane runs needs no POSIX flags — for a shell named
  // by path, and for one the PATH has to place.
  for (const shell of [
    windows ?? { name: "pwsh" as const },
    { name: "pwsh" as const },
  ]) {
    const invocation = shellInvocation("Get-Date", { shell });
    expect(invocation.executable.toLowerCase()).toContain("pwsh");
    expect(invocation.args).toEqual([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      "Get-Date",
    ]);
  }
});

test("a POSIX host answers bash or zsh, never pwsh", () => {
  const linux = discoverDefaultShell({
    os: "linux",
    env: { SHELL: "/bin/bash" },
    exists: (path) => path === "/bin/bash" || path === "/usr/bin/bash",
  });
  expect(["bash", "zsh"]).toContain(linux?.name ?? "");
  const mac = discoverDefaultShell({
    os: "darwin",
    env: {},
    exists: (path) => path === "/bin/zsh",
  });
  expect(["bash", "zsh"]).toContain(mac?.name ?? "");
});

test("the integration argv is built for the PowerShell it actually got", () => {
  // The defect this pins, seen on the user's machine: the pane resolved to
  // Windows PowerShell 5.1 (a per-user pwsh 7 install was not on the runtime's
  // PATH) and the argv handed it `-Interactive`, which is a pwsh-7-only switch.
  // 5.1 answers "-Interactive : The term '-Interactive' is not recognized …
  // CommandNotFoundException", so the pane opened unusable. 5.1 is a REACHABLE
  // answer by design — it is the resolver's documented last resort — so the argv
  // has to suit whichever shell was resolved.
  const fiveOne = integratedShellArgv(
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  );
  expect(fiveOne?.argv.slice(1, 4)).toEqual(["-NoLogo", "-NoExit", "-Command"]);
  expect(fiveOne?.argv).not.toContain("-Interactive");
  // The integration script is still dot-sourced, so a 5.1 pane keeps everything
  // short of the pwsh-7-only switch.
  expect(fiveOne?.argv.at(-1)).toContain("shell-integration-pwsh.ps1");

  // pwsh 7 keeps the switch the read-line override needs: without it the pane's
  // command line arrives empty (measured).
  const seven = integratedShellArgv(
    "C:\\Users\\demo\\AppData\\Local\\Programs\\PowerShell\\7\\pwsh.exe",
  );
  expect(seven?.argv.slice(1, 5)).toEqual([
    "-NoLogo",
    "-NoExit",
    "-Interactive",
    "-Command",
  ]);
});

/**
 * The source with `//` comment lines removed: these guards are about the CODE,
 * and the comments deliberately name what was removed.
 */
const code = (relative: string) =>
  source(relative).replace(/^\s*\/\/.*$/gmu, "");

test("the terminal panel does not choose a shell", () => {
  const panel = code(
    "packages/plugins/native-terminal/src/ui/terminal-panel.tsx",
  );
  // No shell picker at all, and no `command` handed to the pane's socket.
  expect(panel).not.toContain("<select");
  expect(panel).not.toContain("command={shellProfile()}");
  expect(panel).not.toContain("shellProfile");
  // The pane component has no command prop to pass either.
  const terminal = code(
    "packages/plugins/native-terminal/src/ui/web-terminal.tsx",
  );
  expect(terminal).not.toContain("command?: string");
  expect(terminal).not.toContain('searchParams.set("command"');
});

test("the transport route starts a pane without inventing a shell", () => {
  const route = code("packages/hosts/transport/src/terminal-ws.ts");
  // The chain that produced `bash` on Windows: it read the environment and
  // second-guessed the platform's discovery.
  expect(route).not.toContain("process.env.SHELL");
  expect(route).not.toContain('"pwsh" : "bash"');
  expect(route).toContain("const requested = ws.data.command?.trim();");
});
