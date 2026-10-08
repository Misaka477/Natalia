import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@anthelia/plugin";
import { createToolRegistry } from "@anthelia/tools";
import {
  createFsWritePlugin,
  FS_WRITE_PLUGIN_ID,
  fsWriteToolFamily,
  writeFileTools,
} from "../src";

test("the fs-write family describes the write tools it ships", () => {
  const family = fsWriteToolFamily();
  expect(family.id).toBe("fs-write");
  expect(family.scope).toBe("workspace");
  expect(family.tools).toEqual(writeFileTools);
  for (const tool of family.tools) {
    expect(tool.name).toBeString();
    expect(tool.requiresApproval).toBe(true);
  }
});

test("the fs-write plugin owns its tools and unloads cleanly", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(createFsWritePlugin());
  expect(registry.list()[0]).toMatchObject({
    id: FS_WRITE_PLUGIN_ID,
    scope: "workspace",
  });
  for (const tool of writeFileTools) expect(tools.has(tool.name)).toBe(true);
  await registry.unload(FS_WRITE_PLUGIN_ID);
  for (const tool of writeFileTools) expect(tools.has(tool.name)).toBe(false);
});

test("write_file and edit_file go through the write lock", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-fs-write-"));
  const writes: Array<{ toolName: string; path: string }> = [];
  const context = {
    workspaceRoot: root,
    workspaceWriteAuthorize: async (input: {
      toolName: string;
      path: string;
    }) => {
      writes.push(input);
    },
  };
  const tools = new Map(
    fsWriteToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  await tools
    .get("write_file")!
    .execute({ path: "example.txt", content: "hello" }, context);
  expect(
    await tools
      .get("edit_file")!
      .execute(
        { path: "example.txt", oldText: "hello", newText: "updated" },
        context,
      ),
  ).toBe("edited example.txt");
  const { readFile } = await import("node:fs/promises");
  expect(await readFile(join(root, "example.txt"), "utf8")).toBe("updated");
  expect(writes).toEqual([
    { toolName: "write_file", path: join(root, "example.txt") },
    { toolName: "edit_file", path: join(root, "example.txt") },
  ]);
});

test("apply_edits edits several files in one call and authorizes each path", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-fs-write-edits-"));
  await writeFile(join(root, "a.ts"), "const a = 1;\nconst b = 2;\n");
  await writeFile(join(root, "c.ts"), "const c = 3;\n");
  const writes: Array<{ toolName: string; path: string }> = [];
  const context = {
    workspaceRoot: root,
    workspaceWriteAuthorize: async (input: {
      toolName: string;
      path: string;
    }) => {
      writes.push(input);
    },
  };
  const tools = new Map(
    fsWriteToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const result = await tools.get("apply_edits")!.execute(
    {
      edits: [
        {
          path: "a.ts",
          operation: "replace",
          oldText: "const b = 2;",
          newText: "const b = 20;",
        },
        {
          path: "c.ts",
          operation: "replace",
          oldText: "const c = 3;",
          newText: "const c = 30;",
        },
      ],
    },
    context,
  );
  expect(result).toContain("2 edits");
  expect(result).toContain("a.ts");
  expect(result).toContain("c.ts");
  const { readFile } = await import("node:fs/promises");
  expect(await readFile(join(root, "a.ts"), "utf8")).toBe(
    "const a = 1;\nconst b = 20;\n",
  );
  expect(await readFile(join(root, "c.ts"), "utf8")).toBe("const c = 30;\n");
  expect(writes).toEqual([
    { toolName: "apply_edits", path: join(root, "a.ts") },
    { toolName: "apply_edits", path: join(root, "c.ts") },
  ]);
});

test("apply_edits changes nothing when one oldText does not match", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-tool-fs-write-edits-fail-"),
  );
  await writeFile(join(root, "a.ts"), "const a = 1;\n");
  await writeFile(join(root, "missing.ts"), "different content\n");
  const tools = new Map(
    fsWriteToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  await expect(
    tools.get("apply_edits")!.execute(
      {
        edits: [
          {
            path: "a.ts",
            operation: "replace",
            oldText: "const a = 1;",
            newText: "const a = 10;",
          },
          {
            path: "missing.ts",
            operation: "replace",
            oldText: "nope",
            newText: "yes",
          },
        ],
      },
      { workspaceRoot: root },
    ),
  ).rejects.toThrow(/oldText not found/u);
  const { readFile } = await import("node:fs/promises");
  expect(await readFile(join(root, "a.ts"), "utf8")).toBe("const a = 1;\n");
});

test("apply_edits applies sequential edits to the same file", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-tool-fs-write-edits-sequential-"),
  );
  await writeFile(join(root, "a.ts"), "const x = 1;\n");
  const tools = new Map(
    fsWriteToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const result = await tools.get("apply_edits")!.execute(
    {
      edits: [
        {
          path: "a.ts",
          operation: "replace",
          oldText: "const x = 1;",
          newText: "const x = 2;",
        },
        {
          path: "a.ts",
          operation: "replace",
          oldText: "const x = 2;",
          newText: "const x = 3;",
        },
      ],
    },
    { workspaceRoot: root },
  );
  expect(result).toContain("all 2 edits applied");
  expect(result).toContain("1 file changed");
  expect(result).toContain("- a.ts (2 edits)");
  const { readFile } = await import("node:fs/promises");
  expect(await readFile(join(root, "a.ts"), "utf8")).toBe("const x = 3;\n");
});

test("apply_edits distinguishes requested edits from changed files", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-tool-fs-write-edits-counts-"),
  );
  await writeFile(join(root, "a.ts"), "const a = 1;\n");
  const tools = new Map(
    fsWriteToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const result = await tools.get("apply_edits")!.execute(
    {
      edits: [
        {
          path: "a.ts",
          operation: "replace",
          oldText: "const a = 1;",
          newText: "const a = 2;",
        },
        {
          path: "a.ts",
          operation: "replace",
          oldText: "const a = 2;",
          newText: "const a = 3;",
        },
        {
          path: "a.ts",
          operation: "replace",
          oldText: "const a = 3;",
          newText: "const a = 4;",
        },
      ],
    },
    { workspaceRoot: root },
  );
  expect(result).toBe(
    "apply_edits: all 3 edits applied; 1 file changed.\n- a.ts (3 edits)",
  );
});

test("apply_edits reports a no-op batch without pretending it wrote files", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-tool-fs-write-edits-noop-"),
  );
  await writeFile(join(root, "a.ts"), "const a = 1;\n");
  const tools = new Map(
    fsWriteToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const result = await tools.get("apply_edits")!.execute(
    {
      edits: [
        {
          path: "a.ts",
          operation: "replace",
          oldText: "const a = 1;",
          newText: "const a = 1;",
        },
      ],
    },
    { workspaceRoot: root },
  );
  expect(result).toBe(
    "apply_edits: all 1 edit applied; no file content changed.",
  );
});

test("apply_edits creates and deletes files atomically", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-tool-fs-write-edits-files-"),
  );
  await writeFile(join(root, "old.txt"), "remove me\n");
  const tools = new Map(
    fsWriteToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  await tools.get("apply_edits")!.execute(
    {
      edits: [
        { path: "notes.txt", operation: "create", newText: "fresh\n" },
        { path: "old.txt", operation: "delete" },
      ],
    },
    { workspaceRoot: root },
  );
  const { readFile } = await import("node:fs/promises");
  expect(await readFile(join(root, "notes.txt"), "utf8")).toBe("fresh\n");
  await expect(readFile(join(root, "old.txt"), "utf8")).rejects.toThrow();
});

test("apply_edits rejects an ambiguous oldText before writing anything", async () => {
  const root = await mkdtemp(
    join(tmpdir(), "natalia-tool-fs-write-edits-ambiguous-"),
  );
  await writeFile(join(root, "a.ts"), "const x = 1;\nconst x = 2;\n");
  const tools = new Map(
    fsWriteToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  await expect(
    tools.get("apply_edits")!.execute(
      {
        edits: [
          {
            path: "a.ts",
            operation: "replace",
            oldText: "const x =",
            newText: "const y =",
          },
        ],
      },
      { workspaceRoot: root },
    ),
  ).rejects.toThrow(/ambiguous \(2 occurrences\)/u);
  const { readFile } = await import("node:fs/promises");
  expect(await readFile(join(root, "a.ts"), "utf8")).toBe(
    "const x = 1;\nconst x = 2;\n",
  );
});

test("apply_edits description is a structured model-facing batch editor", () => {
  const applyEdits = fsWriteToolFamily().tools.find(
    (tool) => tool.name === "apply_edits",
  )!;
  expect(applyEdits.description).toContain('"edits"');
  expect(applyEdits.description).toContain('"operation": "replace"');
  expect(applyEdits.description).toContain("create");
  expect(applyEdits.description).toContain("delete");
  expect(applyEdits.description).toContain("Do not use unified diff");
});

test("write_file projects a diff card whose lines are marked additions", () => {
  // A create has no prior content (the FileDiff model uses oldText: null for that
  // case), so the card IS the new text — a UI renders it as the whole-file
  // change. Before this the family used a generic card, so a write looked like
  // any other tool call and no diff renderer ever saw it.
  const tool = writeFileTools.find((t) => t.name === "write_file")!;
  const call = tool.output?.presentCall?.({ path: "a.txt", content: "x\ny" });
  expect(call).toMatchObject({
    kind: "diff",
    title: "Write a.txt",
    summary: "write",
    meta: [["lines", "2"]],
  });
  // S5: the create's hunks are REAL ones — the file's own line numbers, the
  // same engine the sandbox family draws its merge hunks with — so a reader
  // navigates by them instead of counting rows.
  expect(call && call.kind === "diff" && call.hunks).toEqual([
    {
      oldStart: 1,
      oldCount: 0,
      newStart: 1,
      newCount: 2,
      lines: [
        { type: "add", text: "x", oldLineNumber: null, newLineNumber: 1 },
        { type: "add", text: "y", oldLineNumber: null, newLineNumber: 2 },
      ],
    },
  ]);
  // The mark text still rides along for a renderer without the hunks.
  expect(call?.body).toBe(" +x\n +y");
  // The RESULT state repeats the diff. The diff model says it outright: a
  // completed update replaces the pending card's content, so a result card
  // carrying the plain result string ERASES the diff. The measured screenshot
  // of a live run showed exactly that — `edited <path>` where the change
  // belonged. The tool's sentence to the model rides as a facet instead.
  const result = tool.output?.presentResult?.(
    { path: "a.txt", content: "x\ny" },
    "wrote a.txt",
  );
  expect(result).toMatchObject({
    kind: "diff",
    title: "Write a.txt",
    summary: "wrote",
    body: " +x\n +y",
    meta: [
      ["lines", "2"],
      ["result", "wrote a.txt"],
    ],
  });
  // S5: the result state carries the same real hunks the call did.
  expect(result && result.kind === "diff" && result.hunks?.[0]).toMatchObject({
    oldStart: 1,
    oldCount: 0,
    newStart: 1,
    newCount: 2,
  });
});

test("a write's marked lines are what a diff renderer colors (user screenshot)", () => {
  // The live run that produced the user's screenshot: a Write card whose body
  // was the RAW text, so the diff renderer's `+ ` convention matched nothing
  // and the content rendered plain — "Write 没有 diff". Every body line now
  // carries the addition mark, which is the only contract the renderer reads.
  const tool = writeFileTools.find((t) => t.name === "write_file")!;
  const card = tool.output?.presentResult?.(
    { path: ".natalia/tool-smoke/direct.txt", content: "alpha" },
    "wrote .natalia/tool-smoke/direct.txt",
  );
  expect(card?.kind).toBe("diff");
  // The body is the change itself, marked the way every renderer reads it —
  // and S5's real hunks carry the line numbers beside it.
  expect(card?.body).toBe(" +alpha");
  expect(card && card.kind === "diff" && card.hunks).toEqual([
    {
      oldStart: 1,
      oldCount: 0,
      newStart: 1,
      newCount: 1,
      lines: [
        { type: "add", text: "alpha", oldLineNumber: null, newLineNumber: 1 },
      ],
    },
  ]);
});

test("an edit's result state repeats the hunk instead of replacing it", () => {
  const tool = writeFileTools.find((t) => t.name === "edit_file")!;
  const result = tool.output?.presentResult?.(
    { path: "a.txt", oldText: "one", newText: "two" },
    "edited a.txt",
  );
  expect(result).toMatchObject({
    kind: "diff",
    title: "Edit a.txt",
    summary: "edited",
    body: " -one\n +two",
    meta: [
      ["removed", "1"],
      ["added", "1"],
      ["result", "edited a.txt"],
    ],
  });
  expect(result && result.kind === "diff" && result.hunks?.[0]).toMatchObject({
    oldStart: 1,
    oldCount: 1,
    newStart: 1,
    newCount: 1,
  });
});

test("apply_edits projects one hunk per edit, not a summary sentence", () => {
  // The batch card used to be `title: "workspace", summary: <the result
  // sentence>` — a reader learned WHICH files changed and nothing about WHAT
  // changed. Now each edit contributes its own marked hunk.
  const tool = writeFileTools.find((t) => t.name === "apply_edits")!;
  const card = tool.output?.presentResult?.(
    {
      edits: [
        {
          path: "a.txt",
          operation: "replace",
          oldText: "one",
          newText: "two",
        },
        { path: "b.txt", operation: "create", newText: "fresh" },
        { path: "c.txt", operation: "delete" },
      ],
    },
    "apply_edits: all 3 edits applied; 3 files changed.",
  );
  expect(card).toMatchObject({
    kind: "diff",
    title: "apply_edits: 3 edits",
    summary: "applied",
  });
  // S5: each hunk is a real one, so the marked text carries the engine's
  // context lines and the card carries the hunks themselves.
  expect(card?.body).toBe(
    "--- a.txt\n -one\n +two\n+++ b.txt\n +fresh\n--- c.txt (deleted)",
  );
  expect(card && card.kind === "diff" && card.hunks?.length).toBe(2);
  expect(card?.meta).toContainEqual([
    "result",
    "apply_edits: all 3 edits applied; 3 files changed.",
  ]);
});

test("edit_file projects the marked hunk and its line counts", () => {
  const tool = writeFileTools.find((t) => t.name === "edit_file")!;
  const intent = tool.output?.presentCall?.({
    path: "a.txt",
    oldText: "one\ntwo",
    newText: "one\nthree",
  });
  expect(intent).toMatchObject({
    kind: "diff",
    title: "Edit a.txt",
    summary: "edit",
    meta: [
      ["removed", "2"],
      ["added", "2"],
    ],
  });
  // S5: a REAL hunk — the unchanged first line is context, and the change
  // carries its position. The old shape was "removed then added", which told
  // a reader nothing about where in the file either block sat.
  expect(intent?.body).toBe(" one\n -two\n +three");
  expect(intent && intent.kind === "diff" && intent.hunks?.[0]).toMatchObject({
    oldStart: 1,
    oldCount: 2,
    newStart: 1,
    newCount: 2,
  });
  // A create-style edit (empty oldText) is all added lines; a delete is all
  // removed. Neither may produce an empty hunk that reads as "nothing".
  expect(
    tool.output?.presentCall?.({
      path: "a.txt",
      oldText: "",
      newText: "brand new",
    })?.body,
  ).toBe(" +brand new");
  expect(
    tool.output?.presentCall?.({ path: "a.txt", oldText: "gone", newText: "" })
      ?.body,
  ).toBe(" -gone");
});
