import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@anthelia/plugin";
import { createToolRegistry } from "@anthelia/tools";
import {
  createSearchPlugin,
  SEARCH_PLUGIN_ID,
  searchToolFamily,
  searchTools,
} from "../src";

test("the search family describes the tools it ships", () => {
  const family = searchToolFamily();
  expect(family.id).toBe("search");
  expect(family.scope).toBe("workspace");
  expect(family.tools).toEqual(searchTools);
});

test("the search plugin owns its stable tools and unloads cleanly", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(createSearchPlugin());
  expect(registry.list()[0]).toMatchObject({
    id: SEARCH_PLUGIN_ID,
    scope: "workspace",
  });
  for (const tool of searchTools) expect(tools.has(tool.name)).toBe(true);
  await registry.unload(SEARCH_PLUGIN_ID);
  for (const tool of searchTools) expect(tools.has(tool.name)).toBe(false);
});

test("glob finds the files it should and nothing outside the workspace", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-search-"));
  await writeFile(join(root, "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "b.js"), "const b = 2;\n");
  const tools = new Map(
    searchToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const listed = JSON.parse(
    await tools
      .get("glob")!
      .execute({ pattern: "**/*.ts" }, { workspaceRoot: root }),
  ) as { paths: string[] };
  expect(listed.paths).toContain("a.ts");
  expect(listed.paths).not.toContain("b.js");
  await expect(
    tools.get("glob")!.execute({ pattern: "../**/*" }, { workspaceRoot: root }),
  ).rejects.toThrow(/must remain inside workspace/u);
});

test("glob returns a cursor and resumes the next page deterministically", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-glob-pages-"));
  await writeFile(join(root, "b.txt"), "b\n");
  await writeFile(join(root, "a.txt"), "a\n");
  const tools = new Map(
    searchToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const first = JSON.parse(
    await tools
      .get("glob")!
      .execute({ pattern: "*.txt", limit: 1 }, { workspaceRoot: root }),
  ) as { paths: string[]; nextCursor?: string };
  expect(first.paths).toEqual(["a.txt"]);
  expect(first.nextCursor).toBeString();
  const second = JSON.parse(
    await tools
      .get("glob")!
      .execute(
        { pattern: "*.txt", limit: 1, cursor: first.nextCursor },
        { workspaceRoot: root },
      ),
  ) as { paths: string[]; nextCursor?: string };
  expect(second.paths).toEqual(["b.txt"]);
  expect(second.nextCursor).toBeUndefined();
});

test("glob skips derived directories by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-glob-ignore-"));
  await writeFile(join(root, "visible.txt"), "visible\n");
  await Bun.write(join(root, "node_modules", "hidden.txt"), "hidden\n");
  await Bun.write(join(root, "devref", "hidden.txt"), "hidden\n");
  const tools = new Map(
    searchToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const result = JSON.parse(
    await tools
      .get("glob")!
      .execute({ pattern: "*.txt" }, { workspaceRoot: root }),
  ) as { paths: string[] };
  expect(result.paths).toEqual(["visible.txt"]);
});

test("grep matches a line with its path and number", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-search-"));
  await writeFile(join(root, "x.txt"), "first\nneedle here\nlast\n");
  const tools = new Map(
    searchToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const result = await tools
    .get("grep")!
    .execute({ pattern: "needle" }, { workspaceRoot: root });
  expect(JSON.parse(result).matches).toContainEqual({
    path: "x.txt",
    line: 2,
    text: "needle here",
  });
});

test("grep returns a cursor and resumes the next page deterministically", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-search-pages-"));
  await writeFile(join(root, "b.txt"), "needle b\n");
  await writeFile(join(root, "a.txt"), "needle a\n");
  const tools = new Map(
    searchToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const first = JSON.parse(
    await tools
      .get("grep")!
      .execute({ pattern: "needle", limit: 1 }, { workspaceRoot: root }),
  );
  expect(first.matches).toEqual([{ path: "a.txt", line: 1, text: "needle a" }]);
  expect(first.nextCursor).toBeString();
  const second = JSON.parse(
    await tools
      .get("grep")!
      .execute(
        { pattern: "needle", limit: 1, cursor: first.nextCursor },
        { workspaceRoot: root },
      ),
  );
  expect(second.matches).toEqual([
    { path: "b.txt", line: 1, text: "needle b" },
  ]);
  expect(second.nextCursor).toBeUndefined();
});

test("grep skips derived directories by default", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-search-ignore-"));
  await writeFile(join(root, "visible.txt"), "needle visible\n");
  await Bun.write(join(root, "node_modules", "hidden.txt"), "needle hidden\n");
  await Bun.write(join(root, "devref", "hidden.txt"), "needle hidden\n");
  const tools = new Map(
    searchToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const result = JSON.parse(
    await tools
      .get("grep")!
      .execute({ pattern: "needle" }, { workspaceRoot: root }),
  );
  expect(result.matches).toEqual([
    { path: "visible.txt", line: 1, text: "needle visible" },
  ]);
});

test("grep enters a derived directory when include names it explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-grep-include-"));
  await writeFile(join(root, "visible.txt"), "needle visible\n");
  await Bun.write(join(root, "devref", "hidden.txt"), "needle hidden\n");
  const tools = new Map(
    searchToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const result = JSON.parse(
    await tools
      .get("grep")!
      .execute(
        { pattern: "needle", include: "devref/**/*" },
        { workspaceRoot: root },
      ),
  );
  expect(result.matches).toEqual([
    { path: "devref/hidden.txt", line: 1, text: "needle hidden" },
  ]);
});

test("glob enters a derived directory when its pattern names it explicitly", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-glob-include-"));
  await writeFile(join(root, "visible.txt"), "visible\n");
  await Bun.write(join(root, "devref", "hidden.txt"), "hidden\n");
  const tools = new Map(
    searchToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  const result = JSON.parse(
    await tools
      .get("glob")!
      .execute({ pattern: "devref/**/*" }, { workspaceRoot: root }),
  ) as { paths: string[] };
  expect(result.paths).toEqual(["devref/hidden.txt"]);
});

test("glob and grep preflight every exposed or read workspace path", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-search-policy-"));
  await writeFile(join(root, "allowed.ts"), "const value = 'needle';\n");
  await writeFile(join(root, "protected.ts"), "const secret = 'needle';\n");
  const checks: Array<{ toolName: string; paths: string[] }> = [];
  const context = {
    workspaceRoot: root,
    workspaceReadAuthorize: async (input: {
      toolName: string;
      paths: string[];
    }) => {
      checks.push(input);
      if (input.paths.includes("protected.ts")) throw new Error("protected");
    },
  };
  const tools = new Map(
    searchToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  await expect(
    tools.get("glob")!.execute({ pattern: "*.ts" }, context),
  ).rejects.toThrow("protected");
  await expect(
    tools.get("grep")!.execute({ pattern: "needle", include: "*.ts" }, context),
  ).rejects.toThrow("protected");
  expect(checks).toEqual([
    { toolName: "glob", paths: ["allowed.ts", "protected.ts"] },
    { toolName: "grep", paths: ["allowed.ts"] },
    { toolName: "grep", paths: ["protected.ts"] },
  ]);
});
