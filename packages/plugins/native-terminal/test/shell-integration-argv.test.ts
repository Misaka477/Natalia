import { describe, expect, test } from "bun:test";
import { nativeTerminalPaneCommand } from "../src/native-terminal";
import {
  integratedShellArgv,
  withShellIntegration,
} from "../src/shell-integration-argv";

/**
 * The pane's argv.
 *
 * `nativeTerminalPaneCommand` is a pinned contract — its callers and the bundle
 * pins assert on the exact argv — so the integration has to change what it does
 * WITHOUT changing what a caller passes. These tests hold both halves: the
 * contract still pins, and an interactive shell now arrives with its script.
 */

describe("withShellIntegration", () => {
  test("an interactive bash arrives with the rcfile", () => {
    const argv = withShellIntegration(["/usr/bin/bash"]);
    expect(argv[0]).toBe("/usr/bin/bash");
    expect(argv[1]).toBe("--rcfile");
    expect(argv[2]).toBe("shell-integration-bash.sh");
  });

  test("a caller's own arguments survive, so -l still reads the profile", () => {
    const argv = withShellIntegration(["/usr/bin/bash", "-l"]);
    expect(argv).toEqual([
      "/usr/bin/bash",
      "--rcfile",
      "shell-integration-bash.sh",
      "-l",
    ]);
  });

  test("a pane running a command is not given a shell integration", () => {
    // The command's output IS the answer here; markers would only let a reader
    // mistake the command's stdout for a pane's.
    const argv = withShellIntegration(["/bin/sh", "-lc", "mkfs.ext4 /dev/sda"]);
    expect(argv).toEqual(["/bin/sh", "-lc", "mkfs.ext4 /dev/sda"]);
  });

  test("an unsupported shell is passed through untouched, not guessed at", () => {
    // zsh has no verified script yet. Passing it through means no markers, which
    // the reader reports honestly as "this pane cannot tell you" — better than a
    // script that has never run.
    expect(withShellIntegration(["/usr/bin/zsh"])).toEqual(["/usr/bin/zsh"]);
    expect(withShellIntegration(["/usr/bin/fish"])).toEqual(["/usr/bin/fish"]);
  });

  test("an empty argv is not turned into a shell", () => {
    expect(withShellIntegration([])).toEqual([]);
  });
});

describe("integratedShellArgv", () => {
  test("only the verified shell has an entry", () => {
    expect(integratedShellArgv("/usr/bin/bash")).toBeDefined();
    expect(integratedShellArgv("/usr/bin/zsh")).toBeUndefined();
  });

  test("a Windows spelling does not match the POSIX entry", () => {
    // `bash.exe` is not the bash this script was written for, and loading a POSIX
    // rcfile into it would be worse than nothing.
    expect(
      integratedShellArgv("C:\\Windows\\System32\\bash.exe"),
    ).toBeUndefined();
  });
});

describe("the pinned pane contract", () => {
  test("a command pane's argv is unchanged by the integration", () => {
    // The contract its callers and the bundle pins assert on.
    const argv = nativeTerminalPaneCommand("sh -lc 'echo hi'", "linux");
    expect(argv[0]).toBe("/bin/sh");
    expect(argv).toEqual(["/bin/sh", "-lc", "sh -lc 'echo hi'"]);
  });

  test("an interactive bash pane now carries the integration", () => {
    const argv = nativeTerminalPaneCommand("bash", "linux");
    expect(argv[0]).toBe("/bin/bash");
    expect(argv).toContain("--rcfile");
    expect(argv).toContain("shell-integration-bash.sh");
  });
});
