/**
 * Loading a user-supplied provider adapter from a local module.
 *
 * This is the extension point that makes the seam real: an endpoint declares
 * `protocol: { format: "my-format", module: "./adapters/mine.ts" }`, and the
 * module's default export becomes the adapter registered under that format. The
 * alternative — shipping every wire format inside this package — would put every
 * new provider behind a release.
 *
 * Registration happens once at composition time, not per request: dynamic
 * `import()` is asynchronous and `providerFromKind` is not, so loading eagerly
 * keeps the dispatch path synchronous. A module that fails to load is reported
 * here and again at dispatch, because a session with other working providers
 * should not be blocked by one broken adapter.
 */

import { isAbsolute, relative, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import {
  registerProviderAdapter,
  unregisterProviderAdapters,
  type AnyProviderAdapter,
  type ProviderAdapterOptions,
} from "./provider-adapters";

/** Extensions a local adapter module may use, matching the plugin loader. */
const ADAPTER_MODULE_EXTENSIONS = [".js", ".mjs", ".ts"];

/**
 * Resolve and validate an adapter module path against a root.
 *
 * Mirrors the plugin loader's rule so the two cannot drift: the path must stay
 * inside the root and must name a local JS or TS module. Loading arbitrary user
 * code is the point of the feature — the user is already able to run their own
 * program — so the constraint here is about accidental escapes, not sandboxing.
 */
export function validateProviderAdapterPath(
  root: string,
  path: string,
): string {
  const resolved = resolve(root, path);
  const inside = relative(resolve(root), resolved);
  if (inside !== "" && (inside.startsWith("..") || isAbsolute(inside)))
    throw new Error("provider adapter path escapes the workspace root");
  if (
    !isAbsolute(resolved) ||
    !ADAPTER_MODULE_EXTENSIONS.some((extension) => resolved.endsWith(extension))
  )
    throw new Error(
      "provider adapter module must be a local .js, .mjs or .ts file",
    );
  return resolved;
}

/** The shape a loaded module's default export must have. */
function assertAdapterShape(value: unknown): AnyProviderAdapter {
  if (typeof value !== "object" || value === null)
    throw new Error(
      "provider adapter module must default-export an adapter object",
    );
  const candidate = value as Partial<AnyProviderAdapter>;
  if (typeof candidate.format !== "string" || candidate.format.length === 0)
    throw new Error(
      "provider adapter must declare a non-empty `format` string; it is the " +
        "registry key and must match the endpoint's `protocol.format`",
    );
  if (typeof candidate.create !== "function")
    throw new Error("provider adapter must expose a `create(options)` factory");
  return candidate as AnyProviderAdapter;
}

/** One endpoint that wants a module-provided adapter. */
export interface ProviderAdapterModuleRequest {
  /** Provider id, for diagnostics. */
  readonly providerID: string;
  /** Declared format; must match what the module's adapter declares. */
  readonly format: string;
  /** Module path, resolved against the workspace root. */
  readonly module: string;
}

/** The outcome of loading one module. */
export interface ProviderAdapterModuleLoad {
  readonly results: readonly ProviderAdapterModuleResult[];
  /** Withdraw every adapter this call registered. */
  withdraw(): void;
}

export interface ProviderAdapterModuleResult {
  readonly providerID: string;
  readonly module: string;
  readonly ok: boolean;
  readonly error?: string;
}

/**
 * Load and register the adapters named by endpoint configuration.
 *
 * A module is registered under its resolved path as the source id, so a reload
 * can withdraw exactly what a previous load installed without touching the
 * built-ins.
 *
 * Failures are returned rather than thrown: one broken module must not stop the
 * session from starting, and the caller publishes each as a diagnostic so the
 * cause is visible before dispatch repeats it.
 */
export async function loadProviderAdapterModules(input: {
  workspaceRoot: string;
  requests: readonly ProviderAdapterModuleRequest[];
}): Promise<ProviderAdapterModuleLoad> {
  const results: ProviderAdapterModuleResult[] = [];
  const registered: string[] = [];
  for (const request of input.requests) {
    try {
      const entry = validateProviderAdapterPath(
        input.workspaceRoot,
        request.module,
      );
      const module = (await import(pathToFileURL(entry).href)) as {
        default?: unknown;
      };
      const adapter = assertAdapterShape(module.default);
      if (adapter.format !== request.format)
        throw new Error(
          `adapter declares format "${adapter.format}" but the endpoint ` +
            `declares "${request.format}"; they must match`,
        );
      registerProviderAdapter(adapter, entry);
      registered.push(entry);
      results.push({ providerID: request.providerID, module: entry, ok: true });
    } catch (error) {
      results.push({
        providerID: request.providerID,
        module: request.module,
        ok: false,
        error: error instanceof Error ? error.message : String(error),
      });
    }
  }
  return {
    results,
    withdraw() {
      // By module path, which is the source id each was registered under. A
      // module that failed to load registered nothing, so withdrawing the ones
      // that succeeded is exactly the whole set.
      for (const entry of registered) unregisterProviderAdapters(entry);
    },
  };
}

/**
 * The adapter modules currently registered, and the only way to replace them.
 *
 * Held here rather than by a caller because there are two: initialization loads
 * them once, and a config reload must replace them when the configured set
 * changes. A holder in each caller would let the two disagree about which
 * modules are live — and `registerProviderAdapter` throws on a duplicate format,
 * so a disagreement surfaces as a failed reload rather than a stale adapter.
 */
let currentLoad: ProviderAdapterModuleLoad | undefined;

/**
 * Load the configured adapter modules, withdrawing whatever a previous call
 * loaded. Safe to call repeatedly, which is what a config reload needs.
 */
export async function reloadProviderAdapterModules(input: {
  workspaceRoot: string;
  requests: readonly ProviderAdapterModuleRequest[];
}): Promise<readonly ProviderAdapterModuleResult[]> {
  currentLoad?.withdraw();
  currentLoad = await loadProviderAdapterModules(input);
  return currentLoad.results;
}

/** Every module-provided format, for diagnostics and tests. */
export function providerAdapterModuleRequests(
  providers:
    | Record<
        string,
        | { protocol?: { format?: string; module?: string } | undefined }
        | undefined
      >
    | undefined,
): ProviderAdapterModuleRequest[] {
  const requests: ProviderAdapterModuleRequest[] = [];
  for (const [providerID, provider] of Object.entries(providers ?? {})) {
    const format = provider?.protocol?.format;
    const module = provider?.protocol?.module;
    if (!format || !module) continue;
    requests.push({ providerID, format, module });
  }
  return requests;
}

/** Test seam: the adapter options type re-exported for authoring modules. */
export type { ProviderAdapterOptions };
