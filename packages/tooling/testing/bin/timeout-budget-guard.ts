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
  // A layer's block runs to the NEXT `- layer:` marker — nothing else. Scanning
  // a fixed window, or stopping at the first blank line, bleeds one layer's file
  // list into its neighbours (the first version reported one file under four
  // layers). The marker is the only reliable boundary.
  const nextLayer = lines.findIndex(
    (line, at) => at > index && /- layer: "/.test(line),
  );
  const end = nextLayer === -1 ? lines.length : nextLayer;
  for (let scan = index; scan < end; scan += 1) {
    const t = /--timeout\s+(\d+)/.exec(lines[scan]!);
    if (t && timeout === undefined) timeout = Number(t[1]);
    for (const f of lines[scan]!.matchAll(/packages\/[\w./-]+\.test\.ts/gu))
      files.push(f[0]);
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

// The layer scan stops at the next `- layer:` marker, so no file is reported
// under a neighbour. With that fixed this is a hard gate: the two contradictions
// it originally found (generation-tools declaring 240s inside a 60s layer, and
// three-stream-isolation declaring 90s inside a 60s layer) were repaired by hand
// in verify.yml.
if (failures.length) {
  console.error(`timeout-budget guard: ${failures.length} finding(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `timeout-budget guard: ${checked} files in ${layers.length} layers, every declared budget fits its wall`,
);
