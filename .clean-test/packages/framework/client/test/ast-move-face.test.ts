import { expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeContext } from "@anthelia/substrate";
import { createWorkspaceRuntime } from "../src/runtime/workspace-runtime";

/**
 * Phase C's move FACE (the object-store study's acceptance 3): the
 * before/after sets go through the SAME AST index the index face uses,
 * and the answer is the detection. The semantics are the move-detect
 * module's (tested there); this test is the WIRING — the face indexes
 * both sets through the shared path and answers the moves, and a move's
 * from/to drop straight into the rename plan's fields (the study's 打通).
 */

const dirs: string[] = [];
afterAllSafe();

function afterAllSafe() {
  process.on("exit", () => {
    for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  });
}

function runtimeFor(root: string) {
  const ctx = {
    ports: {
      getReady: () => Promise.resolve(),
      getWorkspaceRoot: () => root,
    },
    state: {},
  } as unknown as RuntimeContext;
  return createWorkspaceRuntime(ctx);
}

test("the move face sees a move BEYOND the fiftieth file (the cap is gone)", async () => {
  // The workspace index used to cap each set at 50 files: a workspace's
  // move detection was blind past the fiftieth file, which is exactly
  // the scale Phase C exists for. A workspace of 90 files, the move in
  // the ninetieth, must be detected.
  const root = mkdtempSync(join(tmpdir(), "ast-move-cap-"));
  dirs.push(root);
  const runtime = runtimeFor(root);
  // Distinct symbol names: the detection's greedy best-pair match pairs
  // by text similarity, so ninety near-identical names would make the
  // matcher's answer ambiguous BY DESIGN — that is the algorithm, not a
  // bug. The shape below keeps every name unambiguous.
  const name = (index: number) => `handler_${(index * 7919) % 100000}`;
  const source = (index: number, renamed = false) =>
    `export function ${name(index)}${renamed ? "V2" : ""}(input: string) {\n  return input + ${index};\n}\n`;
  const before = Array.from({ length: 90 }, (_, index) => ({
    path: `src/mod-${index}.ts`,
    language: "typescript",
    source: source(index),
  }));
  // File 89's symbol became ...V2 — a rename in the LAST file, beyond
  // where the removed cap stopped looking.
  const after = before.map((file, index) =>
    index === 89 ? { ...file, source: source(index, true) } : file,
  );
  const answer = await runtime.astMove!({ before, after });
  const moves = answer.moves as Array<{
    from: string;
    to: string;
    states: { renamed: boolean };
  }>;
  expect(moves.length).toBeGreaterThanOrEqual(1);
  // The detected pair is the last file's symbol: from ...4791 to
  // ...4791V2 (the rename's similarity passes, and the file is the
  // ninetieth — beyond where the removed cap stopped looking).
  expect(
    moves.some(
      (move) =>
        move.from.includes(name(89)) &&
        move.to.includes("V2") &&
        move.states.renamed,
    ),
  ).toBe(true);
}, 60_000);

test("the move face indexes both sets through the shared path and answers the detection", async () => {
  const root = mkdtempSync(join(tmpdir(), "ast-move-face-"));
  dirs.push(root);
  const runtime = runtimeFor(root);
  const answer = await runtime.astMove!({
    before: [
      {
        path: "src/parser.ts",
        source: "function parseConfigV2(value: string) { return value; }",
        language: "typescript",
      },
    ],
    after: [
      {
        path: "lib/parser.ts",
        source: "function parseConfigV3(value: string) { return value; }",
        language: "typescript",
      },
    ],
  });
  // The acceptance's three states, through the real index.
  const move = answer.moves.find((entry) => entry.from === "parseConfigV2");
  expect(move).toBeDefined();
  expect(move).toMatchObject({
    to: "parseConfigV3",
    fromFile: "src/parser.ts",
    toFile: "lib/parser.ts",
    states: { renamed: true, moved: true, modified: true },
  });
  // The 打通: the move's from/to ARE the rename plan's fields — a
  // detection result feeds astRefactorPlan({rename}) directly.
  expect({ from: move!.from, to: move!.to }).toEqual({
    from: "parseConfigV2",
    to: "parseConfigV3",
  });
}, 30_000);

test("a face over unchanged files answers no moves (the shared index twice)", async () => {
  const root = mkdtempSync(join(tmpdir(), "ast-move-still-"));
  dirs.push(root);
  const runtime = runtimeFor(root);
  const files = [
    {
      path: "src/a.ts",
      source: "const stable = 1;",
      language: "typescript",
    },
  ];
  const answer = await runtime.astMove!({ before: files, after: files });
  expect(answer.moves).toEqual([]);
}, 30_000);
