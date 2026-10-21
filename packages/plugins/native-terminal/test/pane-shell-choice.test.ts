/**
 * A pane starts the shell the runtime is configured for.
 *
 * The terminal plugin runs in its OWN process, so the runtime's
 * `setConfiguredShell` slot is not visible to it — a pane opened after a
 * settings-panel switch kept starting the platform default (measured: pwsh on
 * Windows after the human chose bash). The `shellName` getter on the terminal
 * input is the bridge, and `nativeTerminalPaneCommand`'s third parameter is
 * where it lands.
 *
 * These pin the wiring, not the shell logic: `selectExecutor` has its own
 * tests for what a name means.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { paneStartCommand } from "../src/pane-command";

// test -> native-terminal -> plugins -> packages -> repo root
const repoRoot = join(import.meta.dir, "..", "..", "..", "..");

function source(relative: string): string {
  return readFileSync(join(repoRoot, relative), "utf8");
}

test("the runtime publishes its shell choice to the terminal input", () => {
  const services = source(
    "packages/framework/client/src/runtime/initialize/framework-services.ts",
  );
  expect(services).toContain("shellName: () => configuredShellName()");
  // And the import that makes it available.
  expect(services).toContain(
    'import { configuredShellName } from "@anthelia/shell"',
  );
});

test("the controller passes the choice to the pane command", () => {
  const controller = source(
    "packages/plugins/native-terminal/src/pty-terminal-controller.ts",
  );
  expect(controller).toContain("input.shellName?.()");
});

test("the pane command accepts and forwards the choice", () => {
  const pane = source("packages/plugins/native-terminal/src/pane-command.ts");
  // Both entry points take it, and `shellFor` hands it to the executor seam.
  expect(pane).toContain('configured?: "bash" | "pwsh" | "zsh"');
  expect(pane).toContain("shellFor(os, configured)");
  expect(pane).toContain("nativeTerminalPaneCommand(command, os, configured)");
});

test("the terminal input contract declares the getter", () => {
  const services = source("packages/core/runtime-services/src/services.ts");
  expect(services).toContain("shellName?():");
});

test("the configured shell IS the default pane command, ahead of platform discovery", () => {
  // The wiring pin above passes either way — `input.shellName?.()` was in the
  // controller all along and the pane still started pwsh. Platform discovery
  // answers pwsh on Windows unconditionally and `interactiveShellArgv` takes
  // a shell-named command verbatim, so the default command itself has to BE
  // the configured shell. Measured on this host: the settings row says bash,
  // the pane prompt says PS.
  expect(paneStartCommand(undefined, "bash", "pwsh")).toBe("bash");
  // A whitespace-only request is no request.
  expect(paneStartCommand("   ", "bash", "pwsh")).toBe("bash");
  // The caller's own command still wins over every default.
  expect(paneStartCommand("ls -la", "bash", "pwsh")).toBe("ls -la");
  // 自动 (no choice) and a host that discovered nothing keep the old order.
  expect(paneStartCommand(undefined, undefined, "pwsh")).toBe("pwsh");
  expect(paneStartCommand(undefined, "bash", undefined)).toBe("bash");
  // And the controller actually routes its default through it.
  const controller = source(
    "packages/plugins/native-terminal/src/pty-terminal-controller.ts",
  );
  expect(controller).toContain("paneStartCommand(");
});
