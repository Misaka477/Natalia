/**
 * Dependency-cycle guard (audit finding A-02 / completion criterion §11).
 *
 * §11 requires "没有生产依赖环" — the production dependency graph of the
 * workspace must be acyclic. That used to be a one-off manual walk over the
 * package.json files; this guard makes it mechanical so a regression fails the
 * gate instead of quietly re-tangling the kernel / framework / plugin layers.
 *
 * It reads every workspace `package.json` under `packages/` and `apps/` (build
 * output under `dist/` is skipped), keeps only edges whose target is another
 * workspace package, and reports any cycle in the `dependencies` graph.
 *
 * Interface spec §5.3 also requires the *service* graph: services have their
 * own dependency edges (a plugin requires a service another plugin provides),
 * and those can deadlock while every package.json edge stays acyclic. The
 * second half of this guard therefore reads token declarations — where the
 * spec says "从猜 import 升级为读声明" — and checks id uniqueness, provider
 * ownership, missing providers and Kahn cycles over the declared graph.
 *
 * devDependency cycles are reported as advisory, not enforced: §11 scopes the
 * invariant to production, and a test-only package re-exporting a real
 * implementation (e.g. `@natalia/testing` -> a plugin) can legitimately close a
 * loop through a dev edge while the production graph stays acyclic. New
 * production cycles always fail; the advisory line keeps the dev picture
 * visible without pretending it is the enforced invariant.
 */
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";

const root = process.cwd();

/** Every `package.json` under a root, recursively, skipping build output. */
async function workspacePackageJsonFiles(rootDir: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (!entry.isDirectory()) continue;
    if (entry.name === "node_modules" || entry.name === "dist") continue;
    const full = join(rootDir, entry.name);
    if (await Bun.file(join(full, "package.json")).exists())
      found.push(join(full, "package.json"));
    found.push(...(await workspacePackageJsonFiles(full)));
  }
  return found;
}

/** Every `.ts` source file under a root, recursively, skipping build output. */
async function workspaceSourceFiles(rootDir: string): Promise<string[]> {
  const found: string[] = [];
  let entries;
  try {
    entries = await readdir(rootDir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      found.push(...(await workspaceSourceFiles(join(rootDir, entry.name))));
      continue;
    }
    if (entry.name.endsWith(".ts")) found.push(join(rootDir, entry.name));
  }
  return found;
}

type PackageJson = {
  name?: string;
  dependencies?: Record<string, string>;
  devDependencies?: Record<string, string>;
};

const files = [
  ...(await workspacePackageJsonFiles(join(root, "packages"))),
  ...(await workspacePackageJsonFiles(join(root, "apps"))),
];

const packages: PackageJson[] = [];
const workspaceNames = new Set<string>();
for (const file of files) {
  const pkg = JSON.parse(await readFile(file, "utf8")) as PackageJson;
  if (!pkg.name) continue;
  packages.push(pkg);
  workspaceNames.add(pkg.name);
}

function buildGraph(useDev: boolean): Map<string, Set<string>> {
  const graph = new Map<string, Set<string>>();
  for (const name of workspaceNames) graph.set(name, new Set());
  for (const pkg of packages) {
    const edges = graph.get(pkg.name!)!;
    for (const dep of Object.keys(pkg.dependencies ?? {}))
      if (workspaceNames.has(dep)) edges.add(dep);
    if (useDev)
      for (const dep of Object.keys(pkg.devDependencies ?? {}))
        if (workspaceNames.has(dep) && !(pkg.dependencies ?? {})[dep])
          edges.add(dep);
  }
  return graph;
}

/** Every distinct cycle, each rendered once as `a -> b -> a`. */
function findCycles(graph: Map<string, Set<string>>): string[][] {
  const cycles: string[][] = [];
  const seen = new Set<string>();
  const stack: string[] = [];
  const onStack = new Set<string>();
  const visited = new Set<string>();
  const short = (name: string) => name.replace("@natalia/", "@");
  const visit = (node: string): void => {
    if (onStack.has(node)) {
      const cycle = stack.slice(stack.indexOf(node)).concat(node);
      const key = [...cycle].sort().join("|");
      if (!seen.has(key)) {
        seen.add(key);
        cycles.push(cycle.map(short));
      }
      return;
    }
    if (visited.has(node)) return;
    visited.add(node);
    stack.push(node);
    onStack.add(node);
    for (const next of graph.get(node) ?? []) visit(next);
    stack.pop();
    onStack.delete(node);
  };
  for (const node of graph.keys()) visit(node);
  return cycles;
}

const productionCycles = findCycles(buildGraph(false));
const devCycles = findCycles(buildGraph(true));

console.log(
  `dependency cycle guard: ${workspaceNames.size} workspace packages`,
);

if (devCycles.length) {
  console.log(
    `advisory (not enforced; §11 is production-only): ${devCycles.length} cycle(s) including devDependencies`,
  );
  for (const cycle of devCycles) console.log(`  dev  ${cycle.join(" -> ")}`);
}

if (productionCycles.length) {
  console.error(
    `production dependency cycles: ${productionCycles.length} (§11 requires an acyclic production graph)`,
  );
  for (const cycle of productionCycles)
    console.error(`  PROD ${cycle.join(" -> ")}`);
  process.exit(1);
}

// --- service-level graph (interface spec §5.3) ---
const { analyzeServiceGraph, packageOf } = await import("../src/service-graph");

const sourceFiles = [
  ...(await workspaceSourceFiles(join(root, "packages"))),
  ...(await workspaceSourceFiles(join(root, "apps"))),
];
const scanned = [];
for (const path of sourceFiles) {
  const text = await Bun.file(path).text();
  scanned.push({ path, pkg: packageOf(path), text });
}

const graph = analyzeServiceGraph(scanned);
console.log(
  `service graph: ${graph.tokens.length} declared tokens, ${graph.nodes.length} nodes`,
);

const ownershipProblems = graph.problems.filter(
  (p) => !p.startsWith("dependency cycle:"),
);
if (ownershipProblems.length) {
  console.error(`service declaration problems: ${ownershipProblems.length}`);
  for (const problem of ownershipProblems) console.error(`  DECL ${problem}`);
}

const cycleProblems = graph.problems.filter((p) =>
  p.startsWith("dependency cycle:"),
);
if (cycleProblems.length) {
  for (const problem of cycleProblems) console.error(`  SVC  ${problem}`);
}

if (graph.problems.length) {
  console.error(
    "service graph is unsound (spec §5.3: duplicate ids, unowned services and cycles are hard failures)",
  );
  process.exit(1);
}

console.log("service declaration graph is sound");
