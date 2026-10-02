import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@anthelia/plugin";
import { createToolRegistry, timeoutSecOr } from "@anthelia/tools";
import {
  createShellPlugin,
  SHELL_PLUGIN_ID,
  shellToolFamily,
  shellTools,
  runShell,
} from "../src";

test("the shell family describes the tool it ships", () => {
  const family = shellToolFamily();
  expect(family.id).toBe("shell");
  expect(family.scope).toBe("session");
  expect(family.tools).toEqual(shellTools);
});

test("the shell plugin owns run_shell and unloads cleanly", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(createShellPlugin());
  expect(registry.list()[0]).toMatchObject({
    id: SHELL_PLUGIN_ID,
    scope: "session",
  });
  expect(tools.has("run_shell")).toBe(true);
  await registry.unload(SHELL_PLUGIN_ID);
  expect(tools.has("run_shell")).toBe(false);
});

test("run_shell exposes a bounded per-call timeout", () => {
  const tool = shellToolFamily().tools.find(
    (candidate) => candidate.name === "run_shell",
  )!;
  expect(tool.timeoutSec).toBe(120);
  expect(tool.maxTimeoutSec).toBe(1800);
  expect(tool.parameters.properties.timeoutSec).toMatchObject({
    type: "number",
  });
  expect(timeoutSecOr(300, 120, 1800)).toBe(300);
  expect(timeoutSecOr(9999, 120, 1800)).toBe(1800);
  expect(timeoutSecOr(-1, 120, 1800)).toBe(120);
});

// runShell executes through a profile-sourcing shell so tool commands see the
// user's environment. On a machine whose profile sources conda/nvm, that
// startup costs seconds by itself and exceeds a 10s budget under the suite's
// concurrency — while the command under test is a printf. These tests assert
// output, not latency, so the timeout only needs to cover profile startup.
const runShellTimeoutSec = 60;

test("run_shell runs a command inside the workspace and reports exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-shell-"));
  const result = await runShell(
    "printf 'out'; printf 'err' >&2; exit 0",
    { workspaceRoot: root, settings: {} } as never,
    runShellTimeoutSec,
  );
  expect(result).toContain("exit=0");
  expect(result).toContain("stdout:\nout");
  expect(result).toContain("stderr:\nerr");
});

test("run_shell rejects on a failing command with its output", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-shell-"));
  await expect(
    runShell(
      "exit 3",
      { workspaceRoot: root, settings: {} } as never,
      runShellTimeoutSec,
    ),
  ).rejects.toThrow(/exit=3/u);
});

test("run_shell projects a terminal card from its output definition", () => {
  const tool = shellToolFamily().tools.find(
    (candidate) => candidate.name === "run_shell",
  )!;
  const intent = tool.output?.presentResult?.(
    { command: "make build" },
    "exit=0\nstdout:\nbuilt ok\nstderr:\nwarn",
  );
  expect(intent).toMatchObject({
    kind: "terminal",
    title: "make build",
    summary: "exit 0",
    meta: [["exit", "0"]],
  });
  expect(intent?.body).toContain("built ok");
});
