import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPOSITION_PROFILE_SCHEMA,
  compositionRowRegistrations,
  createCompositionRowRegistry,
} from "@anthelia/composition";
import {
  applyCompositionPatch,
  compositionRegistry,
  compositionRowViews,
  compositionStatus,
  switchCompositionRow,
} from "../src/composition-cli";

/**
 * Decision 12's v1 CLI face. The machine is the boot's own (one shared
 * registry, the three-layer load, §6.4 fail-fast) — these tests pin the
 * FACE: what list shows, that status reads three layers with origin,
 * that apply validates BEFORE it becomes a layer, and that switch is
 * the factory selection with every legal value named on refusal.
 */

let base = "";
afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

function workspace(): string {
  base = base || mkdtempSync(join(tmpdir(), "composition-cli-"));
  const dir = join(base, `ws-${Math.random().toString(36).slice(2, 8)}`);
  mkdirSync(dir, { recursive: true });
  return dir;
}

function baseFile(rows: unknown[]): string {
  const dir = mkdtempSync(join(tmpdir(), "composition-base-"));
  const file = join(dir, "composition.base.json");
  writeFileSync(
    file,
    JSON.stringify({ schema: COMPOSITION_PROFILE_SCHEMA, rows }, null, 2),
  );
  return file;
}

const registry = () =>
  createCompositionRowRegistry(compositionRowRegistrations);

const baseRows = [
  { id: "anthelia.sandbox", config: { mode: "workspace-write" } },
  { id: "anthelia.objectstore", impl: "typescript" },
];

test("list shows every registered row with its legal values", () => {
  const rows = compositionRowViews(registry());
  // The response-cache row left with its feature: its replay erased the tool
  // calls it cached, so the row selected nothing worth keeping.
  expect(rows.map((row) => row.rowID)).toEqual([
    "anthelia.objectstore",
    "anthelia.sandbox",
  ]);
  const objectstore = rows.find((row) => row.rowID === "anthelia.objectstore")!;
  expect(objectstore.implIDs).toEqual(["typescript", "rust"]);
  expect(objectstore.legalSummary).toContain("typescript | rust");
  // The confinement row's backend is discovered at runtime, not selected.
  const sandbox = rows.find((row) => row.rowID === "anthelia.sandbox")!;
  expect(sandbox.implIDs).toEqual([]);
});

test("status reads the three layers with per-row origin", async () => {
  const ws = workspace();
  const home = join(ws, "home");
  const globalDir = join(home, ".natalia", "composition.d");
  const workspaceDir = join(ws, ".natalia", "composition.d");
  mkdirSync(globalDir, { recursive: true });
  mkdirSync(workspaceDir, { recursive: true });
  writeFileSync(
    join(globalDir, "10-user.json"),
    JSON.stringify({
      schema: COMPOSITION_PROFILE_SCHEMA,
      rows: [{ id: "anthelia.objectstore", impl: "typescript" }],
    }),
  );
  writeFileSync(
    join(workspaceDir, "20-mine.json"),
    JSON.stringify({
      schema: COMPOSITION_PROFILE_SCHEMA,
      rows: [{ id: "anthelia.objectstore", impl: "rust" }],
    }),
  );

  const status = await compositionStatus({
    workspace: ws,
    home,
    baseFile: baseFile(baseRows),
    registry: registry(),
  });
  const objectstore = status.rows.find(
    (row) => row.id === "anthelia.objectstore",
  )!;
  // The workspace layer wins (systemd's `.d` discipline), and the origin
  // says so — "the shipped default" vs "your override" is provenance.
  expect(objectstore.impl).toBe("rust");
  expect(objectstore.origin.layer).toBe("workspace");
  expect(objectstore.origin.file).toBe(join(workspaceDir, "20-mine.json"));
  const sandbox = status.rows.find((row) => row.id === "anthelia.sandbox")!;
  expect(sandbox.origin.layer).toBe("base");
  expect(status.hash).toMatch(/^[0-9a-f]{64}$/);
});

test("apply validates before the patch becomes a layer", async () => {
  const ws = workspace();
  const bad = join(ws, "bad.json");
  writeFileSync(
    bad,
    JSON.stringify({
      schema: COMPOSITION_PROFILE_SCHEMA,
      rows: [{ id: "anthelia.nope", impl: "wood" }],
    }),
  );
  // §6.4's fail-fast at the earliest resolvable point: the refusal names
  // the registered rows, and nothing was written into the layer.
  await expect(
    applyCompositionPatch({ file: bad, workspace: ws, registry: registry() }),
  ).rejects.toThrow(/anthelia.nope.*registered/);
  expect(existsSync(join(ws, ".natalia", "composition.d", "bad.json"))).toBe(
    false,
  );

  const good = join(ws, "good.json");
  writeFileSync(
    good,
    JSON.stringify({
      schema: COMPOSITION_PROFILE_SCHEMA,
      rows: [{ id: "anthelia.objectstore", impl: "rust" }],
    }),
  );
  const result = await applyCompositionPatch({
    file: good,
    workspace: ws,
    registry: registry(),
  });
  expect(result.file).toBe(join(ws, ".natalia", "composition.d", "good.json"));
  expect(result.rows).toEqual([{ id: "anthelia.objectstore", impl: "rust" }]);
});

test("apply refuses a drop-in name that would escape the layer", async () => {
  const ws = workspace();
  const file = join(ws, "escape.json");
  writeFileSync(
    file,
    JSON.stringify({
      schema: COMPOSITION_PROFILE_SCHEMA,
      rows: [{ id: "anthelia.objectstore", impl: "rust" }],
    }),
  );
  await expect(
    applyCompositionPatch({
      file,
      workspace: ws,
      name: "../escape.json",
      registry: registry(),
    }),
  ).rejects.toThrow(/bare filename/);
  expect(existsSync(join(ws, ".natalia", "escape.json"))).toBe(false);
});

test("switch selects a legal impl and lands one row file", async () => {
  const ws = workspace();
  const result = await switchCompositionRow({
    rowID: "anthelia.objectstore",
    impl: "rust",
    workspace: ws,
    registry: registry(),
  });
  expect(result.file).toBe(
    join(ws, ".natalia", "composition.d", "row-anthelia.objectstore.json"),
  );
  // The staged copy is a means; the layer file is the fact.
  expect(existsSync(result.file)).toBe(true);
  const status = await compositionStatus({
    workspace: ws,
    home: join(ws, "absent-home"),
    baseFile: baseFile(baseRows),
    registry: registry(),
  });
  const objectstore = status.rows.find(
    (row) => row.id === "anthelia.objectstore",
  )!;
  expect(objectstore.impl).toBe("rust");
  expect(objectstore.origin.layer).toBe("workspace");
});

test("switch refuses an illegal impl and an unknown row, naming the legal set", async () => {
  const ws = workspace();
  await expect(
    switchCompositionRow({
      rowID: "anthelia.objectstore",
      impl: "wood",
      workspace: ws,
      registry: registry(),
    }),
  ).rejects.toThrow(/typescript, rust/);
  await expect(
    switchCompositionRow({
      rowID: "anthelia.nope",
      workspace: ws,
      registry: registry(),
    }),
  ).rejects.toThrow(/anthelia.objectstore/);
  // Neither refusal wrote anything into the layer.
  const layer = join(ws, ".natalia", "composition.d");
  expect(existsSync(layer)).toBe(false);
});
