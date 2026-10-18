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

// The command under test is spelled for the HOST's own shell (the executor
// picks it per platform): `printf` and `>&2` are not PowerShell, and a
// fixture that forgot the platform parsed as an error the moment the
// command actually ran on Windows.
const echoBothStreams =
  process.platform === "win32"
    ? `[Console]::Out.Write("out"); [Console]::Error.Write("err"); exit 0`
    : `printf 'out'; printf 'err' >&2; exit 0`;

test("run_shell runs a command inside the workspace and reports exit", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-shell-"));
  const result = await runShell(
    echoBothStreams,
    { workspaceRoot: root, settings: {} } as never,
    runShellTimeoutSec,
  );
  expect(result).toContain("exit=0");
  expect(result).toContain("stdout:\nout");
  expect(result).toContain("stderr:\nerr");
});

test("a failing command is its answer, not a rejected call", async () => {
  // A non-zero exit is what the command REPORTED: the exit status and the
  // output come back as one value. It used to throw, which turned "the tests
  // are red" into an error string (the caller could only recover the code by
  // matching prose) and sent the call down the failure path, which published
  // the text unredacted and unbounded.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-shell-"));
  const result = await runShell(
    "exit 3",
    { workspaceRoot: root, settings: {} } as never,
    runShellTimeoutSec,
  );
  expect(result).toContain("exit=3");
});

test("run_shell projects a terminal card from its output definition", () => {
  const tool = shellToolFamily().tools.find(
    (candidate) => candidate.name === "run_shell",
  )!;
  const intent = tool.output?.presentResult?.(
    { command: "make build", description: "Build the workspace" },
    "exit=0\nstdout:\nbuilt ok\nstderr:\nwarn",
  );
  expect(intent).toMatchObject({
    kind: "terminal",
    // The model's sentence survives the completed state: the exit status is a
    // pill, and letting it evict the label cost the row its only human-facing
    // text the moment the command finished.
    title: "make build",
    summary: "Build the workspace",
    meta: [["exit", "0"]],
  });
  expect(intent?.body).toContain("built ok");
  // A caller with no description still projects a readable card rather than
  // the literal "undefined".
  const bare = tool.output?.presentResult?.(
    { command: "make build" },
    "exit=0\nstdout:\nbuilt ok",
  );
  expect(bare).toMatchObject({ summary: "shell command" });
  // And a non-zero exit is the pill's job to say, not the summary's.
  const failed = tool.output?.presentResult?.(
    { command: "make build", description: "Build the workspace" },
    "exit=3\nstdout:\nerr\nstderr:\nboom",
  );
  expect(failed).toMatchObject({
    summary: "Build the workspace",
    meta: [["exit", "3"]],
  });
});

/**
 * `run_in_background`: the model asks for a hand-off, and gets a HANDLE.
 *
 * The 2026-10-18 gap: `process_start` already had the whole background
 * machinery (handle, output file, settlement notice, tree kill, session
 * ownership), but the tool a model reaches for first — `run_shell` — only ran
 * things in the foreground, so "start the dev server and then keep working" had
 * no answer that did not cost a guessed timeout. The answer is a typed handle
 * rather than an id the model has to dig out of JSON, because the next call
 * (`process_output`, `process_wait`, `process_stop`) takes that id.
 */
test("run_in_background hands the command to the process registry and answers a handle", async () => {
  const started: Array<{ command: string }> = [];
  const tool = shellToolFamily(() => ({
    async start(command: string) {
      started.push({ command });
      return { id: "proc_3", pid: 4242, status: "running" };
    },
  })).tools.find((candidate) => candidate.name === "run_shell")!;
  const answer = String(
    await tool.execute(
      {
        command: "npm run dev",
        description: "Start the dev server",
        run_in_background: true,
      },
      { workspaceRoot: "/ws", settings: {} } as never,
    ),
  );
  // The command went to the registry, in the foreground path's place.
  expect(started).toEqual([{ command: "npm run dev" }]);
  const handle = JSON.parse(answer) as Record<string, unknown>;
  expect(handle).toMatchObject({
    kind: "background",
    jobId: "proc_3",
    command: "npm run dev",
  });
  expect(String(handle.note)).toContain("process_output");
  expect(String(handle.note)).toContain("proc_3");
  // The card says it is running in the background — NOT an empty terminal card
  // that reads as "the command printed nothing".
  const intent = tool.output?.presentResult?.(
    { command: "npm run dev", description: "Start the dev server" },
    answer,
  );
  expect(intent).toMatchObject({
    kind: "generic",
    title: "npm run dev",
    summary: "running in the background as proc_3",
    meta: [["background", "proc_3"]],
  });
});

test("run_in_background without the process registry refuses instead of running in the foreground", async () => {
  // No background port: the honest answer is a refusal naming what is missing.
  // Silently running it in the foreground would kill the command at the
  // timeout the model never set, and report it as an ordinary failure.
  const tool = shellToolFamily().tools.find(
    (candidate) => candidate.name === "run_shell",
  )!;
  await expect(
    tool.execute(
      {
        command: "npm run dev",
        description: "Start the dev server",
        run_in_background: true,
      },
      { workspaceRoot: "/ws", settings: {} } as never,
    ),
  ).rejects.toThrow(/managed-process registry/u);
});
