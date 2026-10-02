import { expect, test } from "bun:test";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { fingerprintFile } from "@anthelia/config";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  discoverLocalToolFamilies,
  loadLocalToolFamilies,
  reloadLocalToolFamily,
  watchLocalToolFamilies,
} from "../src/local-tool-families";

async function fixtureFamily(root: string, id: string) {
  const dir = join(root, id);
  await mkdir(dir, { recursive: true });
  await writeFile(
    join(dir, "natalia.tool.json"),
    JSON.stringify({ entry: "index.ts" }),
  );
  await writeFile(
    join(dir, "index.ts"),
    `import type { ToolFamily } from "@anthelia/tools";
const tools = [{
  name: "${id}_run",
  description: "Run",
  requiresApproval: false,
  parameters: { type: "object", properties: {} },
  async execute() { return "ok"; },
}];
export default (): ToolFamily => ({
  id: "${id}",
  name: "${id}",
  version: "1.0.0",
  description: "Fixture family",
  scope: "session",
  tools,
});
`,
  );
  return dir;
}

test("discoverLocalToolFamilies finds manifests under a root", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-discover-"));
  await fixtureFamily(root, "fixture.a");
  const discovered = await discoverLocalToolFamilies(root);
  expect(discovered.map((entry) => entry.path)).toHaveLength(1);
  expect(discovered[0]?.manifest.entry).toBe("index.ts");
});

test("loadLocalToolFamilies imports and instantiates the families", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-load-"));
  await fixtureFamily(root, "fixture.a");
  await fixtureFamily(root, "fixture.b");
  const families = await loadLocalToolFamilies({ roots: [root] });
  const ids = families.map((family) => family.id).sort();
  expect(ids).toEqual(["fixture.a", "fixture.b"]);
  const a = families.find((family) => family.id === "fixture.a")!;
  expect(a.tools.map((tool) => tool.name)).toEqual(["fixture.a_run"]);
  expect(a.scope).toBe("session");
});

test("a broken entry is reported and does not stop the rest", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-broken-"));
  await fixtureFamily(root, "fixture.a");
  const broken = join(root, "broken");
  await mkdir(broken, { recursive: true });
  await writeFile(
    join(broken, "natalia.tool.json"),
    JSON.stringify({ entry: "missing.ts" }),
  );
  const errors: string[] = [];
  const families = await loadLocalToolFamilies({
    roots: [root],
    onError: (id, error) =>
      errors.push(
        `${id}: ${error instanceof Error ? error.message : String(error)}`,
      ),
  });
  expect(families.map((family) => family.id)).toEqual(["fixture.a"]);
  expect(errors.length).toBeGreaterThan(0);
  expect(errors[0]!.startsWith(join(broken, "natalia.tool.json"))).toBe(true);
});

test("trust verification skips a package whose bytes changed since install", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-trust-"));
  const dir = await fixtureFamily(root, "fixture.a");
  const entryPath = join(dir, "index.ts");
  const fingerprint = await fingerprintFile(entryPath);
  const trust = {
    workspaceRoot: root,
    verify: async (_key: string, entry: string) => {
      const actual = await fingerprintFile(entry);
      return actual === fingerprint
        ? { verified: true, expected: fingerprint }
        : { verified: false, expected: fingerprint, actual };
    },
  };
  // Matching trust: loads.
  const loaded = await loadLocalToolFamilies({ roots: [root], trust });
  expect(loaded.map((family) => family.id)).toEqual(["fixture.a"]);
  // The package changed since install: reported and skipped.
  await writeFile(entryPath, "// changed\n");
  const errors: string[] = [];
  const afterChange = await loadLocalToolFamilies({
    roots: [root],
    trust,
    onError: (_id, error) =>
      errors.push(error instanceof Error ? error.message : String(error)),
  });
  expect(afterChange).toEqual([]);
  expect(
    errors.some((message) => message.includes("fingerprint mismatch")),
  ).toBe(true);
});

test("reloadLocalToolFamily re-reads the entry after a change (cache-bust)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-reload-"));
  const dir = await fixtureFamily(root, "fixture.a");
  const entry = join(dir, "index.ts");
  const source = (tool: string) =>
    `import type { ToolFamily } from "@anthelia/tools";
export default (): ToolFamily => ({
  id: "fixture.a", name: "fixture.a", version: "1.0.0",
  description: "Fixture family", scope: "session",
  tools: [{ name: "${tool}", description: "Run", requiresApproval: false,
    parameters: { type: "object", properties: {} }, async execute() { return "ok"; } }],
});
`;
  await writeFile(entry, source("fixture.a_run"));
  const first = await loadLocalToolFamilies({ roots: [root] });
  expect(first[0]!.tools[0]!.name).toBe("fixture.a_run");
  // The promoted change lands on disk; the reload re-reads it.
  await writeFile(entry, source("fixture.a_run_v2"));
  const reloaded = await reloadLocalToolFamily({
    roots: [root],
    familyID: "fixture.a",
  });
  expect(reloaded.tools[0]!.name).toBe("fixture.a_run_v2");
});

test("watchLocalToolFamilies reports a family entry change (debounced)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-watch-"));
  const dir = await fixtureFamily(root, "fixture.a");
  const entry = join(dir, "index.ts");
  const fired: Array<[string, string]> = [];
  const close = await watchLocalToolFamilies({
    roots: [root],
    debounceMs: 40,
    onChange: (familyID, entryPath) => fired.push([familyID, entryPath]),
  });
  await writeFile(entry, "// touch\n" + (await readFile(entry, "utf8")));
  await Bun.sleep(200);
  expect(fired.some(([familyID]) => familyID === "fixture.a")).toBe(true);
  expect(fired[0]![1]).toBe(entry);
  await close();
});

test("watchLocalToolFamilies does not watch an untrusted family", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-watch-trust-"));
  const dir = await fixtureFamily(root, "fixture.a");
  const entry = join(dir, "index.ts");
  const errors: string[] = [];
  const fired: string[] = [];
  const close = await watchLocalToolFamilies({
    roots: [root],
    trust: {
      workspaceRoot: root,
      verify: async () => ({ verified: false, expected: "expected" }),
    },
    debounceMs: 20,
    onError: (_id, error) =>
      errors.push(error instanceof Error ? error.message : String(error)),
    onChange: (familyID) => fired.push(familyID),
  });
  await writeFile(entry, "// touch\n" + (await readFile(entry, "utf8")));
  await Bun.sleep(100);
  expect(errors).toContain(
    "package changed since install (fingerprint mismatch)",
  );
  expect(fired).toEqual([]);
  await close();
});

test("discoverLocalToolFamilies finds installed packages under node_modules (scoped)", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-nodemodules-"));
  const installed = join(root, "node_modules", "@natalia", "tool-fixture");
  await mkdir(installed, { recursive: true });
  await writeFile(
    join(installed, "natalia.tool.json"),
    JSON.stringify({ entry: "index.ts" }),
  );
  await writeFile(join(installed, "index.ts"), "export default {};");
  const discovered = await discoverLocalToolFamilies(root);
  expect(discovered.map((entry) => entry.path)).toContain(
    join(installed, "natalia.tool.json"),
  );
});

test("discoverLocalToolFamilies follows a symlinked installed package", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tools-symlink-"));
  const actual = join(root, "real-pkg");
  await mkdir(actual, { recursive: true });
  await writeFile(
    join(actual, "natalia.tool.json"),
    JSON.stringify({ entry: "index.ts" }),
  );
  await writeFile(join(actual, "index.ts"), "export default {};");
  // npm links local file: specs as symlinks; Dirent.isDirectory() is false for
  // them, so the scan must follow.
  await mkdir(join(root, "node_modules", "@natalia"), { recursive: true });
  await Bun.$`ln -s ${actual} ${join(root, "node_modules", "@natalia", "tool-fixture")}`.quiet();
  const discovered = await discoverLocalToolFamilies(root);
  expect(discovered.map((entry) => entry.path)).toContain(
    join(actual, "natalia.tool.json"),
  );
});
