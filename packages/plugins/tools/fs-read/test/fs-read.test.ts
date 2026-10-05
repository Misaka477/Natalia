import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@anthelia/plugin";
import { createToolRegistry, validateToolParameters } from "@anthelia/tools";
import {
  createFsReadPlugin,
  FS_READ_PLUGIN_ID,
  fsReadToolFamily,
  readFileTools,
} from "../src";

test("the fs-read family describes the read-only tools it ships", () => {
  const family = fsReadToolFamily();
  expect(family.id).toBe("fs-read");
  expect(family.scope).toBe("workspace");
  expect(family.tools).toEqual(readFileTools);
  for (const tool of family.tools) {
    expect(tool.name).toBeString();
    expect(tool.requiresApproval).toBe(false);
  }
});

test("the fs-read plugin owns its tools and unloads cleanly", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(createFsReadPlugin());
  expect(registry.list()[0]).toMatchObject({
    id: FS_READ_PLUGIN_ID,
    scope: "workspace",
  });
  for (const tool of readFileTools) expect(tools.has(tool.name)).toBe(true);
  await registry.unload(FS_READ_PLUGIN_ID);
  for (const tool of readFileTools) expect(tools.has(tool.name)).toBe(false);
});

test("read_file reads inside the workspace and rejects escapes", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-fs-read-"));
  await writeFile(join(root, "note.txt"), "hi");
  const tools = new Map(
    fsReadToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  expect(
    JSON.parse(
      await tools
        .get("read_file")!
        .execute({ path: "note.txt" }, { workspaceRoot: root }),
    ),
  ).toEqual({ content: "hi", totalLines: 1, truncated: false });
  await expect(
    tools
      .get("read_file")!
      .execute({ path: "../escape" }, { workspaceRoot: root }),
  ).rejects.toThrow(/outside workspace|path/u);
});

test("read_file accepts offset and length for autonomous pagination", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-fs-read-page-"));
  await writeFile(join(root, "lines.txt"), "one\ntwo\nthree\nfour\nfive\n");
  const read = fsReadToolFamily().tools.find(
    (candidate) => candidate.name === "read_file",
  )!;

  expect(read.parameters.properties).toMatchObject({
    offset: { type: "integer", minimum: 1 },
    length: { type: "integer", minimum: 1 },
  });
  expect(
    validateToolParameters(read.parameters, {
      path: "lines.txt",
      offset: 2,
      length: 2,
    }),
  ).toEqual([]);
  expect(
    validateToolParameters(read.parameters, {
      path: "lines.txt",
      offset: 0,
    }),
  ).toEqual([{ path: "offset", message: "must be at least 1" }]);
  expect(
    JSON.parse(
      await read.execute(
        { path: "lines.txt", offset: 2, length: 2 },
        { workspaceRoot: root },
      ),
    ),
  ).toEqual({
    content: "two\nthree\n\n... 2 more lines; use offset=4 length=2 ...",
    totalLines: 5,
    truncated: true,
  });
  expect(
    JSON.parse(
      await read.execute(
        { path: "lines.txt", offset: 4, length: 2 },
        { workspaceRoot: root },
      ),
    ),
  ).toEqual({ content: "four\nfive", totalLines: 5, truncated: false });
  await expect(
    read.execute(
      { path: "lines.txt", offset: 0, length: 2 },
      { workspaceRoot: root },
    ),
  ).rejects.toThrow("offset must be a positive integer");
});

test("read_file projects a read card from its output definition", () => {
  const tool = fsReadToolFamily().tools.find(
    (candidate) => candidate.name === "read_file",
  )!;
  const intent = tool.output?.presentResult?.(
    { path: "src/index.ts" },
    JSON.stringify({
      content: "export const x = 1;",
      totalLines: 1,
      truncated: false,
    }),
  );
  expect(intent).toMatchObject({
    kind: "read",
    title: "src/index.ts",
    // The window, not the char count: a card that shows only the size
    // presents a capped read as the whole file.
    summary: "1 lines",
    body: "export const x = 1;",
  });
});

test("read_file caps a windowless read at the line limit and says where to continue", async () => {
  // The P1 the audit found: `read_file` was the only reader in the registry
  // that could put an unbounded file into the context in one call. A file
  // over the limit now returns the first page, the total, and the offset —
  // and a file at or under it is returned whole with truncated false.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-fs-read-cap-"));
  await writeFile(
    join(root, "big.txt"),
    Array.from({ length: 2005 }, (_, index) => `line ${index + 1}`).join("\n") +
      "\n",
  );
  const read = fsReadToolFamily().tools.find(
    (candidate) => candidate.name === "read_file",
  )!;
  const capped = JSON.parse(
    await read.execute({ path: "big.txt" }, { workspaceRoot: root }),
  ) as { content: string; totalLines: number; truncated: boolean };
  expect(capped.totalLines).toBe(2005);
  expect(capped.truncated).toBe(true);
  const page = capped.content.split(/\r?\n/u);
  expect(page[0]).toBe("line 1");
  expect(page[1999]).toBe("line 2000");
  // The continuation is spelled out in the text the model reads, and the
  // offset it names is the first line of the next page.
  expect(page.at(-1)).toContain("5 more lines; use offset=2001 length=2000");

  await writeFile(
    join(root, "small.txt"),
    Array.from({ length: 3 }, (_, index) => `s${index + 1}`).join("\n") + "\n",
  );
  expect(
    JSON.parse(
      await read.execute({ path: "small.txt" }, { workspaceRoot: root }),
    ),
  ).toEqual({ content: "s1\ns2\ns3", totalLines: 3, truncated: false });
});

test("read_media_file reports native metadata without injecting bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-fs-read-media-"));
  await writeFile(
    join(root, "image.png"),
    new Uint8Array([0x89, 0x50, 0x4e, 0x47]),
  );
  const tools = new Map(
    fsReadToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  expect(
    await tools
      .get("read_media_file")!
      .execute({ path: "image.png" }, { workspaceRoot: root }),
  ).toContain('"kind": "png"');
});

test("image_read refuses when the host has no attachment channel", async () => {
  const tools = new Map(
    fsReadToolFamily().tools.map((tool) => [tool.name, tool]),
  );
  await expect(
    tools
      .get("image_read")!
      .execute({ path: "image.png" }, { workspaceRoot: "/workspace" }),
  ).rejects.toThrow("image attachment is unavailable");
});
