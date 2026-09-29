import { afterAll, expect, test } from "bun:test";
import {
  mkdirSync,
  mkdtempSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPOSITION_BASE_FILENAME,
  COMPOSITION_PROFILE_SCHEMA,
  compositionProfileHash,
  createCompositionRowRegistry,
  findBaseProfileFile,
  loadCompositionProfile,
  profileSearchCandidates,
  readCompositionLayer,
  requireBaseProfileFile,
  type CompositionRowRegistration,
  type CompositionProfile,
} from "../src/profile";
import { compositionRowRegistrations } from "../src/rows";

/**
 * P3 "base profile 随包机制" (interface spec §6): three layers, fixed
 * order, §6.2 whole-field override (never a priority merge), per-row
 * origin, and §6.4 activation fail-fast that names the file AND every
 * legal value. The real shipped base is loaded here too — the freshness
 * test that keeps composition.base.json and its consumer in step.
 */

let base = "";
afterAll(() => {
  if (base) rmSync(base, { recursive: true, force: true });
});

const envelope = (rows: unknown[]) =>
  JSON.stringify({ schema: COMPOSITION_PROFILE_SCHEMA, rows });

const sandboxReg: CompositionRowRegistration = {
  rowID: "anthelia.sandbox",
  implIDs: [],
  legalSummary: "mode ∈ read-only | workspace-write | danger-full-access",
  configSchema: {
    safeParse: (value) => {
      const mode = (value as { mode?: unknown }).mode;
      const legal = ["read-only", "workspace-write", "danger-full-access"];
      if (mode === undefined)
        return { success: true, data: { mode: "workspace-write" } };
      if (typeof mode === "string" && legal.includes(mode))
        return { success: true, data: { mode } };
      return {
        success: false,
        error: {
          issues: [{ message: `mode must be one of ${legal.join(", ")}` }],
        },
      };
    },
  },
};
const flagsReg: CompositionRowRegistration = {
  rowID: "natalia.test",
  implIDs: ["alpha", "beta"],
  legalSummary: "impl ∈ alpha | beta; config.flag ∈ true | false",
  configSchema: {
    safeParse: (value) => ({
      success: true,
      data: value as Record<string, unknown>,
    }),
  },
};

test("the registry enforces the four namespaces and rejects duplicates", () => {
  const registry = createCompositionRowRegistry([sandboxReg, flagsReg]);
  expect(registry.ids()).toEqual(["anthelia.sandbox", "natalia.test"]);
  expect(() => createCompositionRowRegistry([sandboxReg, sandboxReg])).toThrow(
    /registered twice/u,
  );
  expect(() =>
    createCompositionRowRegistry([{ ...sandboxReg, rowID: "random.thing" }]),
  ).toThrow(/four namespaces/u);
});

test("candidate search: env override first, then walk-up from script/binary/source dirs", () => {
  base = mkdtempSync(join(tmpdir(), "profile-search-"));
  const repo = join(base, "repo");
  const sourceDir = join(repo, "packages", "framework", "client", "src");
  mkdirSync(sourceDir, { recursive: true });
  writeFileSync(join(repo, COMPOSITION_BASE_FILENAME), envelope([]));
  const argvScript = join(repo, "dist", "main.js");
  mkdirSync(join(repo, "dist"), { recursive: true });
  writeFileSync(argvScript, "// entry\n");

  const explicit = join(base, "explicit.json");
  writeFileSync(explicit, envelope([]));
  const candidates = profileSearchCandidates({
    explicitFile: explicit,
    sourceDir,
    execPath: join(base, "elsewhere", "bun"),
    argvScript,
  });
  expect(candidates[0]).toBe(explicit); // the override leads the search…
  expect(findBaseProfileFile(candidates)).toBe(explicit); // …and wins when it exists
  // Without the override the dev walk still finds the repo-root base —
  // from the source dir, and from the script dir (argv) on a bundle run.
  expect(
    findBaseProfileFile(
      profileSearchCandidates({
        sourceDir,
        execPath: join(base, "elsewhere", "bun"),
        argvScript,
      }),
    ),
  ).toBe(join(repo, COMPOSITION_BASE_FILENAME));
  // A missing override does not shadow the walk (candidates stay in
  // order; the first EXISTING file wins).
  expect(
    findBaseProfileFile(
      profileSearchCandidates({
        explicitFile: join(base, "ghost.json"),
        sourceDir,
        execPath: join(base, "elsewhere", "bun"),
        argvScript,
      }),
    ),
  ).toBe(join(repo, COMPOSITION_BASE_FILENAME));
});

test("requireBaseProfileFile fails loudly, listing every path checked", () => {
  const error = (() => {
    try {
      requireBaseProfileFile([
        join(base, "nowhere", COMPOSITION_BASE_FILENAME),
      ]);
      return undefined;
    } catch (caught) {
      return caught as Error;
    }
  })();
  expect(error?.message).toMatch(/composition.base.json not found/u);
  expect(error?.message).toMatch(/NATALIA_BASE_PROFILE/u);
  expect(error?.message).toContain(
    join(base, "nowhere", COMPOSITION_BASE_FILENAME),
  );
});

test("three layers: whole-field override, config wholesale, origin = last definer", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "profile-ws-"));
  const home = mkdtempSync(join(tmpdir(), "profile-home-"));
  const appRoot = mkdtempSync(join(tmpdir(), "profile-app-"));
  const baseFile = join(appRoot, COMPOSITION_BASE_FILENAME);
  const userDir = join(home, ".natalia", "composition.d");
  const wsDir = join(workspace, ".natalia", "composition.d");
  mkdirSync(userDir, { recursive: true });
  mkdirSync(wsDir, { recursive: true });

  writeFileSync(
    baseFile,
    envelope([
      { id: "anthelia.sandbox", config: { mode: "workspace-write" } },
      {
        id: "natalia.test",
        impl: "alpha",
        config: { flag: false, label: "base" },
      },
    ]),
  );
  writeFileSync(
    join(userDir, "10-test.json"),
    envelope([
      // config omitted: it must NOT clobber the base's (field presence rules)
      { id: "natalia.test" },
    ]),
  );
  writeFileSync(
    join(wsDir, "20-later.json"),
    envelope([{ id: "anthelia.sandbox", config: { mode: "read-only" } }]),
  );
  writeFileSync(join(wsDir, "10-earlier.json"), envelope([]));
  // non-.json suffixes are ignored by convention (systemd's drop-in rule)
  writeFileSync(join(wsDir, "backup.json.bak"), "not even json");

  const registry = createCompositionRowRegistry([sandboxReg, flagsReg]);
  const profile = await loadCompositionProfile({
    baseFile,
    globalDir: userDir,
    workspaceDir: wsDir,
    registry,
  });
  expect(profile.schema).toBe(COMPOSITION_PROFILE_SCHEMA);
  expect(profile.hash).toBe(compositionProfileHash(profile.rows)); // §6.6 derivation at load
  const sandbox = profile.rows.find((row) => row.id === "anthelia.sandbox")!;
  expect(sandbox.config).toEqual({ mode: "read-only" });
  expect(sandbox.origin).toEqual({
    layer: "workspace",
    file: join(wsDir, "20-later.json"),
  });

  const flags = profile.rows.find((row) => row.id === "natalia.test")!;
  expect(flags.impl).toBe("alpha"); // the upper layer did not mention impl → lower value kept
  expect(flags.config).toEqual({ flag: false, label: "base" }); // config untouched when absent
  expect(flags.origin.layer).toBe("user"); // the last definer owns the attribution
  expect(profile.rows.map((row) => row.id)).toEqual([
    "anthelia.sandbox",
    "natalia.test",
  ]);
});

test("a symlinked drop-in loads (dotfiles repos symlink their .d entries)", async () => {
  const workspace = mkdtempSync(join(tmpdir(), "profile-link-"));
  const appRoot = mkdtempSync(join(tmpdir(), "profile-link-app-"));
  const store = join(workspace, "store");
  const wsDir = join(workspace, ".natalia", "composition.d");
  mkdirSync(store, { recursive: true });
  mkdirSync(wsDir, { recursive: true });
  const baseFile = join(appRoot, COMPOSITION_BASE_FILENAME);
  writeFileSync(
    baseFile,
    envelope([{ id: "anthelia.sandbox", config: { mode: "workspace-write" } }]),
  );
  const linked = join(store, "override.json");
  writeFileSync(
    linked,
    envelope([{ id: "anthelia.sandbox", config: { mode: "read-only" } }]),
  );
  symlinkSync(linked, join(wsDir, "10-link.json"));
  const profile = await loadCompositionProfile({
    baseFile,
    workspaceDir: wsDir,
    registry: createCompositionRowRegistry([sandboxReg]),
  });
  expect(profile.rows[0]!.config).toEqual({ mode: "read-only" });
});

test("activation fail-fast: bad envelope, unknown id/impl, bad config — file and legal values named", async () => {
  const dir = mkdtempSync(join(tmpdir(), "profile-errors-"));
  const registry = createCompositionRowRegistry([sandboxReg, flagsReg]);
  const baseFile = join(dir, "base.json");
  const load = (contents: string) => {
    writeFileSync(baseFile, contents);
    return loadCompositionProfile({ baseFile, registry });
  };

  await expect(
    load(JSON.stringify({ schema: "wrong/9", rows: [] })),
  ).rejects.toThrow(
    /has schema "wrong\/9" \(expected natalia\.composition-profile\/1\)/u,
  );

  await expect(load(envelope([{ id: "nope.ghost" }]))).rejects.toThrow(
    /not a registered composition row \(registered: anthelia.sandbox, natalia.test\)/u,
  );

  await expect(
    load(envelope([{ id: "natalia.test", impl: "gamma" }])),
  ).rejects.toThrow(
    /impl "gamma" is unknown \(impls for this row: alpha, beta\)/u,
  );

  // implIDs empty: the message says why (discovered, not selected)
  await expect(
    load(envelope([{ id: "anthelia.sandbox", impl: "landlock" }])),
  ).rejects.toThrow(/none — the backend is discovered at runtime/u);

  await expect(
    load(envelope([{ id: "anthelia.sandbox", config: { mode: "sideways" } }])),
  ).rejects.toThrow(
    /row "anthelia.sandbox" config invalid — mode must be one of read-only, workspace-write, danger-full-access — legal values: mode ∈ read-only \| workspace-write \| danger-full-access/u,
  );

  await expect(
    load(
      JSON.stringify({
        schema: COMPOSITION_PROFILE_SCHEMA,
        rows: [],
        extra: 1,
      }),
    ),
  ).rejects.toThrow(/unknown keys \[extra\] \(legal: schema, rows\)/u);

  await expect(
    load(envelope([{ id: "anthelia.sandbox", config: "not-an-object" }])),
  ).rejects.toThrow(/config must be an object/u);
});

test("the shipped base parses with the real confinement registration — and its value is today's default (no behavior change)", async () => {
  const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
  const {
    CONFINEMENT_COMPOSITION_ROW_ID,
    CONFINEMENT_MODES,
    confinementConfigSchema,
  } = await import("@anthelia/contracts");
  const profile = await loadCompositionProfile({
    baseFile: requireBaseProfileFile(
      profileSearchCandidates({
        sourceDir: import.meta.dir,
        execPath: process.execPath,
        argvScript: process.argv[1],
      }),
    ),
    registry: createCompositionRowRegistry([
      {
        rowID: CONFINEMENT_COMPOSITION_ROW_ID,
        implIDs: [],
        legalSummary: `mode ∈ ${CONFINEMENT_MODES.join(" | ")}`,
        configSchema: confinementConfigSchema,
      },
    ]),
  });
  const row = profile.rows.find(
    (candidate) => candidate.id === CONFINEMENT_COMPOSITION_ROW_ID,
  );
  expect(row).toBeDefined();
  // The shipped value equals the legacy default: landing this changes no
  // behavior until a user overlay says otherwise (acceptance: the CLI
  // keeps working exactly as before).
  expect(row!.config).toEqual({ mode: "workspace-write" });
  expect(row!.origin.layer).toBe("base");
  expect(
    requireBaseProfileFile([join(repoRoot, "composition.base.json")]),
  ).toBe(join(repoRoot, "composition.base.json"));
});

test("§6.6 composition hash: order-independent, origin-blind, content-sensitive, hex-64", async () => {
  // Build two profiles over the SAME logical rows: shuffled order and
  // different origins — the canonical form sorts and strips both.
  const rowsA = [
    {
      id: "anthelia.sandbox",
      config: { mode: "read-only" },
      origin: { layer: "base" as const, file: "/a" },
    },
    {
      id: "natalia.thing",
      impl: "alpha",
      origin: { layer: "user" as const, file: "/b" },
    },
  ] as CompositionProfile["rows"];
  const rowsB = [
    {
      id: "natalia.thing",
      impl: "alpha",
      origin: { layer: "workspace" as const, file: "/c" },
    },
    {
      id: "anthelia.sandbox",
      config: { mode: "read-only" },
      origin: { layer: "workspace" as const, file: "/d" },
    },
  ] as CompositionProfile["rows"];
  const hashA = compositionProfileHash(rowsA);
  const hashB = compositionProfileHash(rowsB);
  expect(hashA).toBe(hashB);
  expect(hashA).toMatch(/^[0-9a-f]{64}$/u);
  // a content change (a config value) changes the hash
  const rowsC = [
    {
      id: "anthelia.sandbox",
      config: { mode: "workspace-write" },
      origin: { layer: "base" as const, file: "/a" },
    },
    {
      id: "natalia.thing",
      impl: "alpha",
      origin: { layer: "user" as const, file: "/b" },
    },
  ] as CompositionProfile["rows"];
  expect(compositionProfileHash(rowsC)).not.toBe(hashA);
  // a dropped field changes it too (disabled absent ≠ present)
  const rowsD = [
    ...rowsA.slice(0, 1),
    { ...rowsA[1]!, disabled: false },
  ] as CompositionProfile["rows"];
  expect(compositionProfileHash(rowsD)).not.toBe(hashB);
});

test("the objectstore backend row: a legal impl binds, an unknown one names the legal pair", async () => {
  // The REAL registration (rows.ts = the single source): its implIDs
  // are the legal set the loader's fail-fast must name (§6.4).
  const registry = createCompositionRowRegistry(compositionRowRegistrations);
  const dir = mkdtempSync(join(tmpdir(), "osrow-"));
  try {
    const baseFile = join(dir, "composition.base.json");
    writeFileSync(
      baseFile,
      envelope([{ id: "anthelia.objectstore", impl: "rust" }]),
    );
    const bound = await loadCompositionProfile({ baseFile, registry });
    const row = bound.rows.find(
      (candidate) => candidate.id === "anthelia.objectstore",
    );
    expect(row?.impl).toBe("rust");
    expect(bound.hash).toBe(compositionProfileHash(bound.rows));

    writeFileSync(
      baseFile,
      envelope([{ id: "anthelia.objectstore", impl: "banana" }]),
    );
    await expect(
      loadCompositionProfile({ baseFile, registry }),
    ).rejects.toThrow(
      // the error must name BOTH legal values (§6.4), whatever the phrasing
      /typescript[\s\S]*rust|rust[\s\S]*typescript/u,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});

test("readCompositionLayer validates one layer before it becomes one", async () => {
  const registry = createCompositionRowRegistry(compositionRowRegistrations);
  const dir = mkdtempSync(join(tmpdir(), "composition-layer-"));
  try {
    const legal = join(dir, "legal.json");
    writeFileSync(
      legal,
      envelope([{ id: "anthelia.objectstore", impl: "rust" }]),
    );
    // The same validation loadCompositionProfile applies per layer —
    // including the unknown-key and bad-config refusals, so a face that
    // validates before writing (§6.4's earliest point) gets them too.
    expect(await readCompositionLayer(legal, registry)).toEqual([
      { id: "anthelia.objectstore", impl: "rust" },
    ]);

    const unknownRow = join(dir, "unknown-row.json");
    writeFileSync(unknownRow, envelope([{ id: "anthelia.nope" }]));
    await expect(readCompositionLayer(unknownRow, registry)).rejects.toThrow(
      /anthelia\.nope.*not a registered composition row \(registered: anthelia\.objectstore, anthelia\.sandbox\)/,
    );

    const badEnvelope = join(dir, "bad-envelope.json");
    writeFileSync(badEnvelope, JSON.stringify({ rows: [] }));
    await expect(readCompositionLayer(badEnvelope, registry)).rejects.toThrow(
      /has schema undefined \(expected natalia\.composition-profile\/1\)/,
    );

    const badRows = join(dir, "bad-rows.json");
    writeFileSync(
      badRows,
      JSON.stringify({ schema: COMPOSITION_PROFILE_SCHEMA, rows: {} }),
    );
    await expect(readCompositionLayer(badRows, registry)).rejects.toThrow(
      /rows must be an array/,
    );
  } finally {
    rmSync(dir, { recursive: true, force: true });
  }
});
