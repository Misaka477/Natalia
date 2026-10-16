/**
 * The shell this host is guaranteed to have, and how a script reaches it.
 *
 * The rule behind both: what the OS ships is what runs. Windows always has
 * PowerShell (7 where installed, the OS's own 5.1 otherwise), Linux always
 * has bash, macOS has zsh as the user shell and bash beside it. A pane that
 * defaulted to "bash" on Windows was depending on an optional install — Git
 * for Windows, deliberately not on PATH by default.
 */
import { expect, test } from "bun:test";
import { discoverDefaultShell, shellInvocation } from "../src/shell-discovery";

test("windows resolves PowerShell, in the finder's own order", () => {
  const found = discoverDefaultShell({ os: "win32" });
  expect(found?.name).toBe("pwsh");
});

test("the Windows branch probes the well-known roots, then the PATH", () => {
  // The injected finder is what makes this branch answerable off Windows; the
  // env is spelled out so the candidates are this host's, not the machine's.
  const env = {
    ProgramFiles: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local",
    SystemRoot: "C:\\Windows",
    PATH: "D:\\tools",
  };
  const seven = discoverDefaultShell({
    os: "win32",
    env,
    exists: (path) => path.toLowerCase().endsWith("pwsh.exe"),
  });
  // PowerShell 7 first, and the answer carries the win32 path it found.
  expect(seven).toEqual({
    name: "pwsh",
    path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  });

  // The whole candidate list, in order: the machine-wide 7, the PER-USER 7 (the
  // MSI's default scope, which no machine-wide list can see), the PATH, then the
  // OS's own 5.1.
  const order: string[] = [];
  discoverDefaultShell({
    os: "win32",
    env,
    exists: (path) => {
      order.push(path);
      return false;
    },
  });
  expect(order).toEqual([
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
    "C:\\Users\\demo\\AppData\\Local\\Programs\\PowerShell\\7\\pwsh.exe",
    "D:\\tools\\pwsh.exe",
    "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  ]);

  // A host whose only PowerShell 7 is the per-user install finds it: measured on
  // this machine, where the pane resolved to 5.1 for exactly this reason.
  const perUser = discoverDefaultShell({
    os: "win32",
    env,
    exists: (path) => path.startsWith("C:\\Users\\demo\\AppData\\Local"),
  });
  expect(perUser).toEqual({
    name: "pwsh",
    path: "C:\\Users\\demo\\AppData\\Local\\Programs\\PowerShell\\7\\pwsh.exe",
  });

  // A host without PowerShell 7 still has the OS's own 5.1 — never no shell.
  const fiveOne = discoverDefaultShell({
    os: "win32",
    env,
    exists: (path) => path.toLowerCase().endsWith("powershell.exe"),
  });
  expect(fiveOne).toEqual({
    name: "pwsh",
    path: "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
  });

  // Nothing found at all is still pwsh: a name, not a path, so CreateProcess
  // resolves it off the PATH.
  const bare = discoverDefaultShell({
    os: "win32",
    env,
    exists: () => false,
  });
  expect(bare).toEqual({ name: "pwsh" });
});

test("the powershell invocation is the reference spelling", () => {
  const invocation = shellInvocation("Write-Output hi", {
    os: "win32",
    shell: { name: "pwsh", path: "C:\\Program Files\\PowerShell\\7\\pwsh.exe" },
  });
  expect(invocation.executable).toBe(
    "C:\\Program Files\\PowerShell\\7\\pwsh.exe",
  );
  expect(invocation.args).toEqual([
    "-NoLogo",
    "-NoProfile",
    "-NonInteractive",
    "-Command",
    "Write-Output hi",
  ]);
});

test("linux is bash and macOS is zsh, both found by the file existing", () => {
  const linux = discoverDefaultShell({
    os: "linux",
    exists: (path) => path === "/bin/bash",
  });
  expect(linux).toEqual({ name: "bash", path: "/bin/bash" });

  const macosWithZsh = discoverDefaultShell({
    os: "darwin",
    exists: (path) => path === "/bin/zsh",
  });
  expect(macosWithZsh).toEqual({ name: "zsh", path: "/bin/zsh" });

  // macOS without zsh still has bash — the platform guarantees one of the two.
  const macosWithoutZsh = discoverDefaultShell({
    os: "darwin",
    exists: (path) => path === "/bin/bash",
  });
  expect(macosWithZsh?.name).toBe("zsh");
  expect(macosWithoutZsh).toEqual({ name: "bash", path: "/bin/bash" });
});

test("a POSIX shell runs a script through -lc, profile and command", () => {
  const invocation = shellInvocation("echo hi", {
    os: "linux",
    exists: (path) => path === "/usr/bin/bash",
  });
  expect(invocation.executable).toBe("/usr/bin/bash");
  expect(invocation.args).toEqual(["-lc", "echo hi"]);
});

test("a host with no shell says so instead of inventing one", () => {
  expect(
    discoverDefaultShell({ os: "linux", exists: () => false }),
  ).toBeUndefined();
  expect(() =>
    shellInvocation("true", { os: "linux", exists: () => false }),
  ).toThrow(/no usable shell was discovered/u);
});
