import { expect, test } from "bun:test";
import { diffWasmAst } from "../src/ast.ts";
import { diffWasmStructured } from "../src/index.ts";

/**
 * The two defects the P5 baseline exposed (2026-09-23), pinned as
 * regressions against their exact shapes:
 *  1. an 8k-statement flat program overflowed Vec capacity inside the
 *     scoring matcher (32-bit wasm: n×m candidates × ~56B > 2.1G);
 *  2. two large same-kind bodies asked the text-LCS matrix for len²
 *     usize cells (50KB×50KB ≈ 25G) — both now bounded: child lists
 *     over n*m>20k take linear index pairing, scoring takes a 4KiB
 *     prefix. Deterministic correctness assertions only — timing
 *     belongs to bench-diff-performance, not to a unit test.
 */

const flat = (n: number) =>
  `function foo(){return 1;}\n` + `const x = 1;\n`.repeat(n);

test("an 8k-statement flat program diffs without overflowing (was: capacity overflow panic)", async () => {
  const result = await diffWasmAst(
    flat(8000),
    flat(8000).replace("foo()", "bar()").replace("const x", "const y"),
    "javascript",
  );
  expect(result.language).toBe("javascript");
  expect(result.changes.length).toBeGreaterThan(0);
});

test("two large same-kind function bodies stay within the scoring prefix budget", async () => {
  const body = (name: string) =>
    `function ${name}(){\n` +
    Array.from({ length: 400 }, (_, i) => `  const v${i} = ${i};\n`).join("") +
    `}\n`;
  const result = await diffWasmAst(
    body("alpha") + body("beta"),
    body("alpha2") + body("beta"),
    "javascript",
  );
  expect(result.changes.length).toBeGreaterThan(0);
});

test("a 30k-line structured diff stays linear and correct (was: quadratic line_at)", async () => {
  const line = "export const value1234567890 = 42; // pad\n";
  const oldText = line.repeat(30_000);
  const newText = oldText
    .replace(/value1234567890/gu, "value9876543210")
    .replace("42;", "43;");
  const result = await diffWasmStructured(oldText, newText);
  // every line changed:30k deletions +30k additions in one file rewrite
  expect(result.additions).toBe(30_000);
  expect(result.deletions).toBe(30_000);
});
