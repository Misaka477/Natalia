/**
 * Memory-budget guard: a layer's peak RSS must fit the budget.
 *
 * The sibling timeout-budget guard reads what a test DECLARES; this one
 * measures what a layer COSTS. A per-test retention regression — an object
 * graph that survives dispose, a module evaluated once per unique URL and
 * never released — is invisible to every assertion: the suite stays green
 * while the process climbs. It happened here: the real-runtime files each
 * retained ~50MB per test (a plugin bundle re-evaluated per workspace, kept
 * by the ESM registry for the life of the process) and measured 4GB per file
 * with 243 passing assertions. The fix was one shared install; without a
 * budget the next such regression is again green-until-OOM.
 *
 * Which layers run: the ones that boot a real runtime (parsed from
 * .github/workflows/verify.yml, the same source the timeout guard reads) —
 * the client layers and core-2. They are where a runtime-shaped retention
 * shows up first and loudest; a pure-logic layer has nothing to retain.
 * Each layer is measured as CI runs it, as its own process under
 * /usr/bin/time, so the number is the number the matrix would see.
 *
 * The budget is 1.5GB per layer. Post-fix measurements: client-rest layers
 * ~0.8-1.1GB, the single-file client layers ~0.5GB, core-2 ~0.36GB.
 *
 * /usr/bin/time is a Linux tool and the matrix is ubuntu-only; on a host
 * without it the guard says so and passes, because it has nothing to
 * measure with.
 */
import { readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();
const workflow = join(root, ".github", "workflows", "verify.yml");

const BUDGET_KB = 1_572_864; // 1.5GB
const TIME_BINARY = "/usr/bin/time";

/** The layers that boot a real runtime; everything else has nothing to retain. */
const MEASURED_LAYERS = new Set([
  "client-a",
  "client-b",
  "client-c",
  "client-d",
  "client-e",
  "client-rest-1",
  "client-rest-2",
  "core-2",
]);

const text = await readFile(workflow, "utf8");
const lines = text.split("\n");

interface Layer {
  name: string;
  args: string[];
  line: number;
}

// The same marker-bounded scan the timeout guard uses: a layer's block runs
// to the next `- layer:` marker and nothing else.
const layers: Layer[] = [];
for (let index = 0; index < lines.length; index += 1) {
  const match = /- layer: "([^"]+)"/.exec(lines[index]!);
  if (!match) continue;
  const nextLayer = lines.findIndex(
    (line, at) => at > index && /- layer: "/.test(line),
  );
  const end = nextLayer === -1 ? lines.length : nextLayer;
  const args: string[] = [];
  // Only the folded command under `dirs: >-` is the layer's invocation;
  // the marker line itself is YAML, not an argument (passing it along made
  // every layer measure a five-second error exit).
  let inDirs = false;
  for (let scan = index; scan < end; scan += 1) {
    const line = lines[scan]!.trim();
    if (line.startsWith("dirs: >-")) {
      inDirs = true;
      continue;
    }
    if (line.startsWith("- layer:")) {
      inDirs = false;
      continue;
    }
    if (!inDirs || line === "") continue;
    // The folded command starts with `bun test` on the first content line
    // and continues on backslash-terminated lines; keep everything after
    // the runner name. Each folded line can hold flags AND a path, so the
    // words are split before they become argv entries.
    const content = line.startsWith("bun test")
      ? line.slice("bun test".length).trim()
      : line;
    if (content === "") continue;
    args.push(...content.replace(/\\$/u, "").trim().split(/\s+/u));
  }
  layers.push({ name: match[1]!, args, line: index + 1 });
}

if (!(await Bun.file(TIME_BINARY).exists())) {
  console.log(
    `memory-budget guard: ${TIME_BINARY} not present — nothing to measure with, skipping`,
  );
  process.exit(0);
}

const failures: string[] = [];
const measured: Array<{ name: string; mb: number }> = [];
for (const layer of layers) {
  if (!MEASURED_LAYERS.has(layer.name)) continue;
  if (layer.args.length === 0) continue;
  const proc = Bun.spawnSync(
    [TIME_BINARY, "-f", "%M", "bun", "test", ...layer.args],
    { cwd: root, stdout: "ignore", stderr: "pipe" },
  );
  const stderr = new TextDecoder().decode(proc.stderr);
  // GNU time writes its report to stderr; the peak is the last purely
  // numeric line (the test run's own chatter is ignored).
  const peakLine = stderr
    .trim()
    .split("\n")
    .filter((line) => /^\d+$/.test(line.trim()))
    .at(-1);
  const peak = Number.parseInt(peakLine ?? "", 10);
  if (!Number.isFinite(peak)) {
    failures.push(
      `layer ${layer.name} (verify.yml:${layer.line}): could not read a peak RSS from ${TIME_BINARY}:\n${stderr.trim()}`,
    );
    continue;
  }
  const mb = Math.round(peak / 1024);
  measured.push({ name: layer.name, mb });
  if (peak > BUDGET_KB)
    failures.push(
      `layer ${layer.name} (verify.yml:${layer.line}): peak RSS ${mb}MB over the ${Math.round(BUDGET_KB / 1024)}MB budget — a per-test retention regression is the usual cause`,
    );
}

for (const { name, mb } of measured) console.log(`  ${name}: ${mb}MB peak`);

if (failures.length) {
  console.error(`memory-budget guard: ${failures.length} finding(s)`);
  for (const failure of failures) console.error(`  ${failure}`);
  process.exit(1);
}
console.log(
  `memory-budget guard: ${measured.length} runtime layers measured, every peak under ${Math.round(BUDGET_KB / 1024)}MB`,
);
