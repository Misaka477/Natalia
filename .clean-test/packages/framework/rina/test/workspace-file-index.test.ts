import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  openWorkspaceFileIndex,
  workspaceFileIndexExists,
} from "../src/workspace-file-index";

const roots: string[] = [];
process.on("exit", () => {
  for (const root of roots) rm(root, { recursive: true, force: true });
});

async function workspaceWith(files: Record<string, string>): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), "rina-wfi-"));
  roots.push(root);
  for (const [path, source] of Object.entries(files)) {
    await mkdir(join(root, path, ".."), { recursive: true });
    await writeFile(join(root, path), source);
  }
  return root;
}

const modules = (count: number, name = "handler") =>
  Object.fromEntries(
    Array.from({ length: count }, (_, index) => [
      `src/mod-${index}.ts`,
      `export function ${name}_${(index * 7919) % 100000}(value: string) { return value; }\n`,
    ]),
  );

test("the index walks the workspace, answers definitions, and reuses its cache", async () => {
  const root = await workspaceWith({
    ...modules(6),
    // The decoy the ignore rules must keep out.
    "node_modules/left-pad/index.ts":
      "export function pad(value: string) { return value; }\n",
  });
  const index = await openWorkspaceFileIndex(root);
  const first = await index.refresh({ prune: true });
  expect(first.length).toBe(6);
  const firstStats = index.stats();
  expect(firstStats.indexedFresh).toBe(6);
  expect(firstStats.fromCache).toBe(0);
  expect(workspaceFileIndexExists(root)).toBe(true);

  // The definitions face: one symbol, exactly one file.
  // The second refresh: nothing changed, everything from the cache.
  const second = await index.refresh();
  expect(second.length).toBe(6);
  const secondStats = index.stats();
  expect(secondStats.fromCache).toBe(6);
  expect(secondStats.indexedFresh).toBe(0);

  // One file changed: the index pays for THAT file alone.
  await writeFile(
    join(root, "src/mod-3.ts"),
    "export function renamed_1234(value: string) { return value.trim(); }\n",
  );
  const third = await index.refresh();
  const thirdStats = index.stats();
  expect(thirdStats.fromCache).toBe(5);
  expect(thirdStats.indexedFresh).toBe(1);

  // The decoy never entered the index.
  const definitions = await index.definitions("pad");
  expect(definitions.length).toBe(0);
  // And the renamed symbol is found.
  const renamed = await index.definitions("renamed_1234");
  expect(renamed.length).toBe(1);
  expect(renamed[0]!.path).toBe("src/mod-3.ts");
  // The per-file query face.
  const symbols = await index.symbolsIn("src/mod-0.ts");
  expect(symbols.length).toBeGreaterThan(0);
  expect(symbols.some((node) => node.text.includes("handler_0"))).toBe(true);
}, 30_000);

test("a corrupt cache entry re-derives; the cache is never the truth", async () => {
  const root = await workspaceWith(modules(2));
  const index = await openWorkspaceFileIndex(root);
  await index.refresh();
  // Corrupt every entry: the refresh must still answer (a re-index), not
  // throw — the wasm is the truth, the cache is a cache.
  const { readdir, writeFile: write } = await import("node:fs/promises");
  const dir = join(root, ".natalia", "workspace-index");
  for (const name of await readdir(dir))
    await write(join(dir, name), "{not json");
  const entries = await index.refresh();
  expect(entries.length).toBe(2);
  expect(index.stats().fromCache).toBe(0);
  expect(index.stats().indexedFresh).toBe(2);
}, 30_000);
