import { describe, expect, test } from "bun:test";
import { basename } from "node:path";
import { nativeTerminalPaneCommand } from "../src/pane-command";
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
  test("an interactive bash arrives with an ABSOLUTE rcfile path", () => {
    // Absolute, because a pane spawns in the operator's workspace and a relative
    // script name would resolve there — silently not loading the integration.
    const { argv } = withShellIntegration(["/usr/bin/bash"]);
    expect(argv[0]).toBe("/usr/bin/bash");
    expect(argv[1]).toBe("--rcfile");
    expect(argv[2]!.startsWith("/") || /^[A-Za-z]:[\\/]/.test(argv[2]!)).toBe(
      true,
    );
    expect(basename(argv[2]!)).toBe("shell-integration-bash.sh");
  });

  test("a caller's own arguments survive, so -l still reads the profile", () => {
    const { argv } = withShellIntegration(["/usr/bin/bash", "-l"]);
    expect(argv[0]).toBe("/usr/bin/bash");
    expect(argv[1]).toBe("--rcfile");
    expect(basename(argv[2]!)).toBe("shell-integration-bash.sh");
    // The caller's own argument survives.
    expect(argv[3]).toBe("-l");
  });

  test("a pane running a command is not given a shell integration", () => {
    // The command's output IS the answer here; markers would only let a reader
    // mistake the command's stdout for a pane's.
    const { argv, env } = withShellIntegration([
      "/bin/sh",
      "-lc",
      "mkfs.ext4 /dev/sda",
    ]);
    expect(argv).toEqual(["/bin/sh", "-lc", "mkfs.ext4 /dev/sda"]);
    expect(env).toEqual({});
  });

  test("zsh is integrated through the environment, because it has no --rcfile", () => {
    // The whole point of the split. zsh reads `$ZDOTDIR/.zshrc`, so the rc cannot
    // ride the argv; a pane given only `["zsh"]` would start and silently carry no
    // integration, which is what the first version did.
    const { argv, env } = withShellIntegration(["/usr/bin/zsh"]);
    expect(argv).toEqual(["/usr/bin/zsh"]);
    // Absolute, for the same reason as bash's rcfile: a pane spawns in the
    // operator's workspace, and a relative ZDOTDIR would look there.
    expect(
      env.ZDOTDIR!.startsWith("/") || /^[A-Za-z]:[\\/]/.test(env.ZDOTDIR!),
    ).toBe(true);
    // A per-process directory under the temp dir, NOT beside the package. Written
    // there and generated fresh, because its content is a path: one baked beside a
    // source checkout is wrong the moment the package is installed elsewhere, which
    // is what the first version shipped.
    expect(env.ZDOTDIR!).toContain("natalia-zsh-rc-");
    expect(env.ZDOTDIR).not.toContain("packages");
    expect(env.ZDOTDIR).not.toContain("native-terminal");
    // And the environment is not the pane's whole environment: it is only this,
    // so the operator's PATH and HOME still reach the child.
    expect(Object.keys(env)).toEqual(["ZDOTDIR"]);
  });

  test("an unsupported shell is passed through untouched, not guessed at", () => {
    // No verified script yet. Passing it through means no markers, which the
    // reader reports honestly as "this pane cannot tell you" — better than a
    // script that has never run.
    expect(withShellIntegration(["/usr/bin/fish"])).toEqual({
      argv: ["/usr/bin/fish"],
      env: {},
    });
  });

  test("an empty argv is not turned into a shell", () => {
    expect(withShellIntegration([])).toEqual({ argv: [], env: {} });
  });
});

describe("integratedShellArgv", () => {
  test("a shell has an entry only once it has been run", () => {
    // All three were driven end to end — a real shell in a pty, emitting the markers in
    // the order the parser expects, exit codes included. `fish` has not been run
    // anywhere, so it has no entry: adding one on the strength of a script that was
    // never executed is how an unverified path ships.
    expect(integratedShellArgv("/usr/bin/bash")).toBeDefined();
    expect(integratedShellArgv("/usr/bin/zsh")).toBeDefined();
    expect(integratedShellArgv("/usr/bin/pwsh")).toBeDefined();
    expect(integratedShellArgv("/usr/bin/fish")).toBeUndefined();
  });

  test("a Windows spelling matches its own entry, not the POSIX one", () => {
    // `bash.exe` is the WSL bash, not the bash this script was written for — the
    // mapping is by basename, so a Windows path resolves the same entry. That is
    // intended: the entry decides the script, and a WSL pane is a real pane.
    const integrated = integratedShellArgv("C:\\Windows\\System32\\bash.exe");
    expect(integrated).toBeDefined();
    expect(integrated!.argv[0]).toBe("C:\\Windows\\System32\\bash.exe");
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
    // The spelling is the shell seam's: POSIX resolves the name, and the
    // integration rides whichever absolute path came back.
    expect(argv[0]).toBe("bash");
    expect(argv).toContain("--rcfile");
    expect(basename(argv[2]!)).toBe("shell-integration-bash.sh");
  });
});
