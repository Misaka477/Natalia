import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  COMPOSITION_PROFILE_SCHEMA,
  type CompositionProfile,
} from "@anthelia/composition";
import {
  ObjectStore,
  objectStoreBackendStatus,
  rustCas,
} from "@anthelia/object-store";
import {
  applyCompositionObjectStoreBackend,
  objectStoreBackendFromProfile,
} from "../src/runtime/initialize/object-store-backend";

/**
 * Decision17 for the store backend: the CODE registers {typescript,
 * rust}, the DATA binds one. Absence = TypeScript (no row, nothing
 * changes), a hand-built unknown impl gets an error (the loader would
 * have rejected it first — a silent downgrade would hide a bug), and
 * the precedence is pinned: the env seam (the mode runner's demand)
 * beats the configured selection beats the default.
 */

const profile = (rows: CompositionProfile["rows"]): CompositionProfile => ({
  schema: COMPOSITION_PROFILE_SCHEMA,
  rows,
  hash: "test-hash",
});

const ORIGIN = { layer: "user" as const, file: "synthetic" };

const ROOTS: string[] = [];
afterAll(() => {
  for (const root of ROOTS) rmSync(root, { recursive: true, force: true });
});

beforeAll(async () => {
  await rustCas.ensureBuilt();
});

const previousEnv = process.env.NATALIA_OBJECT_STORE_BACKEND;

test("the reader: absence and disabled mean TypeScript; the two legal impls bind; unknown errors", () => {
  expect(objectStoreBackendFromProfile(undefined)).toBe("typescript");
  expect(
    objectStoreBackendFromProfile(
      profile([{ id: "anthelia.sandbox", origin: ORIGIN }]),
    ),
  ).toBe("typescript");
  expect(
    objectStoreBackendFromProfile(
      profile([{ id: "anthelia.objectstore", impl: "rust", origin: ORIGIN }]),
    ),
  ).toBe("rust");
  expect(
    objectStoreBackendFromProfile(
      profile([
        { id: "anthelia.objectstore", impl: "typescript", origin: ORIGIN },
      ]),
    ),
  ).toBe("typescript");
  expect(
    objectStoreBackendFromProfile(
      profile([
        {
          id: "anthelia.objectstore",
          impl: "rust",
          disabled: true,
          origin: ORIGIN,
        },
      ]),
    ),
  ).toBe("typescript");
  expect(() =>
    objectStoreBackendFromProfile(
      profile([{ id: "anthelia.objectstore", impl: "banana", origin: ORIGIN }]),
    ),
  ).toThrow(/typescript[\s\S]*rust|rust[\s\S]*typescript/u);
});

test("apply configures the store; the env seam beats the configured selection; unset restores", () => {
  delete process.env.NATALIA_OBJECT_STORE_BACKEND;
  try {
    applyCompositionObjectStoreBackend(
      profile([
        { id: "anthelia.objectstore", impl: "typescript", origin: ORIGIN },
      ]),
    );
    expect(objectStoreBackendStatus()).toBe("typescript");

    applyCompositionObjectStoreBackend(
      profile([{ id: "anthelia.objectstore", impl: "rust", origin: ORIGIN }]),
    );
    expect(objectStoreBackendStatus()).toBe("rust");

    // precedence: an explicit env demand outranks the row (POSIX-ish,
    // and the mode runner needs it)
    process.env.NATALIA_OBJECT_STORE_BACKEND = "rust";
    applyCompositionObjectStoreBackend(undefined);
    expect(objectStoreBackendStatus()).toBe("rust");

    // unset: back to the honest default
    delete process.env.NATALIA_OBJECT_STORE_BACKEND;
    applyCompositionObjectStoreBackend(undefined);
    expect(objectStoreBackendStatus()).toBe("typescript");

    // a store constructed under the configured rust demand takes the
    // rust path (the flag is read at construction) and behaves
    applyCompositionObjectStoreBackend(
      profile([{ id: "anthelia.objectstore", impl: "rust", origin: ORIGIN }]),
    );
    const root = mkdtempSync(join(tmpdir(), "backend-row-"));
    ROOTS.push(root);
    const store = new ObjectStore(join(root, "objects"));
    void store;
    expect(objectStoreBackendStatus()).toBe("rust");
  } finally {
    applyCompositionObjectStoreBackend(undefined);
    if (previousEnv === undefined)
      delete process.env.NATALIA_OBJECT_STORE_BACKEND;
    else process.env.NATALIA_OBJECT_STORE_BACKEND = previousEnv;
  }
});
