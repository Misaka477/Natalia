/**
 * Service tokens — the one shape every cross-module service binding takes.
 *
 * A token is the typed, greppable name of a service. Its string id is the wire
 * name shared with the JSON contracts (manifest `provides`, composition rows),
 * and its phantom type parameter carries the service's TypeScript type to
 * consumers, so `ctx.get(token)` needs no `<T>` cast. Tokens are frozen data:
 * two independent definitions of the same id denote the same service, which is
 * what makes "token.id is the wire name" safe — a duplicated definition is a
 * second spelling of one wire, not a second service.
 *
 * The directory resolves tokens through a narrow bindings seam: the runtime
 * binding is backed by the capability registry's service contributions, a test
 * binding is a plain map, and the primitive knows about neither.
 */

declare const SERVICE_TYPE: unique symbol;

/** Instance lifetime a service is bound for; mirrors the capability scopes. */
export type ServiceScope = "process" | "workspace" | "session";

/** The key kind a keyed service is addressed by (`ctx.get(token, key)`). */
export type ServiceKeyKind = "workspace" | "session";

/**
 * The declaration that makes the service graph derivable from tokens alone.
 * `scope`/`capability` are consumed by activation-time gating and `required`
 * by graph validation; `keyedBy` marks the tokens resolved through the keyed
 * get form. All fields are optional data — the directory below resolves by id
 * and stays correct as the graph checks land.
 */
export type ServiceMeta = {
  /** Instance lifetime. Defaults to `process`. */
  scope?: ServiceScope;
  /** Capability group the provider must hold to bind this service. */
  capability?: string;
  /** Whether activation fails when no provider exists. Defaults to true. */
  required?: boolean;
  /** When set, `get` takes a workspace/session key. */
  keyedBy?: ServiceKeyKind;
};

/** One test-context binding produced by `token.mock(value)`. */
export type ServiceMockEntry<T> = {
  readonly token: ServiceToken<T>;
  readonly value: T;
};

/**
 * The stable identity of one service contract.
 *
 * The symbol member is phantom-only: it is never present at runtime, it exists
 * so the type parameter participates in assignability (a
 * `ServiceToken<TerminalController>` is not a `ServiceToken<Other>`), and it is
 * written in method position so concrete tokens stay assignable to
 * `ServiceToken<unknown>` for heterogeneous mock arrays.
 */
export interface ServiceToken<T> {
  readonly id: string;
  readonly meta: ServiceMeta;
  [SERVICE_TYPE]?(value: T): T;
  /** Builds a test-context entry binding `value` to this token. */
  mock(value: T): ServiceMockEntry<T>;
}

/**
 * Composition row namespaces are reserved for the declarative layer; a token id
 * colliding with one would blur "what is bound" (token) with "what is chosen"
 * (row). The reservation is fail-fast at definition time.
 */
const reservedIDPrefixes = [
  "anthelia.",
  "natalia.",
  "plugin:",
  "facet:",
] as const;

/** Defines one service token. One line, in the package that owns the service. */
export function defineService<T>(
  id: string,
  meta: ServiceMeta = {},
): ServiceToken<T> {
  if (!id) throw new TypeError("service id must not be empty");
  for (const prefix of reservedIDPrefixes)
    if (id.startsWith(prefix))
      throw new TypeError(
        `service id "${id}" uses the reserved prefix "${prefix}"`,
      );
  const token: ServiceToken<T> = {
    id,
    meta: Object.freeze({ ...meta }),
    mock: (value: T) => ({ token, value }),
  };
  return Object.freeze(token);
}

/**
 * The minimal resolution seam behind a directory. The runtime implementation
 * forwards `provide`/`get` to the capability registry's service bindings; tests
 * use `createTestContext`. Keeping it this narrow is what lets one directory
 * serve both.
 */
export interface ServiceBindings {
  /**
   * Binds `value` to `id`. `scope` is the owner lifetime the binding takes
   * (the capability registry's scopes), so a token's declared lifetime reaches
   * the binding that enforces it. Returns the disposer that unbinds it.
   */
  provide(id: string, value: unknown, scope?: ServiceScope): () => void;
  get<T>(id: string): T | undefined;
}

/**
 * The typed face over a service bindings.
 *
 * Resolution is call-time, matching the ports semantics it migrates: modules
 * read services when they use them, so construction order never matters and a
 * replaced provider (plugin reload) is picked up by the next read. Activation
 * ordering and eager binding arrive with the composition substrate; until then
 * an eager cache here would freeze reloaded services, which is a bug, not an
 * optimization.
 */
export class ServiceDirectory {
  constructor(private readonly bindings: ServiceBindings) {}

  /** Binds `value` to `token`; the disposer unbinds it. */
  provide<T>(token: ServiceToken<T>, value: T): () => void {
    return this.bindings.provide(token.id, value, token.meta.scope);
  }

  /** Resolves `token`, failing loud when nothing provides it. */
  get<T>(token: ServiceToken<T>): T {
    const value = this.bindings.get<T>(token.id);
    if (value === undefined)
      throw new Error(`service "${token.id}" is not provided`);
    return value;
  }

  /**
   * Resolves `token` when present, `undefined` when not. For consumers whose
   * contract tolerates a missing service (an optional plugin's registry), so
   * the tolerance is stated at the resolution instead of a try/catch per call
   * site.
   */
  getOptional<T>(token: ServiceToken<T>): T | undefined {
    return this.bindings.get<T>(token.id);
  }
}

/**
 * Builds a test context from mock entries — the standard replacement for
 * hand-rolled port stubs. Entries are heterogeneous; duplicate ids fail fast
 * because two mocks for one wire is a test bug, not a merge.
 */
export function createTestContext(
  entries: readonly ServiceMockEntry<unknown>[],
): ServiceDirectory {
  const values = new Map<string, unknown>();
  for (const entry of entries) {
    if (values.has(entry.token.id))
      throw new Error(`duplicate test mock for service "${entry.token.id}"`);
    values.set(entry.token.id, entry.value);
  }
  return new ServiceDirectory({
    provide: (id, value) => {
      values.set(id, value);
      return () => {
        values.delete(id);
      };
    },
    get: <T>(id: string) => values.get(id) as T | undefined,
  });
}
