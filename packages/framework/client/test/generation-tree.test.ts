import { expect, test } from "bun:test";
import { createHash } from "node:crypto";
import { resolve } from "node:path";
import type { GenerationTreeFile } from "@anthelia/contracts";

/**
 * The absolute path the engine resolves a file to.
 *
 * The engine resolves with node:path, so on Windows the answer is
 * drive-absolute ("E:\\repo\\a.ts") and a key spelled "/repo/a.ts"
 * matches nothing — every plan then sees a workspace that is absent and
 * produces no writes. Spelling the keys with the same resolve() asks the
 * same question on every platform.
 */
const at = (...segments: string[]) => resolve("/repo", ...segments);
import {
  planTreePromotion,
  treeConflictReason,
  type TreePromotionInput,
} from "../src/runtime/generation-tree";

/**
 * The tree promotion engine — the L3 code lane on our own infrastructure.
 * Studied from git (the three-way merge), rebuilt on what we already have
 * (the object store's sha256 addressing): workspace==base takes the tree's
 * content, workspace==next is already landed, anything else is a named
 * conflict that refuses the whole promotion before the first write.
 */

const hash = (text: string) => createHash("sha256").update(text).digest("hex");
const BASE = hash("base");
/** The tree's content hash — the store maps it to the bytes it addresses. */
const NEXT = hash("next content");

/** A workspace whose files are the given text, and a store holding the tree's content. */
function harness(input: {
  workspace: Record<string, string>;
  files: readonly GenerationTreeFile[];
}) {
  const store = new Map<string, string>([[NEXT, "next content"]]);
  const plan = (over?: Partial<TreePromotionInput>) =>
    planTreePromotion({
      root: "/repo",
      files: input.files,
      readWorkspace: async (abs) => {
        const text = input.workspace[abs];
        return text === undefined ? undefined : Buffer.from(text);
      },
      readContent: async (key) => Buffer.from(store.get(key) ?? ""),
      hash: (bytes) => createHash("sha256").update(bytes).digest("hex"),
      ...over,
    });
  return { plan, store };
}

test("workspace at the base takes the tree's content", async () => {
  const { plan } = harness({
    workspace: { [at("a.ts")]: "base" },
    files: [{ path: "a.ts", next: NEXT, base: BASE }],
  });
  const result = await plan();
  expect(result.writes).toHaveLength(1);
  expect(result.writes[0]!.abs).toBe(at("a.ts"));
  expect(result.writes[0]!.content.toString()).toBe("next content");
  expect(result.conflicts).toHaveLength(0);
});

test("workspace already at the tree's content is a no-op (idempotent)", async () => {
  const { plan } = harness({
    workspace: { [at("a.ts")]: "next content" },
    files: [{ path: "a.ts", next: NEXT, base: BASE }],
  });
  const result = await plan();
  expect(result.writes).toHaveLength(0);
  expect(result.unchanged).toEqual(["a.ts"]);
});

test("a workspace that moved since the tree was cut is a named conflict", async () => {
  const { plan } = harness({
    workspace: { [at("a.ts")]: "someone else's edit" },
    files: [{ path: "a.ts", next: NEXT, base: BASE }],
  });
  const result = await plan();
  expect(result.writes).toHaveLength(0);
  expect(result.conflicts).toHaveLength(1);
  expect(result.conflicts[0]!.path).toBe("a.ts");
  // The refusal names all three hashes: where the workspace is, where the
  // tree was cut from, and where the tree wants to go.
  const reason = treeConflictReason(result.conflicts);
  expect(reason).toContain("a.ts");
  expect(reason).toContain(hash("someone else's edit"));
  expect(reason).toContain(BASE);
  expect(reason).toContain(NEXT);
});

test("a new file with no base lands only where the workspace has nothing", async () => {
  const created = harness({
    workspace: {},
    files: [{ path: "new.ts", next: NEXT }],
  });
  expect((await created.plan()).writes).toHaveLength(1);
  const taken = harness({
    workspace: { [at("new.ts")]: "already here" },
    files: [{ path: "new.ts", next: NEXT }],
  });
  const result = await taken.plan();
  expect(result.writes).toHaveLength(0);
  expect(result.conflicts).toHaveLength(1);
});

test("a deletion whose base still stands removes the file", async () => {
  const { plan } = harness({
    workspace: { [at("gone.ts")]: "base" },
    files: [{ path: "gone.ts", next: null, base: BASE }],
  });
  const result = await plan();
  expect(result.deletes).toEqual([{ abs: at("gone.ts") }]);
  // Already gone: a no-op, not a failure.
  const gone = harness({
    workspace: {},
    files: [{ path: "gone.ts", next: null, base: BASE }],
  });
  expect((await gone.plan()).unchanged).toEqual(["gone.ts"]);
  // Deleted AND moved since: a conflict, never a silent removal.
  const moved = harness({
    workspace: { [at("gone.ts")]: "edited" },
    files: [{ path: "gone.ts", next: null, base: BASE }],
  });
  expect((await moved.plan()).conflicts).toHaveLength(1);
});

test("one conflict refuses the whole plan — nothing lands", async () => {
  const { plan } = harness({
    workspace: { [at("ok.ts")]: "base", [at("bad.ts")]: "moved" },
    files: [
      { path: "ok.ts", next: NEXT, base: BASE },
      { path: "bad.ts", next: NEXT, base: BASE },
    ],
  });
  const result = await plan();
  expect(result.conflicts).toHaveLength(1);
  // The caller throws on any conflict, so the clean file's write never
  // happens — the plan is the whole answer, computed before the first write.
  expect(result.writes).toHaveLength(1);
  expect(treeConflictReason(result.conflicts)).toContain("1 file(s) moved");
});
