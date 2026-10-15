/**
 * The shell name a pane's command line is shown as.
 *
 * The runtime reports the pane's command as whatever it spawned — a Windows
 * path with spaces in it, a POSIX absolute path, or a bare name with
 * flags. The select lists shell NAMES, so the panel reconciles the two here
 * rather than in a renderer: a guess from `navigator.platform` would be a
 * second source of truth for the same fact.
 */
import { expect, test } from "bun:test";
import { shortShellName } from "../src/ui/shell-name";

test("a Windows path keeps its last segment, spaces included", () => {
  expect(shortShellName("C:\\Program Files\\PowerShell\\7\\pwsh.exe")).toBe(
    "pwsh",
  );
  expect(
    shortShellName(
      "C:\\Windows\\System32\\WindowsPowerShell\\v1.0\\powershell.exe",
    ),
  ).toBe("powershell");
  expect(shortShellName("D:\\Software_Development\\Git\\bin\\bash.exe")).toBe(
    "bash",
  );
});

test("a POSIX path and a bare name both read as their shell", () => {
  expect(shortShellName("/bin/zsh")).toBe("zsh");
  expect(shortShellName("/usr/bin/bash")).toBe("bash");
  expect(shortShellName("bash")).toBe("bash");
  // Flags after the shell are not part of its name — a pane started as
  // `bash -l` still shows as bash.
  expect(shortShellName("bash -l")).toBe("bash");
});

test("a blank command shows nothing rather than inventing a shell", () => {
  expect(shortShellName("")).toBe("");
  expect(shortShellName("   ")).toBe("");
});

test("the panel shows the runtime's answer and offers the shells by name", () => {
  const panel = require("node:fs").readFileSync(
    require("node:path").join(
      __dirname,
      "..",
      "src",
      "ui",
      "terminal-panel.tsx",
    ),
    "utf8",
  ) as string;
  // The value is synced from the session the runtime reports...
  expect(panel.match(/syncShellFromSessions\(/gu)?.length).toBe(2);
  expect(panel).toContain("setShellProfile(shortShellName(withShell.command))");
  // ...and the names the platform can produce are all offered.
  for (const name of ["bash", "zsh", "sh", "pwsh", "powershell"]) {
    expect(panel).toContain(`<option value="${name}">`);
  }
});
