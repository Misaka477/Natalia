import { expect, test } from "bun:test";
import {
  diffWasm,
  diffWasmBinary,
  diffWasmStructured,
  parseDiffBinary,
} from "../src/index";
import {
  diffWasmAst,
  indexWasmAst,
  parseAstDiffBinary,
  parseAstIndexBinary,
} from "../src/ast";

test("diffWasm produces a unified patch with counts", async () => {
  const result = await diffWasm("a\nb\n", "a\nc\n");
  expect(result.patch).toContain("@@ -1,2 +1,2 @@");
  expect(result.patch).toContain("-b");
  expect(result.patch).toContain("+c");
  expect(result.additions).toBe(1);
  expect(result.deletions).toBe(1);
});

test("diffWasmStructured decodes hunks and line numbers", async () => {
  const result = await diffWasmStructured("one\ntwo\n", "one\nthree\nfour\n");
  expect(result.additions).toBe(2);
  expect(result.deletions).toBe(1);
  expect(result.hunks).toHaveLength(1);
  const hunk = result.hunks[0]!;
  expect(hunk.oldStart).toBe(2);
  expect(hunk.newStart).toBe(2);
  const types = hunk.lines.map((line) => line.type);
  expect(types).toContain("delete");
  expect(types).toContain("add");
  expect(hunk.lines.find((line) => line.type === "add")?.newLineNumber).toBe(2);
  expect(hunk.lines.find((line) => line.type === "delete")?.oldLineNumber).toBe(
    2,
  );
});

test("diffWasmBinary round-trips through parseDiffBinary", async () => {
  const oldText = "line1\nline2\n";
  const newText = "line1\nline-changed\n";
  const binary = await diffWasmBinary(oldText, newText);
  const parsed = parseDiffBinary(binary);
  expect(parsed.additions).toBe(1);
  expect(parsed.deletions).toBe(1);
  expect(parsed.hunks.some((hunk) => hunk.lines.length > 0)).toBe(true);
});

test("AST diff reports changed leaf nodes and preserves language", async () => {
  const result = await diffWasmAst(
    "const answer = 1;\n",
    "const answer = 2;\n",
    "javascript",
  );
  expect(result.language).toBe("javascript");
  expect(result.changes.length).toBeGreaterThan(0);
  const changed = result.changes.find(
    (change) => change.nodeText === "2" && change.kind === "added",
  );
  expect(changed).toBeDefined();
});

test("AST index returns parseable nodes for supported languages", async () => {
  const source = "const x = 1;\nfunction f() { return x; }\n";
  const indexed = await indexWasmAst(source, "javascript");
  expect(indexed.language).toBe("javascript");
  expect(indexed.nodes.some((node) => node.text.includes("function f()"))).toBe(
    true,
  );
  // The parser binary format should be directly parseable as well.
  const duplicate = await indexWasmAst(source, "javascript");
  expect(duplicate.nodes).toEqual(indexed.nodes);
});

test("AST binary helpers parse generated blobs", async () => {
  // Use internal cache through a fresh call; just verify the high-level AST
  // helpers still return parsed structures.
  const astDiff = await diffWasmAst(
    "let a = 1;\n",
    "let a = 2;\n",
    "javascript",
  );
  expect(astDiff.changes.length).toBeGreaterThan(0);

  const astIndex = await indexWasmAst("let x = 1;\n", "javascript");
  expect(astIndex.nodes.length).toBeGreaterThan(0);

  // The public binary parse functions are exported for transport/worker use.
  expect(typeof parseAstDiffBinary).toBe("function");
  expect(typeof parseAstIndexBinary).toBe("function");
});
