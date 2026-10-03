/**
 * The managed shell environment: the `NATALIA_*` facts every model shell call
 * carries.
 *
 * WHY THIS EXISTS. The shell tool's environment is an allowlist — `PATH`, `HOME`,
 * `TMPDIR`, `LANG`, `LC_ALL`, `TERM`, plus whatever the caller adds. That is
 * correct policy (a command must not read the runtime's whole environment) and it
 * had a consequence nobody chose: `NATALIA_HOME` was not in it, so a command run
 * by a model could not find the harness's own home unless an operator happened to
 * allowlist it. Facts the harness owns were being filtered out by the very rule
 * that exists to keep untrusted values out.
 *
 * The split, following the harness this was modelled on: policy values a caller
 * OPTS INTO stay ordinary `env` entries; facts the HARNESS OWNS live here and are
 * injected regardless. A contributor declares the keys it owns and resolves their
 * values per execution; the registry merges them last, so a caller's entry can
 * never displace a managed one — the reverse of the ambiguity that produced the gap.
 *
 * WHAT IS DELIBERATELY NOT HERE. `NATALIA_CONFIG`, `NATALIA_WORKSPACES_FILE`,
 * `NATALIA_BASH_EXECUTABLE`, `NATALIA_MEMORY_TRACE` and the other eleven-or-so
 * `NATALIA_*` names in the tree are configuration, not per-execution facts. They
 * keep flowing through the caller's allowlist. Marking a variable with our prefix
 * does not make it harness-owned, and a registry that tried to own all of them
 * would be a second, competing configuration channel.
 */

/** The managed-namespace prefix. Every key here starts with it. */
export const NATALIA_ENV_PREFIX = "NATALIA_";

export const NATALIA_HOME_ENV = `${NATALIA_ENV_PREFIX}HOME` as const;
export const NATALIA_SHELL_ENV = `${NATALIA_ENV_PREFIX}SHELL` as const;
export const NATALIA_SESSION_ID_ENV =
  `${NATALIA_ENV_PREFIX}SESSION_ID` as const;

/**
 * The facts the registry itself owns. A contributor cannot take one: two owners of
 * `NATALIA_HOME` would make "which home did this command see" unanswerable.
 */
const RESERVED_SHELL_ENV_KEYS: ReadonlySet<string> = new Set([
  NATALIA_HOME_ENV,
  NATALIA_SHELL_ENV,
  NATALIA_SESSION_ID_ENV,
]);

/** A managed key's suffix: uppercase words, as an environment variable must be. */
const KEY_SUFFIX = /^[A-Z][A-Z0-9_]*$/;

/** What an execution is, as far as the managed environment cares. */
export interface ShellEnvExecution {
  /**
   * The session this execution belongs to, when there is one.
   *
   * Absent for a caller outside any session — a background sweep, a CLI command.
   * `NATALIA_SESSION_ID` is then simply not in the snapshot rather than being
   * some placeholder, because a command that reads it must be able to tell "no
   * session" from "this session".
   */
  sessionID?: string | undefined;
}

/** Model-visible metadata for one managed variable. */
export interface ShellEnvVariable {
  /** What the fact means. Required: an undescribed variable cannot be audited. */
  description: string;
}

/**
 * One contributor's declared ownership of the managed environment.
 *
 * `variables` is the COMPLETE set of keys this contributor may return. Declaring
 * them up front is what makes an ownership collision a registration-time error
 * instead of a "which value won" question asked after a command has run.
 */
export interface ShellEnvContributor {
  /** Stable name, used in diagnostics and in collision messages. */
  name: string;
  /** Every key this contributor owns, each with its description. */
  variables: Readonly<Record<string, ShellEnvVariable>>;
  /**
   * Resolve this contributor's values for one execution.
   * @returns a partial map containing ONLY keys declared in `variables`.
   */
  resolve(
    execution: ShellEnvExecution,
  ): Readonly<Partial<Record<string, string>>>;
}

/** A declaration, as reported by {@link ShellEnvRegistry.list}. */
export interface ShellEnvVariableInfo extends ShellEnvVariable {
  /** The contributor that owns the variable. */
  contributor: string;
  /** The declared variable name. */
  key: string;
}

/** A resolved snapshot: immutable, and safe to hand to a spawn. */
export type ShellEnv = Readonly<Record<string, string>>;

/**
 * The registry of managed shell environment facts.
 *
 * Not a global singleton: a registry is constructed with the harness home it
 * exposes, so a test and a running harness have separate ones and neither can
 * observe the other's contributors.
 */
export class ShellEnvRegistry {
  private readonly contributors = new Map<string, ShellEnvContributor>();
  private readonly keyOwners = new Map<string, string>();
  private readonly nataliaHome: string;

  constructor(nataliaHome: string) {
    this.nataliaHome = nataliaHome;
  }

  /**
   * Register a contributor.
   *
   * Every check here runs at registration rather than at first execution, because
   * the value of declaring keys is that a mistake is caught while the mistake is
   * still a line in a config file rather than a wrong value inside a command that
   * has already run.
   *
   * @param contributor - declared key ownership and the per-execution resolver.
   * @returns a disposer that unregisters the contribution.
   */
  register(contributor: ShellEnvContributor): () => void {
    const problems: string[] = [];
    if (contributor.name.trim().length === 0)
      problems.push("contributor name must be non-empty");
    if (this.contributors.has(contributor.name))
      problems.push(`contributor "${contributor.name}" is already registered`);

    const keys = Object.keys(contributor.variables);
    for (const key of keys) {
      if (!key.startsWith(NATALIA_ENV_PREFIX))
        problems.push(
          `key "${key}" is outside the ${NATALIA_ENV_PREFIX} namespace`,
        );
      else if (!KEY_SUFFIX.test(key.slice(NATALIA_ENV_PREFIX.length)))
        problems.push(`key "${key}" has an invalid suffix`);
      if (RESERVED_SHELL_ENV_KEYS.has(key))
        problems.push(`key "${key}" is reserved and cannot be contributed`);
      if (contributor.variables[key]!.description.trim().length === 0)
        problems.push(`key "${key}" must be described`);
      const owner = this.keyOwners.get(key);
      if (owner !== undefined && owner !== contributor.name)
        problems.push(
          `key "${key}" is already owned by "${owner}"; "${contributor.name}" cannot also own it`,
        );
    }
    if (problems.length > 0)
      throw new Error(
        `shell env contributor "${contributor.name}" is invalid: ${problems.join("; ")}`,
      );

    this.contributors.set(contributor.name, contributor);
    for (const key of keys) this.keyOwners.set(key, contributor.name);
    return () => {
      this.contributors.delete(contributor.name);
      for (const key of keys) this.keyOwners.delete(key);
    };
  }

  /**
   * Build the managed snapshot for one execution.
   *
   * Contributors are visited in name order so two executions of the same request
   * produce byte-identical environments — a command's behaviour must not depend on
   * the order a plugin happened to be loaded in.
   */
  collect(execution: ShellEnvExecution): ShellEnv {
    const values: Record<string, string> = {
      [NATALIA_HOME_ENV]: this.nataliaHome,
      [NATALIA_SHELL_ENV]: "1",
    };
    if (execution.sessionID !== undefined)
      values[NATALIA_SESSION_ID_ENV] = execution.sessionID;

    for (const contributor of [...this.contributors.values()].sort(
      (left, right) => left.name.localeCompare(right.name),
    )) {
      const resolved = contributor.resolve(execution);
      for (const [key, value] of Object.entries(resolved)) {
        if (!Object.hasOwn(contributor.variables, key))
          throw new Error(
            `shell env contributor "${contributor.name}" returned undeclared key "${key}"`,
          );
        if (typeof value !== "string" && value !== undefined)
          throw new Error(
            `shell env contributor "${contributor.name}" returned a non-string value for "${key}"`,
          );
        if (value !== undefined) values[key] = value;
      }
    }

    return Object.freeze(
      Object.fromEntries(
        Object.entries(values).sort(([left], [right]) =>
          left.localeCompare(right),
        ),
      ),
    );
  }

  /**
   * Enumerate what is contributed, WITHOUT running any resolver.
   *
   * A resolver can be expensive or can have side effects the caller only wants at
   * execution time; diagnostics and the model's own view of its environment must
   * not trigger them.
   */
  list(): ShellEnvVariableInfo[] {
    return [...this.contributors.values()]
      .flatMap((contributor) =>
        Object.entries(contributor.variables).map(([key, variable]) => ({
          contributor: contributor.name,
          description: variable.description,
          key,
        })),
      )
      .sort((left, right) => left.key.localeCompare(right.key));
  }
}

/**
 * Apply the managed namespace to a caller's environment.
 *
 * One rule: the snapshot merges LAST, so a managed fact always wins.
 *
 * That is the whole mechanism. An earlier version also dropped every `NATALIA_*`
 * entry from the caller's map on the theory that an ambient value must not leak in —
 * and two existing tests failed, because a caller setting `NATALIA_PROBE_VAR` through
 * the allowlist is not an ambient leak, it is a deliberate entry. The distinction that
 * rule was reaching for is about values inherited from the harness PROCESS rather than
 * passed by a caller, and this seam never passes those: `env` is either a caller-built
 * allowlist or absent, and absent is documented as "inherit". So the merge order
 * carries the contract by itself, and dropping entries would only remove a caller's
 * ability to name a variable in their own namespace.
 *
 * @param env - the caller's environment, already sanitised by policy above here.
 * @param shellEnv - the managed snapshot for this execution.
 */
export function applyShellEnv(
  env: Record<string, string | undefined> | undefined,
  shellEnv: ShellEnv | undefined,
): Record<string, string | undefined> | undefined {
  // Both absent returns ABSENT, not an empty object. `spawn(env: {})` does not
  // inherit anything, so collapsing "no environment" into "no keys" would silently
  // take PATH away from every command run without an explicit env — which is
  // exactly what happened on the first attempt and what an existing test caught.
  if (env === undefined && shellEnv === undefined) return undefined;
  return { ...env, ...shellEnv };
}
