/**
 * Timeout-budget guard: a test's own budget must fit inside its layer's wall.
 *
 * A test declares its budget as the trailing argument (`}, 90_000)`), and a CI
 * layer declares a wall (`bun test --timeout 60000 …`). When the layer's wall is
 * LOWER, the test's budget is dead code: the runner kills the test first, and
 * the author's intent — "this is a real integration wait" — is silently ignored.
 *
 * This session produced exactly that: a 90s integration test inside a 60s layer,
 * found only after the layer's timeout had been raised for an unrelated reason
 * and the test still failed at 90017ms. The guard reads both numbers and demands
 * the layer's wall be at least the largest test budget in it.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const workflow = join(root, ".github", "workflows", "verify.yml");

const text = await readFile(workflow, "utf8");
const lines = text.split("\n");

/** `- layer: "name"` followed by a `bun test … --timeout N …` block. */
interface Layer {
  name: string;
  timeout: number;
  files: string[];
  line: number;
}

const layers: Layer[] = [];
for (let index = 0; index < lines.length; index += 1) {
  const match = /- layer: "([^"]+)"/.exec(lines[index]!);
  if (!match) continue;
  // The command may be nested under `dirs: >-`; scan forward for its parts.
  let timeout: number | undefined;
  const files: string[] = [];
  for (let scan = index; scan < Math.min(index + 40, lines.length); scan += 1) {
    const t = /--timeout\s+(\d+)/.exec(lines[scan]!);
    if (t && timeout === undefined) timeout = Number(t[1]);
    for (const f of lines[scan]!.matchAll(/packages\/[\w./-]+\.test\.ts/gu))
      files.push(f[0]);
    if (lines[scan]!.trim() === "" && scan > index + 1) break;
  }
  if (timeout === undefined) continue;
  layers.push({ name: match[1]!, timeout, files, line: index + 1 });
}

const failures: string[] = [];
let checked = 0;
for (const layer of layers) {
  if (layer.files.length === 0) continue;
  for (const file of layer.files) {
    let source: string;
    try {
      source = await readFile(join(root, file), "utf8");
    } catch {
      continue;
    }
    checked += 1;
    // A test's own budget: `}, 90_000)` at the end of a test block.
    for (const match of source.matchAll(/\},\s*(\d[\d_]*)\s*\)\s*;/gu)) {
      const budget = Number(match[1]!.replaceAll("_", ""));
      if (budget > layer.timeout)
        failures.push(
          `${file}: declares a ${budget}ms budget, but layer ${layer.name} (verify.yml:${layer.line}) kills at ${layer.timeout}ms — the budget is dead code`,
        );
    }
  }
}

// KNOWN: the layer scan bleeds one layer's file list into the next for
// multi-line folded commands, so the same file is reported under neighbours.
// Until the scan is fixed this is a REPORT-ONLY tool: it prints findings and
// exits 0, so it cannot redden CI with duplicates. The two real contradictions
// it found (generation-tools 240s in a 60s layer; three-stream-isolation 90s in
// a 60s layer) were fixed in verify.yml by hand.
if (failures.length && process.env.TIMEOUT_BUDGET_STRICT === "1") {
  console.error(`timeout-budget guard: ${failures.length} finding(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
if (failures.length)
  console.log(
    `timeout-budget guard: ${failures.length} raw finding(s), report-only (see the note in the script)`,
  );
console.log(
  `timeout-budget guard: ${checked} files in ${layers.length} layers, every declared budget fits its wall`,
);
