import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import {
  findFrameworkPluginSurfaceViolation,
  findRuntimePluginCatalogViolation,
  findClientClosureViolation,
  findClientProductDependencyViolation,
  findClientServiceContractViolation,
  findClientPluginSurfaceViolation,
  findClientToolDependencyViolation,
  findCompositionKernelViolation,
  findForbiddenRepositoryPathViolation,
  findPolicyHostDependencyViolation,
  findSourceTreeJsViolation,
  findWorkspaceManagerBoundaryViolation,
  findSubstratePurityViolation,
  findMigratedPluginViolations,
  findTeamPluginDependencyViolation,
  frameworkSubsystemFiles,
  frameworkSubsystemRoots,
} from "../src/migrated-plugin-rules";
import { findEnginePrefixBandViolations } from "../src/prefix-band-rules";
import {
  findElectronDependency,
  findElectronResidueInText,
} from "../src/electron-residue-rules";
import { findUndeclaredWorkspaceImports } from "../src/manifest-dep-rules";
import { findFullReadInventoryViolations } from "../src/full-events-inventory";

const root = process.cwd();
const dependencyGuarded = [
  "packages/framework/runtime",
  "packages/framework/session",
  "packages/core/tools",
  "packages/hosts/config",
  "packages/framework/attachments",
  "packages/framework/compaction",
  "packages/domains/context-ledger",
  "packages/framework/sandbox",
  "packages/plugins/mcp",
  "packages/plugins/skills",
  "packages/framework/subagents",
  "packages/core/plugin",
  "packages/framework/retry",
  "packages/framework/runtime-status",
  "packages/framework/turn-orchestration",
  "packages/framework/provider-model",
  "packages/domains/work-ledger",
  "packages/framework/checkpoint",
  "packages/framework/collaboration",
  "packages/domains/governance-ledger",
  "packages/framework/session-store",
  "packages/framework/workspace",
];
const capabilityRoots = ["packages/core/capability"];
/**
 * Capability factory modules that live inside the client package. They are not
 * yet decoupled capability packages — they still use kernel types such as
 * `RuntimeTool` — so the enforceable rule is narrower: a factory must never
 * import the composition root back, or the extraction is circular and buys
 * nothing, and it must stay free of presentation code.
 */
const capabilityFactoryRoots = ["packages/framework/client/src/capabilities"];
const forbiddenCapabilityFactoryImports = [
  /from\s+["']\.\.\/runtime\/main["']/u,
  /from\s+["']@natalia\/client["']/u,
  /from\s+["'](?:\.\.\/)+apps\//u,
  /from\s+["']@opentui\//u,
  /from\s+["']solid-js/u,
];
const productionRoots = ["apps", "packages", "cmd", "internal", "scripts"];
/**
 * Packages an externally built UI is allowed to depend on (mainline plan §2.1).
 * They must stay leaf-ward: importing a kernel package here would drag the whole
 * runtime into every consumer and silently make the consumer contract untestable.
 */
const consumerContractRoots = [
  "packages/core/contracts/src",
  "packages/tooling/sdk/src",
  "packages/hosts/view-store/src",
  "packages/hosts/ui-model/src",
  "packages/core/capability/src",
];
const kernelPackages = [
  "agent",
  "attachments",
  "checkpoint",
  "client",
  "compaction",
  "config",
  "context-ledger",
  "governance-ledger",
  "platform",
  "plugin",
  "provider-model",
  "retry",
  "runtime",
  "runtime-config",
  "runtime-status",
  "sandbox",
  "session",
  "session-store",
  "skills-plugin",
  "subagents",
  "testing",
  "tool-policy",
  "tools",
  "transport",
  "turn-orchestration",
  "work-ledger",
  "workspace",
];
const sourceExtensions = /\.(ts|tsx|js|jsx|go|json|toml|ya?ml)$/u;
const skippedDirs = new Set([
  ".git",
  ".turbo",
  "coverage",
  "dist",
  "node_modules",
  // Test fixtures are DATA, not source: a committed corpus (the frozen
  // eval's instructions, an AST grammar sample) legitimately contains
  // import-shaped text that is not this repository's dependency. Scanning
  // them traces phantom imports and fails the gate on data.
  "fixtures",
]);

const forbiddenDependencies = [
  /from\s+["'](?:\.\.\/)*apps\/tui/u,
  /from\s+["']@opentui\//u,
  /from\s+["']solid-js/u,
  /from\s+["'](?:react|preact|vue|svelte)["']/u,
  /\bHTMLElement\b/u,
];
const forbiddenTraceNames = [new RegExp("open" + "code", "iu")];
const forbiddenAccountFlowNames = [
  new RegExp(
    `\\b(?:${"log" + "in"}|${"log" + "out"}|${"sign" + "In"}|${"sign" + "Out"}|${"sign" + "Up"}|${"oa" + "uth"}|${"oi" + "dc"})\\b`,
    "iu",
  ),
  new RegExp(`\\b${"sign"}[-_\\s]?(?:in|out|up)\\b`, "iu"),
  new RegExp(
    `\\b(?:user|cloud|organization|workspace)\\s+${"acc" + "ount"}\\b`,
    "iu",
  ),
];

// Both prefixes: mechanism packages move to @anthelia in P3 (decision 24④)
// while the guard keeps banning BOTH spellings — coverage never dips while
// the rename lands, and P4⑤ hardens the list to prefixes that exist.
const forbiddenConsumerContractImports = kernelPackages.flatMap((name) => [
  new RegExp(`from\\s+["']@natalia/${name}["']`, "u"),
  new RegExp(`from\\s+["']@anthelia/${name}["']`, "u"),
]);
/**
 * Subpath entry points a package deliberately declares in its `exports`. They
 * are not deep imports into private internals: the split is the contract. Keep
 * this list in step with the `exports` maps, so an undeclared subpath still
 * fails the deep-import rule below.
 */
const declaredSubpathExports = [
  "@natalia/transport/host",
  "@anthelia/diff-wasm/ast",
  "@natalia/client/fixture",
];
/**
 * Host-side transport (`createRuntimeHttpServer`, `createRuntimeWsServer`, the
 * daemon store/token/spawn) opens sockets, mints bearer tokens and spawns
 * processes. Only whoever runs the runtime may import it. A UI that merely
 * speaks the protocol must not gain the ability to host one.
 */
const transportHostImport = /from\s+["']@natalia\/transport\/host["']/u;
const transportHostAllowedRoots = ["apps/cli", "packages/hosts/transport"];
/**
 * Tests legitimately stand up a real server to verify the protocol against it,
 * so the host rule applies to shipped source rather than to test files.
 */
const testPath = /(?:^|\/)test\//u;
/**
 * Deep imports into another package bypass its public index and therefore its
 * contract. `@natalia/<pkg>/...` and `../../packages/<pkg>/...` are both
 * banned for shipped code; `scripts/` is dev tooling and stays out of scope.
 */
const deepImportRoots = ["apps", "packages"];
const forbiddenDeepImports = [
  /from\s+["']@natalia\/[a-z-]+\//u,
  /from\s+["'](?:\.\.\/){2,}packages\//u,
];

/**
 * Architecture convergence plan §3.5 gates.
 *
 * File size: line count is reported as a maintenance signal, not enforced as an
 * architectural boundary. Cohesion and dependency direction determine whether
 * a module should be split; crossing an arbitrary line count does not.
 *
 * Runtime module coupling: `packages/framework/client/src/runtime/` modules may only talk
 * to each other through `RuntimeContext` (`context`) and the type ports that
 * describe it (`options`, `ports*`, `status-config`, `session-execution-state`,
 * `initialize-types`). A relative import that resolves to another runtime
 * module's implementation — including one in the same root directory — is a
 * direct cross-module reference and fails. Feature subdirectories may split
 * across files for size: the guard allows imports within one feature directory
 * and blocks cross-feature coupling. The composition root (`main.ts`,
 * `composition/`) and the RPC surface assembler (`client-surface.ts`)
 * are the only modules allowed to import feature implementations.
 */
const maxSourceLines = 400;
const runtimeModuleRoots = ["packages/framework/client/src/runtime"];
const runtimeCompositionRoot = "packages/framework/client/src/runtime/main.ts";
const runtimeCompositionDirectory =
  "packages/framework/client/src/runtime/composition/";
/**
 * Type-only ports that every runtime module may import. They carry the
 * `RuntimeContext` shape and its cross-module surface definitions, never
 * feature implementations.
 */
const runtimePortTargets = new Set([
  "packages/framework/client/src/runtime/context.ts",
  "packages/framework/client/src/runtime/options.ts",
  "packages/framework/client/src/runtime/ports.ts",
  "packages/framework/client/src/runtime/ports-extra.ts",
  "packages/framework/client/src/runtime/ports-initialize.ts",
  "packages/framework/client/src/runtime/ports-client-surface.ts",
  "packages/framework/client/src/runtime/status-config.ts",
  "packages/framework/client/src/runtime/session-execution-state.ts",
  "packages/framework/client/src/runtime/initialize-types.ts",
]);

const failures: string[] = [];
for (const dir of frameworkSubsystemRoots)
  await scan(join(root, dir), /\.tsx?$/u, (full, text) => {
    const violation = findFrameworkPluginSurfaceViolation(
      full.slice(root.length + 1).replaceAll("\\", "/"),
      text,
    );
    if (violation) failures.push(`${full}: ${violation}`);
  });
for (const path of frameworkSubsystemFiles) {
  const full = join(root, path);
  const text = await readFile(full, "utf8");
  const violation = findFrameworkPluginSurfaceViolation(path, text);
  if (violation) failures.push(`${full}: ${violation}`);
}

for (const manifest of await workspacePackageManifests("packages")) {
  if (
    manifest.name?.startsWith("@natalia/plugin-") &&
    manifest.dependencies?.["@anthelia/plugin"] === undefined
  )
    failures.push(
      `${manifest.path}: plugin package must depend on @anthelia/plugin`,
    );
  // §3.6.8: the testing tooling must never be a production dependency — it
  // belongs in devDependencies (audit A-04/A-05). Mechanized here so a package
  // cannot quietly reintroduce a production edge to tooling/testing.
  if (manifest.dependencies?.["@natalia/testing"] !== undefined)
    failures.push(
      `${manifest.path}: @natalia/testing must be a devDependency, not a production dependency`,
    );
  // §3.6.9: the desktop shell is CEF — Electron is history, and the
  // audit's lesson was a false "deleted" claim. The claim is now
  // re-checkable: no manifest may declare it.
  const electronDep = findElectronDependency(manifest);
  if (electronDep)
    failures.push(
      `${manifest.path}: ${electronDep} (§3.6.9: the shell is CEF)`,
    );
  // §1.1 包前缀即边界 — the never-reverse law, derived FROM the package
  // name: a new @anthelia/* package is band-covered the moment it is
  // named, and only its src (the shipped boundary) is scanned; engine
  // tests may import policy as fixtures.
  if (manifest.name?.startsWith("@anthelia/")) {
    const packageDir = manifest.path.slice(0, -"/package.json".length);
    await scan(
      join(packageDir, "src"),
      /\.(?:ts|tsx|mjs|js|jsx)$/u,
      (full, text) => {
        for (const specifier of findEnginePrefixBandViolations(text))
          failures.push(
            `${full}: the engine must not import ${specifier} (@anthelia may never import @natalia — decisions §1.1)`,
          );
      },
    );
  }
}
// §3.6.9, source + docs bites: every workspace src tree and the
// user-facing docs are scanned for Electron (electron-to-chromium is
// the browserslist database, allowed by the rule itself).
// The RINA study's acceptance #1: every full-event content read is
// named, counted and classified — drift in either direction is red.
// ONE walk covers both source roots (the rule walks packages/ and
// apps/ itself); it must not ride the per-package loop below, which
// would re-walk the tree per manifest and duplicate every finding.
for (const failure of await findFullReadInventoryViolations(root))
  failures.push(`${failure} (full-read inventory)`);
{
  const codeOnly = /\.(?:ts|tsx|js|mjs|jsx)$/u;
  const docs = ["README.md"];
  for (const rootDir of ["packages", "apps"]) {
    for (const entry of await workspacePackageManifests(rootDir)) {
      const pkgDir = entry.path.slice(0, -"/package.json".length);
      // Manifest<->src reconciliation (the census's finding): every
      // workspace import in this package's src must be declared —
      // hoisting can hide it from the chain, not from this rule.
      for (const failure of await findUndeclaredWorkspaceImports({
        ownName: entry.name ?? "",
        packageDir: pkgDir,
        deps: entry.dependencies ?? {},
      }))
        failures.push(`${failure} (manifest<->src reconciliation)`);

      await scan(join(pkgDir, "src"), codeOnly, (full, text) => {
        // The rule's own file must be able to NAME what it bans (its
        // patterns and prose contain the words) — an explicit,
        // reasoned exemption, the twin-guard allowlist's precedent.
        if (full.endsWith("electron-residue-rules.ts")) return;
        const violation = findElectronResidueInText(text);
        if (violation)
          failures.push(`${full}: ${violation} (§3.6.9: the shell is CEF)`);
      });
      for (const doc of docs) {
        const docPath = join(pkgDir, doc);
        if (!(await Bun.file(docPath).exists())) continue;
        const violation = findElectronResidueInText(
          await Bun.file(docPath).text(),
        );
        if (violation)
          failures.push(`${docPath}: ${violation} (§3.6.9: the shell is CEF)`);
      }
    }
  }
  for (const doc of docs) {
    const docPath = join(root, doc);
    if (!(await Bun.file(docPath).exists())) continue;
    const violation = findElectronResidueInText(await Bun.file(docPath).text());
    if (violation)
      failures.push(`${docPath}: ${violation} (§3.6.9: the shell is CEF)`);
  }
  const docsDir = join(root, "docs");
  if (existsSync(docsDir))
    await scan(docsDir, /\.md$/u, (full, text) => {
      const violation = findElectronResidueInText(text);
      if (violation)
        failures.push(`${full}: ${violation} (§3.6.9: the shell is CEF)`);
    });
}
for (const dir of dependencyGuarded)
  await scan(join(root, dir), sourceExtensions, (full, text) => {
    // Plugin UI subpaths are intentionally presentation code (they export a
    // SolidJS UI plugin through package `./ui`); backend dependency rules do
    // not apply to a dedicated UI entry point.
    if (/\/src\/ui\//u.test(full)) return;
    for (const pattern of forbiddenDependencies) {
      if (pattern.test(text))
        failures.push(`${full}: forbidden dependency ${pattern}`);
    }
  });
for (const dir of capabilityRoots)
  await scan(join(root, dir), sourceExtensions, (full, text) => {
    for (const pattern of [
      /from\s+["']@natalia\/(?:client|runtime|session|tools)["']/u,
      /from\s+["'](?:\.\.\/)+apps\//u,
      /from\s+["']@opentui\//u,
      /from\s+["']solid-js/u,
    ]) {
      if (pattern.test(text))
        failures.push(
          `${full}: capability bypasses kernel or presentation boundary ${pattern}`,
        );
    }
  });
for (const dir of capabilityFactoryRoots)
  await scan(join(root, dir), sourceExtensions, (full, text) => {
    for (const pattern of forbiddenCapabilityFactoryImports) {
      if (pattern.test(text))
        failures.push(
          `${full}: capability factory must not depend on the composition root or presentation ${pattern}`,
        );
    }
  });
for (const dir of consumerContractRoots)
  await scan(join(root, dir), sourceExtensions, (full, text) => {
    for (const pattern of forbiddenConsumerContractImports) {
      if (pattern.test(text))
        failures.push(
          `${full}: consumer contract package depends on kernel ${pattern}`,
        );
    }
  });
for (const dir of deepImportRoots)
  await scan(join(root, dir), sourceExtensions, (full, text) => {
    const relative = full.slice(root.length + 1).replaceAll("\\", "/");
    if (
      transportHostImport.test(text) &&
      !testPath.test(relative) &&
      !transportHostAllowedRoots.some((allowed) => relative.startsWith(allowed))
    )
      failures.push(
        `${full}: only the runtime host may import @natalia/transport/host`,
      );
    const withoutDeclaredSubpaths = declaredSubpathExports.reduce(
      (acc, subpath) => acc.split(subpath).join("@natalia/declared-subpath"),
      text,
    );
    for (const pattern of forbiddenDeepImports) {
      if (pattern.test(withoutDeclaredSubpaths))
        failures.push(`${full}: deep import bypasses package index ${pattern}`);
    }
  });
for (const dir of productionRoots)
  await scan(join(root, dir), sourceExtensions, (full, text) => {
    const relative = full.slice(root.length + 1).replaceAll("\\", "/");
    const forbiddenPathViolation =
      findForbiddenRepositoryPathViolation(relative);
    if (forbiddenPathViolation)
      failures.push(`${full}: ${forbiddenPathViolation}`);
    const catalogOwnershipViolation = findRuntimePluginCatalogViolation(
      relative,
      text,
    );
    if (catalogOwnershipViolation)
      failures.push(`${full}: ${catalogOwnershipViolation}`);
    const serviceContractViolation = findClientServiceContractViolation(
      relative,
      text,
    );
    if (serviceContractViolation)
      failures.push(`${full}: ${serviceContractViolation}`);
    const clientPluginSurfaceViolation = findClientPluginSurfaceViolation(
      relative,
      text,
    );
    if (clientPluginSurfaceViolation)
      failures.push(`${full}: ${clientPluginSurfaceViolation}`);
    const clientToolViolation = findClientToolDependencyViolation(
      relative,
      text,
    );
    if (clientToolViolation) failures.push(`${full}: ${clientToolViolation}`);
    const clientProductViolation = findClientProductDependencyViolation(
      relative,
      text,
    );
    if (clientProductViolation)
      failures.push(`${full}: ${clientProductViolation}`);
    const clientClosureViolation = findClientClosureViolation(relative, text);
    if (clientClosureViolation)
      failures.push(`${full}: ${clientClosureViolation}`);
    const teamPluginViolation = findTeamPluginDependencyViolation(
      relative,
      text,
    );
    if (teamPluginViolation) failures.push(`${full}: ${teamPluginViolation}`);
    for (const violation of findMigratedPluginViolations(relative, text))
      failures.push(
        `${full}: migrated plugin "${violation.pluginID}" must be mounted through the plugin catalog: ${violation.description}`,
      );
    for (const pattern of forbiddenTraceNames) {
      if (pattern.test(text))
        failures.push(`${full}: upstream trace name found`);
    }
    for (const pattern of forbiddenAccountFlowNames) {
      if (pattern.test(text))
        failures.push(`${full}: forbidden hosted identity flow ${pattern}`);
    }
  });

/**
 * Report large shipped source files for review. This is deliberately advisory:
 * splitting remains a design decision based on cohesion and ownership.
 */
const largeSourceFiles: string[] = [];
for (const dir of productionRoots)
  await scan(join(root, dir), /\.ts$/u, (full, text) => {
    const relative = full.slice(root.length + 1).replaceAll("\\", "/");
    if (!relative.includes("/src/") || relative.includes("/test/")) return;
    const lines = text.split("\n").length;
    if (lines > maxSourceLines) largeSourceFiles.push(`${relative} (${lines})`);
  });

/**
 * Runtime module coupling: modules under `packages/framework/client/src/runtime/` talk to
 * each other only through `RuntimeContext`. Type ports (`context`, `options`,
 * `ports*`, `status-config`, `session-execution-state`, `initialize-types`)
 * may be imported by any module; the composition root (`main.ts`), its internal
 * composition modules, and the RPC surface assembler (`client-surface.ts`)
 * may import feature factories. Distinct root runtime modules must not import
 * each other's implementations directly; feature subdirectories may split
 * across files within one directory (internal composition) but must not reach
 * into another feature.
 */
const runtimeRoot = join(root, "packages", "client", "src", "runtime");
const runtimeRootDir = runtimeRoot;
const runtimeImport = /from\s+["'](\.[^"']*)["']/gu;
for (const dir of runtimeModuleRoots)
  await scan(join(root, dir), /\.ts$/u, (full, text) => {
    const relative = full.slice(root.length + 1).replaceAll("\\", "/");
    const importerDir = full.slice(0, full.lastIndexOf("/"));
    const imports = [...text.matchAll(runtimeImport)].map((match) => match[1]);
    for (const specifier of imports) {
      const resolved = resolveRuntimeSpecifier(full, specifier);
      if (
        resolved !== null &&
        resolved.startsWith(runtimeRoot) &&
        !isRuntimePortTarget(resolved) &&
        relative !== runtimeCompositionRoot &&
        relative !==
          "packages/framework/client/src/runtime/client-surface.ts" &&
        !relative.startsWith(runtimeCompositionDirectory) &&
        // A feature split across files for size is internal composition: the
        // guard allows imports within one feature directory and blocks
        // cross-feature coupling. The runtime root itself is not a feature
        // directory: root modules are distinct modules and must not reach into
        // each other directly.
        !(
          isRuntimeFeatureDirectory(importerDir) &&
          sameDirectory(full, specifier)
        ) &&
        !relative.includes("/test/")
      )
        failures.push(
          `${relative}: runtime module imports another runtime module directly (${specifier}); communicate through RuntimeContext`,
        );
    }
  });

/**
 * True when the importer lives in a feature subdirectory (`runtime/<feature>/`)
 * rather than the runtime root. Feature-internal file splits are allowed; the
 * root level is one module per file.
 */
function isRuntimeFeatureDirectory(importerDir: string): boolean {
  return importerDir.startsWith(runtimeRoot) && importerDir !== runtimeRootDir;
}

function sameDirectory(importerFile: string, specifier: string): boolean {
  const base = importerFile.slice(0, importerFile.lastIndexOf("/"));
  const resolved = join(base, specifier);
  return resolved.slice(0, resolved.lastIndexOf("/")) === base;
}

/**
 * A relative import resolves to a runtime type port when the resolved path
 * names one of the port files, with or without an extension.
 */
function isRuntimePortTarget(resolved: string): boolean {
  const relative = resolved.slice(runtimeRoot.length + 1).replaceAll("\\", "/");
  const withoutExtension = relative.endsWith(".ts")
    ? relative.slice(0, -3)
    : relative;
  return runtimePortTargets.has(
    `packages/framework/client/src/runtime/${withoutExtension}.ts`,
  );
}

function resolveRuntimeSpecifier(
  importerFile: string,
  specifier: string,
): string | null {
  if (!specifier.startsWith(".")) return null;
  const base = importerFile.slice(0, importerFile.lastIndexOf("/"));
  const resolved = join(base, specifier);
  if (resolved.startsWith(runtimeRoot)) return resolved;
  return null;
}

/**
 * Runtime dependency direction must stay acyclic (plan §3.5). A value import
 * from one runtime module into another creates a real initialization-order
 * dependency; type-only imports are erased at compile time and cannot form a
 * runtime cycle. The graph therefore uses only non-type relative imports that
 * resolve inside the runtime directory.
 */
const runtimeValueImport =
  /(?:^|[;"'\n])\s*(?:import|export)\s+(?!type\b)[^;]*?from\s+["'](\.[^"']*)["']/gu;
const runtimeModuleFiles: string[] = [];
for (const dir of runtimeModuleRoots)
  await scan(join(root, dir), /\.ts$/u, (full) => {
    const relative = full.slice(root.length + 1).replaceAll("\\", "/");
    if (!relative.includes("/test/")) runtimeModuleFiles.push(full);
  });
const runtimeModuleFileSet = new Set(runtimeModuleFiles);
const runtimeEdges = new Map<string, string[]>();
for (const full of runtimeModuleFiles) {
  const text = await readFile(full, "utf8");
  const targets: string[] = [];
  for (const match of text.matchAll(runtimeValueImport)) {
    const specifier = match[1];
    const resolved = resolveRuntimeFile(full, specifier);
    if (resolved !== null && runtimeModuleFileSet.has(resolved))
      targets.push(resolved);
  }
  if (targets.length) runtimeEdges.set(full, targets);
}
const cycleFailures = findRuntimeCycles(runtimeEdges);
for (const failure of cycleFailures) failures.push(failure);

/**
 * Resolves a relative specifier to a concrete file inside the runtime
 * directory, honoring the extension-less module specifiers used across the
 * codebase (including directory imports that resolve to an index module).
 */
function resolveRuntimeFile(
  importerFile: string,
  specifier: string,
): string | null {
  const base = importerFile.slice(0, importerFile.lastIndexOf("/"));
  const joined = join(base, specifier);
  if (!joined.startsWith(runtimeRoot)) return null;
  for (const candidate of [
    joined,
    `${joined}.ts`,
    join(joined, "index.ts"),
    `${joined}.tsx`,
    join(joined, "index.tsx"),
  ]) {
    if (runtimeModuleFileSet.has(candidate)) return candidate;
  }
  return null;
}

/**
 * Reports every distinct cycle found in a directed graph of file paths. Each
 * returned line names the cycle so a regression is actionable.
 */
function findRuntimeCycles(edges: Map<string, string[]>): string[] {
  const reported = new Set<string>();
  const state = new Map<string, 0 | 1 | 2>();
  const stack: string[] = [];
  const result: string[] = [];
  const visit = (node: string): void => {
    state.set(node, 1);
    stack.push(node);
    for (const next of edges.get(node) ?? []) {
      const nextState = state.get(next) ?? 0;
      if (nextState === 1) {
        const cycleStart = stack.indexOf(next);
        const cycle = [...stack.slice(cycleStart), next];
        const label = cycle
          .map((file) => file.slice(root.length + 1))
          .join(" -> ");
        if (!reported.has(label)) {
          reported.add(label);
          result.push(`runtime dependency cycle: ${label}`);
        }
        continue;
      }
      if (nextState === 0) visit(next);
    }
    stack.pop();
    state.set(node, 2);
  };
  for (const node of edges.keys())
    if ((state.get(node) ?? 0) === 0) visit(node);
  return result;
}

/**
 * Every package that has tests must have them in the gate.
 * A test directory missing from the root `test` script is worse than having no
 * tests: the tests exist, they are maintained, they look like coverage in review,
 * and nothing runs them. This has happened three times — twice with new packages,
 * once with `packages/core/contracts`, whose tests had never run — so the rule is
 * enforced here instead of being written down again.
 *
 * The check is on the workspace's own script text rather than on a list kept here,
 * because a list kept here is the same kind of thing that went stale.
 */
const testScript = JSON.parse(
  await readFile(join(root, "package.json"), "utf8"),
) as { scripts?: Record<string, string> };
const gatedTests = testScript.scripts?.test ?? "";
for (const entry of await workspacePackageEntries("packages")) {
  const relative = entry.replaceAll("\\", "/");
  const testDir = join(root, relative, "test");
  let hasTests = false;
  try {
    hasTests = (await readdir(testDir)).some((file) =>
      /\.test\.tsx?$/u.test(file),
    );
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
  if (!hasTests) continue;
  if (!gatedTests.includes(`${relative}/test`))
    failures.push(
      `${relative}/test has tests that the root "test" script never runs`,
    );
}

// master plan P3: composition is engine substrate — the paths map is the
// declaration, and this keeps the placement machine-checked.
{
  const tsconfigBase = JSON.parse(
    await readFile(join(root, "tsconfig.base.json"), "utf8"),
  ) as {
    compilerOptions?: { paths?: Record<string, readonly string[] | string> };
  };
  const violation = findCompositionKernelViolation(
    tsconfigBase.compilerOptions?.paths?.["@anthelia/composition"],
  );
  if (violation) failures.push(`tsconfig.base.json: ${violation}`);
}

// workspace-manager's consumption boundary (decisions §1.2): the host
// facade reaches the client ONLY through the composition root — the
// "使用者" state audited this round is now enforced.
{
  const wmPath = join(
    root,
    "packages/framework/client/src/workspace-manager.ts",
  );
  const wmText = await readFile(wmPath, "utf8");
  const violation = findWorkspaceManagerBoundaryViolation(wmText);
  if (violation) failures.push(`workspace-manager.ts: ${violation}`);
}

// P3 substrate purity: the core context file carries no policy package
// import — the boundary each extraction step widens, machine-checked.
await scan(
  join(root, "packages/framework/client/src"),
  /\.tsx?$/u,
  (full, text) => {
    const relative = full.slice(root.length + 1).replaceAll("\\", "/");
    const violation = findSubstratePurityViolation(relative, text);
    if (violation) failures.push(`${relative}: ${violation}`);
  },
);

// decisions §1.2: product policy (domains) never depends on the host layer.
await scan(join(root, "packages/domains"), sourceExtensions, (full, text) => {
  const relative = full.slice(root.length + 1).replaceAll("\\", "/");
  if (!relative.includes("/src/")) return;
  for (const match of text.matchAll(
    /from\s+["'](@natalia\/[a-z-]+(?:\/[^"']*)?)["']/gu,
  )) {
    const violation = findPolicyHostDependencyViolation(match[1]!, relative);
    if (violation) failures.push(`${relative}: ${violation}`);
  }
});

// Housekeeping rule ("不留冗余", mechanized): a compiled artifact beside
// its TypeScript source is dead weight AND a resolution landmine (a
// stray `./x` import could bind the stale JS). The build emits only
// declarations to dist/, so any source-tree .js/.d.ts with a .ts twin
// is a leftover. Skips the usual output/dependency dirs.
{
  const twinViolation = async (dir: string): Promise<void> => {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (skippedDirs.has(entry.name) || entry.name === "coverage") continue;
        await twinViolation(full);
        continue;
      }
      // Default-ban source-tree JS (round 51): compiled artifacts AND
      // orphans whose .ts twin MOVED AWAY both vanish behind one rule —
      // the orphan case is how a stale compiled test kept running in the
      // full suite after its source moved. Only ALLOWED_LEGACY_JS stays.
      const violation = findSourceTreeJsViolation(
        `${dir.slice(root.length + 1)}/${entry.name}`.replace(/^\//u, ""),
      );
      if (violation) failures.push(violation);
    }
  };
  for (const dir of productionRoots) await twinViolation(join(root, dir));
}

if (failures.length) {
  console.error(failures.join("\n"));
  process.exit(1);
}
if (largeSourceFiles.length)
  console.warn(
    `source files over ${maxSourceLines} lines (advisory):\n${largeSourceFiles.join("\n")}`,
  );
console.log("import guard passed");

/**
 * Recursively collects every workspace package under a root directory. The
 * package topology is nested (`packages/core/*`, `packages/domains/*`), so a
 * one-level readdir silently skips packages below the top level. Directory
 * entries that are not packages (vendored trees, build output, dependencies)
 * are pruned with the same skip set the source scan uses.
 */
async function workspacePackageEntries(rootDir: string): Promise<string[]> {
  const entries: string[] = [];
  const visit = async (directory: string): Promise<void> => {
    let children;
    try {
      children = await readdir(directory, { withFileTypes: true });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
      throw error;
    }
    for (const entry of children) {
      if (!entry.isDirectory()) continue;
      if (skippedDirs.has(entry.name)) continue;
      const full = join(directory, entry.name);
      if (await Bun.file(join(full, "package.json")).exists()) {
        entries.push(full.slice(root.length + 1));
        continue;
      }
      await visit(full);
    }
  };
  await visit(join(root, rootDir));
  return entries;
}

async function workspacePackageManifests(rootDir: string) {
  const manifests: {
    name?: string;
    dependencies?: Record<string, string>;
    path: string;
  }[] = [];
  for (const relative of await workspacePackageEntries(rootDir)) {
    try {
      const parsed = JSON.parse(
        await readFile(join(root, relative, "package.json"), "utf8"),
      ) as { name?: string; dependencies?: Record<string, string> };
      manifests.push({ ...parsed, path: join(root, relative, "package.json") });
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return manifests;
}

async function scan(
  path: string,
  include: RegExp,
  check: (full: string, text: string) => void,
): Promise<void> {
  let entries;
  try {
    entries = await readdir(path, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return;
    throw error;
  }
  for (const entry of entries) {
    const full = join(path, entry.name);
    if (entry.isDirectory()) {
      if (skippedDirs.has(entry.name)) continue;
      await scan(full, include, check);
      continue;
    }
    if (!include.test(entry.name)) continue;
    const text = await readFile(full, "utf8");
    check(full, text);
  }
}
