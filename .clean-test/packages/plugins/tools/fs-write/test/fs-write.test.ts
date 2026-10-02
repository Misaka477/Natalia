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
