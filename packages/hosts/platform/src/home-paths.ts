/**
 * The one place a Natalia user-data location is resolved.
 *
 * The port grew FIVE per-user global roots instead of one: `~/.natalia`
 * (`store-paths.ts`), `<config-home>/natalia` (`service-resolution.ts`,
 * `tui-config.ts`, `workspace-manager.ts`, `foundation.ts`), a cwd-relative
 * `<cwd>/.natalia` (`config-home.ts`, `runtime-commands.ts`), a daemon
 * directory under `userStateHome()`, and a composition drop-in under
 * `userRuntimeHome()`. Nothing that reported or purged that state agreed with
 * where it was: `purgeData` deleted `<home>/config.json` — a path no code
 * writes — and the debug bundle read the same empty file, so "remove the
 * configuration" removed nothing. Worse, the Start Menu shortcut sets the
 * working directory to the install folder, so a normal launch wrote the model
 * configuration into `<install>\.natalia\` — which the uninstaller deletes.
 *
 * The reference implementation settles this with one module
 * (`packages/util/home-paths`): a single home, `~/.dsh`, resolved from an
 * explicit value, then `$DSH_HOME`, then the user home — never the working
 * directory, and with a blank environment value treated as unset so that an
 * empty override cannot silently mean "here". Everything else is a typed child
 * of that home. This module is the same contract for Natalia.
 *
 * Platform branch: NONE, deliberately. `homedir()` is the user home on every
 * platform we ship (`%USERPROFILE%` on Windows, `$HOME` elsewhere), and the
 * five roots above are exactly what a per-platform branch produced. A
 * platform-specific rule here would recreate the split.
 *
 * Not owned by this home, and named so nobody "unifies" them later: the CEF
 * profile and `<install>\user-data` belong to the desktop shell, and the
 * updater's download cache belongs to the OS convention. The reference keeps
 * the same separation.
 */
import { homedir } from "node:os";
import { posix, win32, join, resolve } from "node:path";

/** The directory name of the one user-data home, under the user home. */
export const NATALIA_HOME_DIR_NAME = ".natalia";

/** Overrides the home outright; an empty or blank value is treated as unset. */
export const NATALIA_HOME_ENV = "NATALIA_HOME";

/**
 * The store's own relocation switch, kept as an ALIAS of {@link NATALIA_HOME_ENV}.
 *
 * `store-paths.ts` documented it as "the state root, so no extra `.natalia`
 * segment is added" — which is what the home is. Two switches for one root is
 * how a user ends up with a store in one tree and a config in another, so it
 * resolves to the same place; the name stays because a deployed environment
 * may already carry it and a relocation that silently stops working is worse
 * than a documented alias.
 */
export const NATALIA_STORE_HOME_ENV = "NATALIA_STORE_HOME";

/** The symbolic form of the default home, for user-facing text. */
export const DEFAULT_NATALIA_HOME_DISPLAY = `~/${NATALIA_HOME_DIR_NAME}`;

/** The legacy directory names this product has used under a state root. */
export const LEGACY_NATALIA_HOME_DIR_NAMES = ["natalia-cli"] as const;

/**
 * The name this product used under the CONFIG home before the home moved:
 * `~/.config/natalia` on POSIX and `%APPDATA%\natalia` on Windows. It is not
 * the live directory name — that is {@link NATALIA_HOME_DIR_NAME} — and the
 * distinction is the whole point of the legacy list: the old roots were named
 * after the product, the new one is a hidden directory beside the user's own.
 */
export const NATALIA_CONFIG_DIR_NAME = "natalia";

/**
 * The platform seam, declared here rather than imported from the package
 * barrel: `index.ts` re-exports this module, so importing its types back would
 * be a cycle. Structurally identical to `PlatformInput`, so one is accepted
 * wherever the other is.
 */
export type NataliaHomeInput = {
  os?: NodeJS.Platform;
  env?: Record<string, string | undefined>;
};

/**
 * Picks the first usable directory from the candidates. A bare drive letter
 * ("D:") from a misconfigured environment variable is not usable: creating a
 * directory at a drive root fails with EPERM on Windows, which surfaced as a
 * hard startup crash.
 */
export function usableDirectory(
  candidates: Array<string | undefined>,
  fallback: () => string,
): string {
  for (const candidate of candidates) {
    if (candidate && !/^[A-Za-z]:$/u.test(candidate)) return candidate;
  }
  return fallback();
}

function safeHomedir(): string {
  try {
    return homedir();
  } catch {
    return "";
  }
}

/**
 * The path rules of the platform being ASKED about, not of the host running
 * the question. Injection exists so one host can assert both branches — the
 * convention `platformJoin` already states in index.ts — and joining a Linux
 * home with the host's Windows rules produces `\home\demo\...`, which is
 * neither platform's answer.
 */
function pathApi(input: NataliaHomeInput): typeof posix {
  return (input.os ?? process.platform) === "win32" ? win32 : posix;
}

/**
 * The user home, from the one definition: `%USERPROFILE%` first (the Windows
 * answer), then `$HOME` (the POSIX one), then the OS call. `HOME` alone is not
 * enough on Windows, where it is usually unset — a resolver that read only
 * `HOME` threw there (packages/tooling/installer/src/update.ts), reachable from
 * the update path.
 */
export function nataliaUserHome(input: NataliaHomeInput = {}): string {
  const env = input.env ?? process.env;
  return usableDirectory([env.USERPROFILE, env.HOME], safeHomedir);
}

/** The default home: `<user home>/.natalia`. */
export function defaultNataliaHome(input: NataliaHomeInput = {}): string {
  return pathApi(input).join(nataliaUserHome(input), NATALIA_HOME_DIR_NAME);
}

/**
 * Expands the tilde prefixes a configured path may carry.
 *
 * A configured `NATALIA_HOME=~/env-natalia` is a shell spelling, not a literal
 * directory name, and `resolve()` would otherwise turn it into
 * `<cwd>/~/env-natalia`.
 */
export function expandHomePath(path: string, input: NataliaHomeInput = {}): string {
  if (path === "~") return nataliaUserHome(input);
  if (path.startsWith("~/") || path.startsWith("~\\"))
    return pathApi(input).join(nataliaUserHome(input), path.slice(2));
  return path;
}

function trimmed(value: string | undefined): string | undefined {
  const text = value?.trim();
  return text ? text : undefined;
}

/**
 * Resolve the single user-data home.
 *
 * Precedence, highest first: an explicit configured path, `$NATALIA_HOME`,
 * `$NATALIA_STORE_HOME`, then `~/.natalia`. A blank or whitespace-only
 * environment value is treated as UNSET rather than as an empty path —
 * `resolve("")` is the working directory, so accepting it would make an empty
 * override mean "use whatever directory this process was started in", which is
 * the exact failure this module removes.
 */
export function resolveNataliaHome(
  configured?: string,
  input: NataliaHomeInput = {},
): string {
  const env = input.env ?? process.env;
  const selected =
    configured ??
    trimmed(env[NATALIA_HOME_ENV]) ??
    trimmed(env[NATALIA_STORE_HOME_ENV]) ??
    defaultNataliaHome(input);
  const expanded = expandHomePath(selected, input);
  const paths = pathApi(input);
  // `resolve()` normalizes a relative value against the HOST's working
  // directory, which is meaningless for an injected platform; normalize for
  // that case and resolve for the real one.
  return (input.os ?? process.platform) === process.platform
    ? paths.resolve(expanded)
    : paths.normalize(expanded);
}

/** Joins segments onto the resolved home; no segments returns the home. */
export function nataliaHomePath(...segments: string[]): string {
  return join(resolveNataliaHome(), ...segments);
}

/** Joins segments onto the resolved home's `cache` directory. */
export function nataliaCachePath(...segments: string[]): string {
  return join(resolveNataliaHome(), "cache", ...segments);
}

/**
 * Whether a resolved home is the default one, and the label to show for it.
 *
 * Deliberately never returns a machine path: the default reads `~/.natalia`
 * and any configured home reads `$NATALIA_HOME`. A settings row or a doctor
 * line that prints `/home/someone/.natalia` tells the reader nothing they can
 * act on.
 */
export function nataliaHomeDisplay(resolvedHome: string): string {
  return resolvedHome === resolve(defaultNataliaHome())
    ? DEFAULT_NATALIA_HOME_DISPLAY
    : `$${NATALIA_HOME_ENV}`;
}

/**
 * The roots a READ may still find user data in, most recent first, with the
 * live home excluded.
 *
 * Reads only, never writes: an install that already wrote its config, registry
 * or skills to an older root keeps them, and the next write lands on the one
 * home. This replaces the bespoke fallbacks that grew one at a time
 * (`workspace-manager.ts` carried its own `previousWindowsWorkspaceRegistryPath`
 * beside `LEGACY_STATE_DIR_NAMES`), which is how the list ended up able to
 * carry `<config-home>/natalia-cli` but not `%APPDATA%\natalia`.
 *
 * `<config-home>` is `$APPDATA` on Windows and `$HOME/.config` on POSIX, so on
 * POSIX two of the candidates coincide; the result is deduplicated.
 */
export function legacyNataliaRoots(input: NataliaHomeInput = {}): string[] {
  const env = input.env ?? process.env;
  const home = nataliaUserHome(input);
  // Mirrors `globalConfigHome` EXACTLY, including its refusal to read
  // XDG_CONFIG_HOME: a candidate the old code never wrote to is not a legacy
  // location, it is a guess, and a guess in a read-fallback list is how a
  // stale directory gets adopted as live state.
  const configHome =
    (input.os ?? process.platform) === "win32"
      ? usableDirectory([env.APPDATA], () =>
          win32.join(home, "AppData", "Roaming"),
        )
      : posix.join(home, ".config");
  const paths = pathApi(input);
  const candidates = [
    paths.join(configHome, NATALIA_CONFIG_DIR_NAME),
    ...LEGACY_NATALIA_HOME_DIR_NAMES.map((name) =>
      paths.join(configHome, name),
    ),
    paths.join(home, ".config", NATALIA_CONFIG_DIR_NAME),
    ...LEGACY_NATALIA_HOME_DIR_NAMES.map((name) =>
      paths.join(home, ".config", name),
    ),
  ];
  const seen = new Set<string>([paths.resolve(defaultNataliaHome(input))]);
  return candidates.filter((candidate) => {
    const key = paths.resolve(candidate);
    if (seen.has(key)) return false;
    seen.add(key);
    return true;
  });
}
