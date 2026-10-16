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

const root = join(import.meta.dir, "..", "..", "..", "..");
const source = (relative: string) => readFileSync(join(root, relative), "utf8");

test("a Windows host answers pwsh, whatever SHELL says", () => {
  // `SHELL` is not a Windows convention; a pane that inherits it from a shell
  // that happens to have one (Git for Windows, MSYS, a CI job) must still get
  // the shell this OS always has.
  const windows = discoverDefaultShell({
    os: "win32",
    env: { SHELL: "bash" },
    // PowerShell 7 where it is installed; the OS's own 5.1 otherwise, which is
    // the finder's own order.
    exists: (path) => path.toLowerCase().endsWith("pwsh.exe"),
  });
  expect(windows?.name).toBe("pwsh");

  // And the invocation the pane runs needs no POSIX flags.
  const invocation = shellInvocation("Get-Date", {
    os: "win32",
    exists: (path) => path.toLowerCase().endsWith("pwsh.exe"),
  });
  expect(invocation?.executable.toLowerCase()).toContain("pwsh.exe");
  expect(invocation?.args).not.toContain("-lc");
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
