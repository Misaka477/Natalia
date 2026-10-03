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

test("the read tool reports the served window and the document's extent", async () => {
  // The model pages with these two facts and nothing else: where the served
  // window sits, and how much document there is. A window reported without the
  // extent is the gap this closes — the caller could see what it got and not
  // what was left, so it paged by guessing.
  const registry = {
    read: async () => ({
      text: "line-a\nline-b\nline-c",
      // A ten-line document, with lines 5..7 served: `endLine` is one past the
      // last line served, the controller's own convention.
      startLine: 5,
      endLine: 8,
      totalLines: 10,
      cursorX: 0,
      cursorY: 2,
      rows: 24,
      cols: 80,
    }),
  };
  const tool = terminalToolFamily().tools.find(
    (candidate) => candidate.name === "interactive_terminal_read",
  )!;
  const context = { workspaceRoot: "/tmp", terminal: registry } as never;

  const read = JSON.parse(
    await tool.execute({ id: "t_read", startLine: 5, maxLines: 3 }, context),
  );
  // `lineCount`, not a second `endLine`: the controller's end is exclusive and
  // the tool's `endLine` parameter is inclusive, and one name for both is how a
  // walker loses its place.
  expect(read.window).toEqual({ startLine: 5, lineCount: 3 });
  expect(read.totalLines).toBe(10);
});

test("a window past the document's end reports zero lines served, not a negative count", async () => {
  // The controller answers a beyond-the-end window with the requested start and
  // the document's extent, so the raw difference is negative. What was served is
  // nothing, and a caller that subtracts without clamping reads -50 lines.
  const registry = {
    read: async () => ({
      text: "",
      startLine: 1_050,
      endLine: 1_000,
      totalLines: 1_000,
      cursorX: 0,
      cursorY: 0,
      rows: 24,
      cols: 80,
    }),
  };
  const tool = terminalToolFamily().tools.find(
    (candidate) => candidate.name === "interactive_terminal_read",
  )!;
  const context = { workspaceRoot: "/tmp", terminal: registry } as never;

  const read = JSON.parse(
    await tool.execute(
      { id: "t_read", startLine: 1_050, maxLines: 50 },
      context,
    ),
  );
  expect(read.window).toEqual({ startLine: 1_050, lineCount: 0 });
  expect(read.totalLines).toBe(1_000);
  expect(read.text).toBe("");
});

test("the read tool says null when the host cannot report an extent", async () => {
  // The wezterm host answers with text, the cursor and the geometry — nothing
  // that locates the text in a document. The tool must say so: zeros would read
  // as a one-line document and send the model paging a pane that has none.
  const registry = {
    read: async () => ({
      text: "prompt$ ",
      startLine: null,
      endLine: null,
      totalLines: null,
      cursorX: 0,
      cursorY: 0,
      rows: 24,
      cols: 80,
    }),
  };
  const tool = terminalToolFamily().tools.find(
    (candidate) => candidate.name === "interactive_terminal_read",
  )!;
  const context = { workspaceRoot: "/tmp", terminal: registry } as never;

  const read = JSON.parse(await tool.execute({ id: "t_read" }, context));
  expect(read.window).toBeNull();
  expect(read.totalLines).toBeNull();
  // The text still arrives: the extent is the part that cannot be known, not
  // the pane's output.
  expect(read.text).toContain("prompt$");
});
