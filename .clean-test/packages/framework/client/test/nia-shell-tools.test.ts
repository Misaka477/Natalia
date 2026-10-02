import { expect, test } from "bun:test";
import type { RuntimeTool } from "@anthelia/tools";
import type { RuntimeContext } from "@anthelia/substrate";
import { createChatTools } from "@natalia/collab";

function tool(name: string): RuntimeTool {
  return {
    name,
    description: name,
    requiresApproval: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute() {
      return "ok";
    },
  };
}

test("both collaborators expose run_shell for verification (Nia's discipline, Navi's advisor hat)", () => {
  const readFile = tool("read_file");
  const runShell = tool("run_shell");
  const ctx = {
    state: {
      tools: new Map([
        [readFile.name, readFile],
        [runShell.name, runShell],
      ]),
    },
    ports: {
      getActiveExec: () => undefined,
      currentSessionSnapshot: () => undefined,
      createCollabChatTool: () => tool("collab_chat"),
    },
  } as unknown as RuntimeContext;
  const chatTools = createChatTools(ctx);
  expect(chatTools.niaChatTools().map((item) => item.name)).toContain(
    "run_shell",
  );
  // The 2026-09-25 change: Navi may run verification commands too — the
  // advisor needs to check facts (run tests, read state), and the same
  // deny-by-default policy plus her prompt's verification-only discipline
  // is the guard. The old assertion pinned Navi WITHOUT a shell.
  expect(chatTools.naviChatTools().map((item) => item.name)).toContain(
    "run_shell",
  );
});

test("Navi's run_shell wrapper enforces the same read-only policy", async () => {
  const runShell = tool("run_shell");
  let executed = 0;
  runShell.execute = async () => {
    executed += 1;
    return "ok";
  };
  const ctx = {
    state: {
      tools: new Map([[runShell.name, runShell]]),
    },
    ports: {
      getActiveExec: () => undefined,
      currentSessionSnapshot: () => undefined,
      createCollabChatTool: () => tool("collab_chat"),
    },
  } as unknown as RuntimeContext;
  const chatTools = createChatTools(ctx);
  const naviShell = chatTools
    .naviChatTools()
    .find((item) => item.name === "run_shell")!;
  const context = { workspaceRoot: process.cwd() };
  // A mutation is refused with NAVI's voice, and never reaches the tool.
  await expect(
    naviShell.execute({ command: "rm -rf build" }, context),
  ).rejects.toThrow(/Navi shell/u);
  expect(executed).toBe(0);
  await expect(
    naviShell.execute({ command: "git status" }, context),
  ).resolves.toBe("ok");
  expect(executed).toBe(1);
});

test("Nia run_shell wrapper enforces the read-only policy", async () => {
  const runShell = tool("run_shell");
  let executed = 0;
  runShell.execute = async () => {
    executed += 1;
    return "ok";
  };
  const ctx = {
    state: {
      tools: new Map([[runShell.name, runShell]]),
    },
    ports: {
      getActiveExec: () => undefined,
      currentSessionSnapshot: () => undefined,
      createCollabChatTool: () => tool("collab_chat"),
    },
  } as unknown as RuntimeContext;
  const chatTools = createChatTools(ctx);
  const niaShell = chatTools
    .niaChatTools()
    .find((item) => item.name === "run_shell")!;
  const context = { workspaceRoot: process.cwd() };
  await expect(
    niaShell.execute({ command: "git commit -m test" }, context),
  ).rejects.toThrow(/read-only/u);
  expect(executed).toBe(0);
  await expect(
    niaShell.execute({ command: "git status" }, context),
  ).resolves.toBe("ok");
  expect(executed).toBe(1);
});
