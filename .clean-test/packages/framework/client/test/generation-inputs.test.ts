import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { createTestContext } from "@anthelia/runtime-services";
import {
  compositionProfile,
  type CompositionProfile,
} from "@anthelia/composition";
import type { RuntimeContext } from "@anthelia/substrate";
import {
  generationAdapterRows,
  generationPrompts,
} from "../src/runtime/generation-inputs";

/**
 * The generation's prompt/adapter producers (NGM study §4.1): the hashes
 * must come from the SAME sources the runtime reads — the static prompts
 * the model would be given and the loader's own document hashes — and the
 * seam rows must be the live profile's effective selection.
 */

let root = "";
afterAll(() => {
  if (root) rm(root, { recursive: true, force: true });
});

test("generationPrompts hashes the roles and the instruction documents", async () => {
  root = await mkdtemp(join(tmpdir(), "generation-prompts-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  const agents = "# Agents\n\nBe exact.\n";
  const constitution = "# Constitution\n\nNever commit without approval.\n";
  await writeFile(join(root, "AGENTS.md"), agents);
  await writeFile(join(root, ".natalia", "constitution.md"), constitution);

  const prompts = generationPrompts(root);
  // One hash per role's static prompt, all sha256-hex.
  expect(Object.keys(prompts.perRoleStatic).sort()).toEqual([
    "natalia",
    "navi",
    "nia",
  ]);
  for (const hash of Object.values(prompts.perRoleStatic))
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  // The documents carry the loader's own hashes — the generation
  // addresses exactly what the turn runner would have read.
  const byPath = new Map(prompts.docs.map((doc) => [doc.path, doc.sha256]));
  expect([...byPath.keys()].sort()).toEqual([
    ".natalia/constitution.md",
    "AGENTS.md",
  ]);
  // The loader's own change-detection hash (sha256, truncated), passed
  // through: the generation addresses the content under the runtime's
  // name for it, not a second hash of the same bytes.
  const loaderHash = (content: string) =>
    createHash("sha256").update(content).digest("hex").slice(0, 16);
  expect(byPath.get("AGENTS.md")).toBe(loaderHash(agents));
  expect(byPath.get(".natalia/constitution.md")).toBe(loaderHash(constitution));
  // Deterministic: the same tree hashes the same.
  expect(generationPrompts(root)).toEqual(prompts);
});

test("a workspace without instruction documents hashes only the roles", async () => {
  root = await mkdtemp(join(tmpdir(), "generation-prompts-empty-"));
  const prompts = generationPrompts(root);
  expect(prompts.docs).toEqual([]);
  expect(Object.keys(prompts.perRoleStatic)).toHaveLength(3);
});

test("generationAdapterRows reads the live profile's seam selection", () => {
  const profile = {
    schema: "natalia.composition-profile/1",
    hash: "h",
    rows: [
      {
        id: "anthelia.objectstore",
        impl: "rust",
        origin: { layer: "base", file: "composition.base.json" },
      },
      {
        id: "anthelia.sandbox",
        config: { mode: "workspace-write" },
        origin: { layer: "base", file: "composition.base.json" },
      },
    ],
  } as unknown as CompositionProfile;
  const ctx = {
    state: {
      serviceDirectory: createTestContext([compositionProfile.mock(profile)]),
    },
  } as unknown as RuntimeContext;
  // The impl selection rides along; a row without one records none (the
  // runtime-discovered backend's shape) rather than inventing a value.
  expect(generationAdapterRows(ctx)).toEqual([
    { id: "anthelia.objectstore", impl: "rust" },
    { id: "anthelia.sandbox" },
  ]);
});

test("no profile means no adapters (the boot that never loaded one)", () => {
  const ctx = {
    state: { serviceDirectory: createTestContext([]) },
  } as unknown as RuntimeContext;
  expect(generationAdapterRows(ctx)).toEqual([]);
});
