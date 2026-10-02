import { expect, test } from "bun:test";
import { terminalToolFamily, terminalTools } from "../src";

test("the terminal family describes the tools it ships", () => {
  const family = terminalToolFamily();
  expect(family.id).toBe("terminal");
  expect(family.scope).toBe("session");
  expect(family.tools.map((tool) => tool.name)).toEqual(
    terminalTools().map((tool) => tool.name),
  );
});

test("the terminal family declares the interactive aliases", () => {
  const family = terminalToolFamily();
  expect(family.aliases?.interactive_start).toBe("interactive_terminal_start");
  expect(family.aliases?.interactive_input).toBe("interactive_terminal_input");
});

test("terminal tools refuse without the native terminal host", async () => {
  const tool = terminalToolFamily().tools.find(
    (candidate) => candidate.name === "interactive_terminal_start",
  )!;
  await expect(
    tool.execute({}, { workspaceRoot: "/tmp" } as never),
  ).rejects.toThrow(/Native Terminal Host is unavailable/u);
});

test("the start tool asks for the grid it was given, and the default when it was not", async () => {
  // The tools are the model's only way to size a terminal. Without the
  // pass-through a model that knows it is about to run a TUI has to start at
  // the default and resize afterwards — and the default used to be a vt100,
  // which clips vim and htop before the first keystroke.
  const started: Array<{ command: string; rows?: number; cols?: number }> = [];
  const registry = {
    start: async (input: { command: string; rows?: number; cols?: number }) => {
      started.push(input);
      return { id: "t1", host: "pty", status: "running" };
    },
  };
  const tool = terminalToolFamily().tools.find(
    (candidate) => candidate.name === "interactive_terminal_start",
  )!;
  const context = {
    workspaceRoot: "/tmp",
    terminal: registry,
  } as never;

  await tool.execute({ command: "vim" }, context);
  expect(started.at(-1)).toMatchObject({ command: "vim" });
  expect(started.at(-1)?.rows).toBeUndefined();
  expect(started.at(-1)?.cols).toBeUndefined();

  await tool.execute({ command: "vim", rows: 45, cols: 180 }, context);
  expect(started.at(-1)).toMatchObject({
    command: "vim",
    rows: 45,
    cols: 180,
  });

  // A nonsensical size is passed through rather than silently dropped: the
  // controller owns the fallback decision, and a tool that guessed here could
  // disagree with it.
  await tool.execute({ command: "htop", rows: 0, cols: -2 }, context);
  expect(started.at(-1)).toMatchObject({ command: "htop", rows: 0, cols: -2 });
});
