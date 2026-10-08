import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@anthelia/plugin";
import { createToolRegistry } from "@anthelia/tools";
import {
  createSearchPlugin,
  SEARCH_PLUGIN_ID,
  searchBudgetNote,
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

test("the budget note names the remedy for each search tool", () => {
  // Deterministic: the tool-level path cannot force the scan's internal
  // deadline (no parameter exposes it), so the note's construction is driven
  // with a synthetic result. The earlier version of this test asserted a
  // one-file workspace would truncate — it never does; the test passed only
  // when the machine was loaded enough for the 8s deadline to fire, which is
  // measuring the runner, not the code.
  const globNote = searchBudgetNote({ tool: "glob", scannedFiles: 500 });
  expect(globNote).toContain("after 500 files");
  expect(globNote).toContain("call again with nextCursor");
  expect(globNote).toContain("narrow path/pattern");
  const grepNote = searchBudgetNote({ tool: "grep", scannedFiles: 12 });
  expect(grepNote).toContain("after 12 files");
  expect(grepNote).toContain("narrow path/include/pattern");
  expect(grepNote).not.toContain("narrow path/pattern;");
});

test("a glob page is well-formed and continuable when it stops early", async () => {
  // The tool-level contract that does not depend on timing: a bounded page
  // carries its facts, and a cursor that continues it.
  const root = await mkdtemp(join(tmpdir(), "natalia-search-page-"));
  await writeFile(join(root, "a.txt"), "needle\n");
  await writeFile(join(root, "b.txt"), "needle\n");
  await Bun.sleep(50);
  const glob = searchToolFamily().tools.find((tool) => tool.name === "glob")!;
  const parsed = JSON.parse(
    (await glob.execute(
      { pattern: "*.txt", limit: 1 },
      { workspaceRoot: root },
    )) as string,
  ) as {
    paths: string[];
    truncated: boolean;
    nextCursor?: string;
    timedOut?: boolean;
    note?: string;
  };
  expect(parsed.paths).toEqual(["a.txt"]);
  // The page that stopped early says so and hands over the continuation.
  expect(parsed.truncated).toBe(true);
  expect(parsed.nextCursor).toBeTypeOf("string");
  // And when the scan timed out instead, the remedy rides with it.
  expect(parsed.timedOut === true ? parsed.note : parsed.note).toBeUndefined();
});

test("glob's result card lists the paths, not just a count", () => {
  // dsh's SearchPathsResultView carries `paths` itself. A card that shows only
  // "3 matches" makes a reader open the result JSON to learn WHICH three.
  // R2: the paths are the card's structured field (the search renderer draws
  // one line per path), so there is no body to read them from.
  const tool = searchToolFamily().tools.find((t) => t.name === "glob")!;
  const card = tool.output?.presentResult?.(
    { pattern: "**/*.ts" },
    JSON.stringify({ paths: ["a.ts", "b/c.ts"], truncated: false }),
  );
  expect(card).toMatchObject({
    kind: "search",
    paths: ["a.ts", "b/c.ts"],
  });
  // The tool's facts travel the meta slot too (one parse, both slots).
  expect(tool.output?.presentationMeta?.({}, "{}")).toEqual({ paths: [] });
});

test("grep's result card groups the matches by file with line numbers", () => {
  // dsh's SearchMatchesResultView groups by file. Same reasoning: the hit
  // locations are the content, the count is not.
  const tool = searchToolFamily().tools.find((t) => t.name === "grep")!;
  const value = JSON.stringify({
    matches: [
      { path: "a.ts", line: 12, text: "the renderer" },
      { path: "a.ts", line: 40, text: "renderer again" },
      { path: "b.ts", line: 3, text: "a renderer" },
    ],
    truncated: false,
  });
  const card = tool.output?.presentResult?.({ pattern: "renderer" }, value);
  // R2: the hits are the card's structured `matches` — path, line, text.
  // The grouping by file is the search kind's own DRAWING (the kit's
  // renderer, pinned in ui-kit's card-renderer-fields test), not something
  // the tool composes as text a second time.
  expect(card).toMatchObject({
    kind: "search",
    matches: [
      { path: "a.ts", line: 12, text: "the renderer" },
      { path: "a.ts", line: 40, text: "renderer again" },
      { path: "b.ts", line: 3, text: "a renderer" },
    ],
  });
  // The same facts on the event's meta slot, from the same one parse.
  expect(tool.output?.presentationMeta?.({}, value)).toEqual({
    matches: [
      { path: "a.ts", line: 12, text: "the renderer" },
      { path: "a.ts", line: 40, text: "renderer again" },
      { path: "b.ts", line: 3, text: "a renderer" },
    ],
  });
});

test("grep's card is composed from the FACTS, not a second parse (R2)", () => {
  const tool = searchToolFamily().tools.find((t) => t.name === "grep")!;
  const value = JSON.stringify({
    matches: [{ path: "a.ts", line: 12, text: "the renderer" }],
    truncated: false,
  });
  const meta = tool.output!.presentationMeta!({ pattern: "renderer" }, value);
  const card = tool.output!.presentResult!(
    { pattern: "renderer" },
    "POISON",
    meta as Record<string, unknown>,
  );
  expect(card).toMatchObject({
    kind: "search",
    matches: [{ path: "a.ts", line: 12, text: "the renderer" }],
    // The count line keeps the tool's own spelling (plural even for one —
    // the row reads "1 matches", the same as before R2).
    summary: "1 matches",
  });
});

test("a search result that is not the envelope still renders", () => {
  // The projector is a DISPLAY path: a malformed result must degrade to the
  // raw text, never throw — the same defensive shape read_file's card uses.
  const tool = searchToolFamily().tools.find((t) => t.name === "glob")!;
  const card = tool.output?.presentResult?.({ pattern: "**/*.ts" }, "not json");
  expect(card?.body).toBe("not json");
});
