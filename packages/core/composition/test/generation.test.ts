import { expect, test } from "bun:test";
import { ObjectStore } from "@anthelia/object-store";
import {
  GENERATION_SCHEMA,
  type Generation,
  type RuntimeEvent,
} from "@anthelia/contracts";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildGeneration,
  deriveCompositionPointer,
  loadGeneration,
  parseGeneration,
  serializeGeneration,
  storeGeneration,
} from "../src/index";

function testStore(): { root: string; store: ObjectStore } {
  const root = mkdtempSync(join(tmpdir(), "natalia-composition-"));
  return { root, store: new ObjectStore(root) };
}

// Bun's sync mkdtemp keeps the helper honest across platforms.
import { mkdtempSync } from "node:fs";

const CONFIG = {
  version: 3,
  runtime: { terminal: { backend: "pty" as const } },
} as unknown as Generation["config"];

const CATALOG = [
  { id: "natalia-skills", enabled: true, fingerprint: "fp-skills" },
  { id: "natalia-team", enabled: false, fingerprint: "fp-team" },
];

const PROMPTS = {
  perRoleStatic: { natalia: "h-natalia", navi: "h-navi", nia: "h-nia" },
  docs: [{ path: "AGENTS.md", sha256: "h-agents" }],
};

const ROWS = [
  { id: "anthelia.objectstore", impl: "rust" },
  { id: "anthelia.sandbox" },
];

test("serialize and parse round-trip a generation", () => {
  const generation = buildGeneration({
    config: CONFIG,
    catalog: CATALOG,
    policyRows: [],
    prompts: PROMPTS,
  });
  const parsed = parseGeneration(serializeGeneration(generation));
  expect(parsed).toEqual(generation);
  expect(parsed.schema).toBe(GENERATION_SCHEMA);
});

test("the catalog is stored sorted, so entry order never changes the id", () => {
  const a = buildGeneration({
    config: CONFIG,
    catalog: CATALOG,
    policyRows: [],
    prompts: PROMPTS,
  });
  const b = buildGeneration({
    config: CONFIG,
    catalog: [...CATALOG].reverse(),
    policyRows: [],
    prompts: PROMPTS,
  });
  expect(serializeGeneration(a)).toBe(serializeGeneration(b));
});

test("storing identical content yields the identical id", async () => {
  const { root, store } = testStore();
  try {
    const a = buildGeneration({
      config: CONFIG,
      catalog: CATALOG,
      policyRows: [],
      prompts: PROMPTS,
    });
    const b = buildGeneration({
      config: CONFIG,
      catalog: CATALOG,
      policyRows: [],
      prompts: PROMPTS,
    });
    const first = await storeGeneration(store, a);
    const second = await storeGeneration(store, b);
    expect(first).toBe(second);
    const loaded = await loadGeneration(store, first);
    expect(loaded.plugins.map(({ id }) => id)).toEqual([
      "natalia-skills",
      "natalia-team",
    ]);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed config is a different generation", async () => {
  const { root, store } = testStore();
  try {
    const first = await storeGeneration(
      store,
      buildGeneration({
        config: CONFIG,
        catalog: CATALOG,
        policyRows: [],
        prompts: PROMPTS,
      }),
    );
    const second = await storeGeneration(
      store,
      buildGeneration({
        config: {
          ...CONFIG,
          runtime: { terminal: { backend: "wezterm", windowMode: "auto" } },
        } as Generation["config"],
        catalog: CATALOG,
        policyRows: [],
        prompts: PROMPTS,
      }),
    );
    expect(second).not.toBe(first);
    expect(await store.has(first)).toBe(true);
    expect(await store.has(second)).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("parseGeneration rejects a foreign schema", () => {
  expect(() =>
    parseGeneration(JSON.stringify({ schema: "other/1", plugins: [] })),
  ).toThrow(/unknown generation schema/);
});

test("the pointer derives from the last switch, previous from its from", () => {
  const pointer = deriveCompositionPointer([
    { type: "session.created" } as unknown as RuntimeEvent,
    switched("gen-a", undefined, "config.reload"),
    switched("gen-b", "gen-a", "config.reload"),
    switched("gen-c", "gen-b", "rollback"),
  ]);
  expect(pointer).toEqual({ current: "gen-c", previous: "gen-b" });
});

test("a proposal that never commits stays the candidate", () => {
  const pointer = deriveCompositionPointer([
    switched("gen-a", undefined, "config.reload"),
    proposed("gen-b", "agent.proposal"),
  ]);
  expect(pointer).toEqual({
    current: "gen-a",
    previous: undefined,
    candidate: "gen-b",
  });
});

test("a committed proposal stops being the candidate", () => {
  const pointer = deriveCompositionPointer([
    switched("gen-a", undefined, "config.reload"),
    proposed("gen-b", "agent.proposal"),
    switched("gen-b", "gen-a", "config.reload"),
  ]);
  expect(pointer.candidate).toBeUndefined();
  expect(pointer.current).toBe("gen-b");
});

test("the latest proposal wins as the candidate", () => {
  const pointer = deriveCompositionPointer([
    proposed("gen-x", "agent.proposal"),
    proposed("gen-y", "agent.proposal"),
  ]);
  expect(pointer.candidate).toBe("gen-y");
});

test("a stream without switches has no pointer", () => {
  expect(deriveCompositionPointer([])).toEqual({});
});

test("the first switch has no previous", () => {
  const pointer = deriveCompositionPointer([
    switched("gen-a", undefined, "config.reload"),
  ]);
  expect(pointer).toEqual({ current: "gen-a" });
});

function proposed(candidateID: string, reason: string): RuntimeEvent {
  return {
    type: "composition.proposed",
    candidateID,
    reason,
  } as unknown as RuntimeEvent;
}

function switched(
  to: string,
  from: string | undefined,
  reason: string,
): RuntimeEvent {
  return {
    type: "composition.switched",
    to,
    ...(from ? { from } : {}),
    reason,
  } as unknown as RuntimeEvent;
}

test("the prompt surface and the seam rows ride inside the generation", () => {
  const generation = buildGeneration({
    config: CONFIG,
    catalog: CATALOG,
    policyRows: [],
    prompts: PROMPTS,
    rows: ROWS,
  });
  expect(generation.prompts).toEqual(PROMPTS);
  // The seam selection, one entry per row; an absent impl is recorded as
  // absent (the runtime-discovered backend's shape), not invented.
  expect(generation.adapters).toEqual({
    "anthelia.objectstore": { impl: "rust" },
    "anthelia.sandbox": {},
  });
});

test("a changed prompt hash is a different generation", async () => {
  const { root, store } = testStore();
  try {
    const first = await storeGeneration(
      store,
      buildGeneration({
        config: CONFIG,
        catalog: CATALOG,
        policyRows: [],
        prompts: PROMPTS,
      }),
    );
    const second = await storeGeneration(
      store,
      buildGeneration({
        config: CONFIG,
        catalog: CATALOG,
        policyRows: [],
        prompts: {
          ...PROMPTS,
          perRoleStatic: { ...PROMPTS.perRoleStatic, navi: "h-navi-edited" },
        },
      }),
    );
    // The cache-aware rule needs exactly this: a prompt edit moves the
    // generation, so the RINA scope invalidates instead of serving the
    // old prompts.
    expect(second).not.toBe(first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a changed adapter selection is a different generation", async () => {
  const { root, store } = testStore();
  try {
    const first = await storeGeneration(
      store,
      buildGeneration({
        config: CONFIG,
        catalog: CATALOG,
        policyRows: [],
        prompts: PROMPTS,
        rows: ROWS,
      }),
    );
    const second = await storeGeneration(
      store,
      buildGeneration({
        config: CONFIG,
        catalog: CATALOG,
        policyRows: [],
        prompts: PROMPTS,
        rows: [{ id: "anthelia.objectstore", impl: "typescript" }],
      }),
    );
    expect(second).not.toBe(first);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a legacy generation without prompts or adapters still reads", () => {
  // Fail-soft, documented like the policyRows path: an older generation
  // reads as carrying none, and its hash simply differs from a current
  // one — the surface moved, and the difference is visible.
  const legacy = JSON.stringify({
    schema: GENERATION_SCHEMA,
    config: CONFIG,
    plugins: [{ id: "natalia-skills", enabled: true, fingerprint: "fp" }],
  });
  const parsed = parseGeneration(legacy);
  expect(parsed.prompts).toEqual({ perRoleStatic: {}, docs: [] });
  expect(parsed.adapters).toEqual({});
  expect(parsed.policyRows).toEqual([]);
});

test("G6's declarative caps: a row's declared capabilities ride inside the generation", () => {
  const generation = buildGeneration({
    config: CONFIG,
    catalog: CATALOG,
    policyRows: [],
    prompts: PROMPTS,
    rows: ROWS,
    rowCaps: {
      "anthelia.objectstore": { packRead: true, incrementalGc: true },
    },
  });
  // The snapshot rides with the binding: the generation records what the
  // selected impl can swear to, and the TypeScript binding declares none.
  expect(generation.adapters["anthelia.objectstore"]).toEqual({
    impl: "rust",
    caps: { packRead: true, incrementalGc: true },
  });
  expect(generation.adapters["anthelia.sandbox"]).toEqual({});
});

test("a capability nobody registered is a compose-time refusal", () => {
  expect(() =>
    buildGeneration({
      config: CONFIG,
      catalog: CATALOG,
      policyRows: [],
      prompts: PROMPTS,
      rows: ROWS,
      rowCaps: {
        "anthelia.objectstore": { mindReading: true },
      },
    }),
  ).toThrow(/declares unknown capability "mindReading"/);
  // And an unregistered ROW cannot declare anything at all.
  expect(() =>
    buildGeneration({
      config: CONFIG,
      catalog: CATALOG,
      policyRows: [],
      prompts: PROMPTS,
      rows: ROWS,
      rowCaps: { "anthelia.not-a-row": { anything: true } },
    }),
  ).toThrow(/declares unknown capability "anything"/);
});
