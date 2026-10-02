import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { censusFromWorkspace, layerCensus } from "../src/layer-census";

/**
 * P4 "doctor 报告层名": the census must testify truthfully in every
 * context — build manifest first (installed builds bake it, the engine
 * lives inside the bundle), live workspace scopes second (source
 * checkout), and honest emptiness when neither exists.
 */

let base = "";

beforeAll(async () => {
  base = await mkdtemp(join(tmpdir(), "layer-census-"));
});

afterAll(() => {
  rm(base, { recursive: true, force: true });
});

test("the build manifest is the primary source (installed context)", async () => {
  const root = join(base, "installed");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      name: "natalia",
      version: "1.2.3",
      layers: {
        anthelia: ["@anthelia/substrate"],
        natalia: ["@natalia/collab"],
      },
    }),
  );
  const census = await layerCensus([root, join(base, "nonexistent")]);
  expect(census.source).toBe("manifest");
  expect(census.anthelia).toEqual(["@anthelia/substrate"]);
  expect(census.natalia).toEqual(["@natalia/collab"]);
  expect(census.roots[0]).toContain("manifest.json");
  // DoD #4: the build identity rides the SAME manifest as the layers —
  // an incident bundle names the build that produced it.
  expect(census.version).toBe("1.2.3");
});

test("the target rides along when the manifest carries one", async () => {
  const root = join(base, "targeted");
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "manifest.json"),
    JSON.stringify({
      name: "natalia",
      version: "0.0.0-m14",
      target: "linux-x64",
      layers: { anthelia: [], natalia: [] },
    }),
  );
  const census = await layerCensus([root]);
  expect(census.version).toBe("0.0.0-m14");
  expect(census.target).toBe("linux-x64");
});

test("a source checkout has no baked version — absent stays absent", async () => {
  const root = join(base, "no-manifest");
  await mkdir(join(root, "node_modules", "@anthelia", "substrate"), {
    recursive: true,
  });
  const census = await layerCensus([root]);
  expect(census.source).toBe("node_modules");
  expect(census.version).toBeUndefined();
  expect(census.target).toBeUndefined();
});

test("live workspace scopes testify when no manifest exists", async () => {
  const root = join(base, "checkout");
  await mkdir(join(root, "node_modules", "@anthelia", "substrate"), {
    recursive: true,
  });
  await mkdir(join(root, "node_modules", "@natalia", "collab"), {
    recursive: true,
  });
  await mkdir(join(root, "node_modules", "@natalia", "zzz-other"), {
    recursive: true,
  });
  const census = await layerCensus([root]);
  expect(census.source).toBe("node_modules");
  expect(census.anthelia).toEqual(["@anthelia/substrate"]);
  expect(census.natalia).toEqual(["@natalia/collab", "@natalia/zzz-other"]);
});

test("neither source: honestly empty, no guessing", async () => {
  const census = await layerCensus([join(base, "void")]);
  expect(census).toEqual({
    source: "none",
    roots: [],
    anthelia: [],
    natalia: [],
  });
});

test("the build-time census walks a workspace's packages by prefix", async () => {
  const root = join(base, "ws");
  await mkdir(join(root, "pkgs", "a"), { recursive: true });
  await mkdir(join(root, "pkgs", "deep", "b"), { recursive: true });
  await mkdir(join(root, "pkgs", "plain"), { recursive: true });
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({ workspaces: ["pkgs/*"] }),
  );
  await writeFile(
    join(root, "pkgs", "a", "package.json"),
    JSON.stringify({ name: "@anthelia/a" }),
  );
  await writeFile(
    join(root, "pkgs", "deep", "b", "package.json"),
    JSON.stringify({ name: "@natalia/b" }),
  );
  await writeFile(
    join(root, "pkgs", "plain", "package.json"),
    JSON.stringify({ name: "plain-no-scope" }),
  );
  const { anthelia, natalia } = await censusFromWorkspace(root);
  expect(anthelia).toEqual(["@anthelia/a"]);
  expect(natalia).toEqual(["@natalia/b"]);
});
