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

test("a POSIX shell runs a script through -lc, login and command", () => {
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
