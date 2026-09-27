import {
  diffWasm,
  diffWasmBinary,
  diffWasmStructured,
} from "../packages/framework/diff-wasm/src/index.ts";
import { diffWasmAst } from "../packages/framework/diff-wasm/src/ast.ts";

function makeLines(count: number) {
  const line =
    "export const value1234567890 = 42; // padding padding padding padding\n";
  const oldText = line.repeat(count);
  const newText = oldText
    .replace(/value1234567890/g, "value9876543210")
    .replace("42;", "43;");
  return { oldText, newText, count };
}

function oldDiffRows(patch: string) {
  const rows: unknown[] = [];
  let oldLine = 0;
  let newLine = 0;
  let inHunk = false;
  for (const line of patch.split("\n")) {
    if (line.startsWith("diff --git")) {
      inHunk = false;
      continue;
    }
    if (line.startsWith("@@")) {
      const match = line.match(/^@@ -(\d+)(?:,\d+)? \+(\d+)(?:,\d+)? @@/u);
      if (match) {
        oldLine = Number(match[1]);
        newLine = Number(match[2]);
      }
      inHunk = true;
      rows.push(line);
      continue;
    }
    if (line.startsWith("---") || line.startsWith("+++")) {
      rows.push(line);
      continue;
    }
    if (!inHunk) {
      rows.push(line);
      continue;
    }
    if (line.startsWith("+")) {
      rows.push({ type: "is-added", text: line.slice(1), newNo: newLine++ });
      continue;
    }
    if (line.startsWith("-")) {
      rows.push({ type: "is-removed", text: line.slice(1), oldNo: oldLine++ });
      continue;
    }
    if (line.startsWith(" ")) {
      rows.push({
        type: "",
        text: line.slice(1),
        oldNo: oldLine++,
        newNo: newLine++,
      });
      continue;
    }
  }
  return rows;
}

async function benchTextRound(name: string, count: number) {
  const { oldText, newText } = makeLines(count);
  const mb = ((oldText.length + newText.length) / 1024 / 1024).toFixed(1);

  // Old path: runtime patch -> JS parse.
  let t0 = performance.now();
  const patchResult = await diffWasm(oldText, newText);
  const t1 = performance.now();
  const rows = oldDiffRows(patchResult.patch ?? "");
  const t2 = performance.now();
  console.log(
    `${name} (${mb}MB) old patch+parse ${(t1 - t0).toFixed(1)}ms + ${(t2 - t1).toFixed(1)}ms rows=${rows.length}`,
  );

  // New structured path.
  t0 = performance.now();
  const binary = await diffWasmBinary(oldText, newText);
  const t1b = performance.now();
  const structured = await diffWasmStructured(oldText, newText);
  const t2b = performance.now();
  console.log(
    `${name} (${mb}MB) new structured ${(t1b - t0).toFixed(1)}ms binary=${(binary.length / 1024 / 1024).toFixed(1)}MB parse+structured ${(t2b - t1b).toFixed(1)}ms hunks=${structured.hunks.length}`,
  );
}

async function benchAst() {
  const code = `function foo(){return 1;}\n` + `const x = 1;\n`.repeat(20000);
  const newCode = code
    .replace("foo()", "bar()")
    .replace("const x = 1;", "const y = 1;");
  let t0 = performance.now();
  const r1 = await diffWasmAst(code, newCode, "javascript");
  const t1 = performance.now();
  const r2 = await diffWasmAst(code, newCode, "javascript");
  const t2 = performance.now();
  console.log(
    `AST 0.25MB first ${(t1 - t0).toFixed(1)}ms changes=${r1.changes.length} cached ${(t2 - t1).toFixed(1)}ms changes=${r2.changes.length}`,
  );
}

await benchTextRound("small", 5000);
await benchTextRound("medium", 30000);
await benchTextRound("large", 100000);
await benchAst();
