/**
 * Service-graph analysis for the dependency-cycle guard (interface spec §5.3).
 *
 * The package-level guard answers "do packages import each other in a loop".
 * This module answers the question that level cannot see: *services* form
 * their own dependency graph — a plugin requires a service another plugin
 * provides — and that graph can deadlock while every package.json edge stays
 * acyclic. Two plugins requiring each other's services is the classic shape.
 *
 * Everything here reads *declarations* (spec: "从猜 import 升级为读声明"):
 *
 * - token declarations — `defineService<...>("id", { meta })` from production
 *   sources, giving the id namespace and the variable name each provide/get
 *   call site speaks;
 * - provides — plugin manifests (`provides: [...]`, plugin packages only) and
 *   `provide(...)` call sites (`api.services.provide`, the host's
 *   `serviceDirectory.provide`, and local wrappers around it);
 * - requires — plugin manifests (`requires: [...]`) and `get(...)` call sites
 *   (`api.services.get`, `serviceDirectory.get/getOptional`).
 *
 * The host is the provider root, never a consumer: its consumption of
 * plugin-provided services is call-time resolution (spec §5.3 item 4 records
 * that P1's directory resolves lazily), so a host→plugin→host require cycle is
 * the intended shape, not a deadlock. Kahn therefore runs over the
 * plugin-to-plugin edges only, where a cycle is the real deadlock class.
 *
 * The analysis is static source scanning: no imports, no execution, no
 * registry boot. Its checks (duplicate ids, missing providers, double
 * providers, Kahn cycles, orphan tokens) fail the gate with the messages the
 * spec copied from Chord's `validateFacets`.
 */

export type ServiceGraphNode = {
  /** Workspace package name, or the host sentinel. */
  readonly package: string;
  /** Files that contributed edges. */
  readonly files: ReadonlySet<string>;
  /** Service ids this node provides. */
  readonly provides: ReadonlySet<string>;
  /** Service ids this node requires. */
  readonly requires: ReadonlySet<string>;
};

export type TokenDeclaration = {
  readonly id: string;
  /** The exported const name, e.g. `skillService`. */
  readonly variable: string;
  readonly file: string;
  readonly pkg: string;
  readonly scope?: string;
  readonly capability?: string;
};

type MutableNode = {
  package: string;
  files: Set<string>;
  provides: Set<string>;
  requires: Set<string>;
};

export type ServiceGraphReport = {
  readonly tokens: readonly TokenDeclaration[];
  readonly nodes: readonly ServiceGraphNode[];
  readonly problems: readonly string[];
};

/** The host is a single node: the runtime that binds most services itself. */
export const HOST_PACKAGE = "@natalia/host";

const TOKEN_DECLARATION =
  /export const (\w+) = defineService(?:<[^>]*>)?\(\s*"([^"]+)"\s*,\s*\{([^}]*)\}/dgs;
const META_SCOPE = /scope:\s*"([^"]+)"/;
const META_CAPABILITY = /capability:\s*"([^"]+)"/;

const VALID_SCOPES = new Set(["process", "workspace", "session"]);

export type ScannedFile = {
  readonly path: string;
  /** Workspace package name the file belongs to (or HOST_PACKAGE). */
  readonly pkg: string;
  readonly text: string;
};

/** Test files and fixtures are not the production declaration surface. */
export function isProductionSource(path: string): boolean {
  return (
    !path.includes("/test/") &&
    !path.endsWith(".test.ts") &&
    !path.endsWith(".spec.ts")
  );
}

/** Workspace package name for a repo-relative (or absolute) source path. */
export function packageOf(path: string): string {
  const LAYERS = "framework|domains|core|plugins|tooling|hosts";
  const m = new RegExp(`(?:^|/)packages/(${LAYERS})/([^/]+)/`).exec(path);
  if (!m) return HOST_PACKAGE;
  const [, layer, name] = m;
  if (layer === "plugins") return `@natalia/${name}-plugin`;
  return `@natalia/${name}`;
}

/** Every `defineService` declaration in one file. */
export function scanTokenDeclarations(file: ScannedFile): TokenDeclaration[] {
  const out: TokenDeclaration[] = [];
  for (const m of file.text.matchAll(TOKEN_DECLARATION)) {
    const [, variable, id, meta] = m;
    const scope = META_SCOPE.exec(meta ?? "")?.[1];
    const capability = META_CAPABILITY.exec(meta ?? "")?.[1];
    out.push({
      id,
      variable,
      file: file.path,
      pkg: file.pkg,
      ...(scope ? { scope } : {}),
      ...(capability ? { capability } : {}),
    });
  }
  return out;
}

/**
 * Token expressions used in one file, resolved through the *global* variable
 * map: provide sites live in files that import the token, so a per-file map
 * would resolve nothing there. Import aliases (`import { a as b }`) are
 * mapped too.
 */
function resolveTokenReferences(
  file: ScannedFile,
  byVariable: ReadonlyMap<string, string>,
): Map<string, string> {
  const references = new Map<string, string>();
  for (const m of file.text.matchAll(
    /import\s*\{([^}]*)\}\s*from\s*"[^"]+"/g,
  )) {
    for (const part of m[1]!.split(",")) {
      const alias = /\s*(\w+)\s+as\s+(\w+)\s*/.exec(part);
      if (!alias) continue;
      const id = byVariable.get(alias[1]!);
      if (id) references.set(alias[2]!, id);
    }
  }
  for (const m of file.text.matchAll(/\b(\w+)\.id\b/g)) {
    const id = references.get(m[1]!) ?? byVariable.get(m[1]!);
    if (id) references.set(m[0]!, id);
  }
  for (const m of file.text.matchAll(/\b([a-z]\w*)\b/g)) {
    const id = byVariable.get(m[1]!);
    if (id && !references.has(m[1]!)) references.set(m[1]!, id);
  }
  return references;
}

type Call = { readonly tokenId: string; readonly keyword: "provide" | "get" };

const CALL_PATTERNS: Array<[RegExp, Call["keyword"]]> = [
  [/api\.services\.provide\(\s*([^,]+),/g, "provide"],
  [/(?:serviceDirectory|directory)\.provide\(\s*([^,]+),/gi, "provide"],
  // Local wrappers around directory.provide (the host's refreshPluginInputs
  // passes its `token` parameter through a `provide(token, value)` helper).
  [/\bprovide\(\s*([^,]+),/g, "provide"],
  [/api\.services\.get(?:<[^>]*>)?\(\s*([^),]+)/g, "get"],
  [/(?:serviceDirectory|directory)\.get(?:Optional)?\(\s*([^),]+)/gi, "get"],
];

function collectCalls(
  file: ScannedFile,
  byVariable: ReadonlyMap<string, string>,
): Call[] {
  const references = resolveTokenReferences(file, byVariable);
  const calls: Call[] = [];
  for (const [pattern, keyword] of CALL_PATTERNS) {
    for (const m of file.text.matchAll(pattern)) {
      const expr = m[1]!.trim();
      const direct = references.get(expr);
      const member = /\b\w+\.id\b/.exec(expr);
      const id = direct ?? (member ? references.get(member[0]!) : undefined);
      if (id) calls.push({ tokenId: id, keyword });
    }
  }
  return calls;
}

/**
 * Manifest provides/requires, collected from plugin packages only: manifests
 * are a plugin concept, and domain objects can carry an unrelated `requires:`
 * key (work-contract evidence rules do).
 */
function collectManifestLists(
  file: ScannedFile,
  byVariable: ReadonlyMap<string, string>,
): { provides: Set<string>; requires: Set<string> } {
  const provides = new Set<string>();
  const requires = new Set<string>();
  if (!file.path.includes("/plugins/")) return { provides, requires };
  const references = resolveTokenReferences(file, byVariable);
  for (const key of ["provides", "requires"] as const) {
    const m = new RegExp(`\\b${key}:\\s*\\[([^\\]]*)\\]`, "gs").exec(file.text);
    if (!m) continue;
    for (const item of m[1]!.split(",")) {
      const expr = item.trim();
      if (!expr) continue;
      const member = /\b(\w+)\.id\b/.exec(expr);
      const id = member
        ? references.get(member[0]!)
        : (references.get(expr) ??
          (/^["'][^"']+["']$/.test(expr) ? expr.slice(1, -1) : undefined));
      if (id) (key === "provides" ? provides : requires).add(id);
    }
  }
  return { provides, requires };
}

/**
 * Build the service graph and run every §5.3 check. `problems` is empty when
 * the declarations are sound.
 */
export function analyzeServiceGraph(
  files: readonly ScannedFile[],
): ServiceGraphReport {
  const tokens: TokenDeclaration[] = [];
  for (const file of files)
    if (file.path.includes("/src/"))
      tokens.push(...scanTokenDeclarations(file));
  const byVariable = new Map(tokens.map((t) => [t.variable, t.id]));

  const problems: string[] = [];

  // 1. id uniqueness — convention 2's registration-time check, statically.
  const byId = new Map<string, TokenDeclaration[]>();
  for (const token of tokens) {
    const list = byId.get(token.id) ?? [];
    list.push(token);
    byId.set(token.id, list);
  }
  for (const [id, list] of byId)
    if (list.length > 1)
      problems.push(
        `duplicate service id "${id}" declared in ${list.map((t) => t.file).join(" and ")}`,
      );

  // 2. meta well-formedness.
  for (const token of tokens) {
    if (token.scope && !VALID_SCOPES.has(token.scope))
      problems.push(
        `token "${token.id}" declares invalid scope "${token.scope}" (${token.file})`,
      );
    if (!token.capability)
      problems.push(
        `token "${token.id}" declares no capability (${token.file})`,
      );
  }

  // 3. providers index + consumer edges (production sources only: a fixture's
  //    provide binds nothing in a real graph).
  const nodes = new Map<string, MutableNode>();
  const nodeFor = (pkg: string, file: string): MutableNode => {
    let node = nodes.get(pkg);
    if (!node) {
      node = {
        package: pkg,
        files: new Set(),
        provides: new Set(),
        requires: new Set(),
      };
      nodes.set(pkg, node);
    }
    node.files.add(file);
    return node;
  };
  const providers = new Map<string, Set<string>>();

  const addProvide = (id: string, pkg: string, file: string) => {
    nodeFor(pkg, file).provides.add(id);
    const set = providers.get(id) ?? new Set();
    set.add(pkg);
    providers.set(id, set);
  };
  const addRequire = (id: string, pkg: string, file: string) => {
    nodeFor(pkg, file).requires.add(id);
  };

  for (const file of files) {
    if (!isProductionSource(file.path)) continue;
    const { provides, requires } = collectManifestLists(file, byVariable);
    for (const id of provides) addProvide(id, file.pkg, file.path);
    for (const id of requires) addRequire(id, file.pkg, file.path);
    for (const call of collectCalls(file, byVariable)) {
      if (call.keyword === "provide")
        addProvide(call.tokenId, file.pkg, file.path);
      else addRequire(call.tokenId, file.pkg, file.path);
    }
  }

  // 4. every required id has a provider (Chord's missing-provider message).
  for (const node of nodes.values())
    for (const id of node.requires)
      if (!providers.has(id))
        problems.push(
          `service "${id}" is required by ${node.package} but no package provides it (${[...node.files].join(", ")})`,
        );

  // 4b. a provided id is owned by exactly one package (Chord's both-providers
  //     message). Ownership collisions are defects even before a consumer.
  for (const [id, set] of providers)
    if (set.size > 1)
      problems.push(
        `service "${id}" is provided by both ${[...set].sort().join(" and ")}`,
      );

  // 5. every declared token has a provider (an orphan declaration is a stub).
  for (const token of tokens)
    if (!providers.has(token.id))
      problems.push(
        `token "${token.id}" is declared in ${token.file} but never provided`,
      );

  // 6. Kahn over plugin-to-plugin edges. The host is the provider root, not a
  //    consumer: its consumes resolve lazily (spec §5.3 item 4), so requiring a
  //    host-provided service creates no edge and host cycles are not deadlocks.
  const edges = new Map<string, Set<string>>();
  for (const node of nodes.values()) {
    // Only plugin nodes participate in the deadlock graph: everything else is
    // host-side machinery that provides or consumes, but never activation-
    // blocks on a plugin.
    if (!node.package.endsWith("-plugin")) continue;
    const targets = new Set<string>();
    for (const id of node.requires)
      for (const provider of providers.get(id) ?? [])
        if (provider !== node.package && provider !== HOST_PACKAGE)
          targets.add(provider);
    edges.set(node.package, targets);
  }
  const indegree = new Map<string, number>();
  for (const [, targets] of edges)
    for (const target of targets)
      indegree.set(target, (indegree.get(target) ?? 0) + 1);
  const ready = [...edges.keys()].filter(
    (pkg) => (indegree.get(pkg) ?? 0) === 0,
  );
  const ordered: string[] = [];
  while (ready.length) {
    const pkg = ready.shift()!;
    ordered.push(pkg);
    for (const target of edges.get(pkg) ?? []) {
      const left = (indegree.get(target) ?? 0) - 1;
      indegree.set(target, left);
      if (left === 0) ready.push(target);
    }
  }
  const cycleNodes = [...edges.keys()].filter((pkg) => !ordered.includes(pkg));
  if (cycleNodes.length)
    problems.push(
      `dependency cycle: ${cycleNodes.sort().join(" -> ")} (service requires/provides form a loop)`,
    );

  return { tokens, nodes: [...nodes.values()], problems };
}
