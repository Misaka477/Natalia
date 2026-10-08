export * from "./escalation";
import { spawnSync } from "node:child_process";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { realpathSync } from "node:fs";
import { resolve } from "node:path";

/**
 * Linux confinement (sandbox study §6, decision 25, phase 1: landlock +
 * rlimit family) — the exec primitive's front wrapper, consumed through the
 * `confinement-exec` native binary in `../native`.
 *
 * The vocabulary and the enforcement dialect follow the reference sandbox:
 * the three-mode file axis,
 * the always-writable `/dev/null`, and the fail-closed rule that a missing
 * or unusable backend never degrades into running unconstrained. Two
 * deliberate differences, both recorded in the study: this wrapper adds the
 * rlimit family the reference lacks (the resource-exhaustion face), and macOS/Windows
 * rungs are not here yet — on a platform without a backend, only
 * `danger-full-access` remains usable (the study's honest Windows
 * degradation).
 */

import type { ConfinementMode } from "@anthelia/contracts";

// The mode vocabulary has one home (the config schema in contracts); this
// package re-exports it so callers take both the policy words and the
// enforcement primitive from one import.
export type { ConfinementMode };
export { CONFINEMENT_MODES } from "@anthelia/contracts";

/** Resource ceilings the wrapper applies before exec (the study's family). */
export type ConfinementRlimits = {
  as?: number;
  cpu?: number;
  fsize?: number;
  nproc?: number;
  nofile?: number;
};

export type ConfinementProbe = {
  /** The kernel's landlock ABI; 0 means the kernel has no landlock. */
  landlockABI: number;
  /** The rlimit names this backend can enforce. */
  rlimits: string[];
  /** True when a confined `true` actually ran — the functional probe. */
  functional: boolean;
};

/** One confined command as the caller spawns it. */
export type ConfinedCommand = { command: string; args: string[] };

function candidatePaths(): string[] {
  const dir = import.meta.dir;
  const base = "native/target/release/confinement-exec";
  return [
    resolve(dir, "..", base),
    resolve(process.cwd(), "packages", "hosts", "confinement", base),
  ];
}

/** The built wrapper binary, or `undefined` when the backend is absent. */
export function confinementBinary(): string | undefined {
  for (const path of candidatePaths()) if (existsSync(path)) return path;
  return undefined;
}

/**
 * Whether this host has a confinement rung at all.
 *
 * The backend is landlock, which is a Linux syscall family: `native/src/main.rs`
 * applies its rules with LANDLOCK_CREATE_RULESET/LANDLOCK_ADD_RULE and has no
 * second implementation, so a rung exists on Linux and exists nowhere else.
 * That is what this file's header calls "macOS/Windows rungs are not here yet".
 *
 * A PLATFORM predicate, deliberately NOT `confinementAvailable()`: the probe
 * answers "is the binary here", which is a different question with a different
 * answer. A Linux host whose binary is missing is a BROKEN INSTALL and must keep
 * failing closed; a host whose rung was never built is the documented
 * degradation and must not. Only a platform check can tell those two apart, and
 * only one of them is a security event.
 */
export function confinementSupported(
  os: NodeJS.Platform = process.platform,
): boolean {
  return os === "linux";
}

/**
 * The mode this host can actually enforce — the input to every `mode` decision.
 *
 * `read-only` and `workspace-write` mean something only where the rung exists.
 * Everywhere else they degrade to `danger-full-access`, which is the study's
 * "honest Windows degradation" spelled out in this file's header and in the
 * wrapper's own docs ("the Windows-degradation story keeps danger working when
 * no backend exists"). WHAT THIS IS NOT: a silent waiver. The degradation is
 * asked for once, here, at the one place that resolves the effective mode, so
 * every reader of that mode — the execution that applies it, the snapshot's
 * danger indicator, the per-turn environment block that tells the agent where
 * it is — reads the degraded answer instead of a `workspace-write` that never
 * held on this machine. A caller that kept its own copy of the resolution order
 * would be back to two truths.
 *
 * Why the gate is here rather than in the caller's fail-closed branch: that
 * arrangement SHIPPED, and it is the bug this closes. The composition base
 * profile ships `anthelia.sandbox: workspace-write` for every platform, the
 * seam fail-closed on a host with no backend, and the shell tool then threw
 * "the command could not be started" for EVERY command — measured, not
 * theorised: a `bun build --compile`d copy of the shell tool (the exact shape
 * `build-standalone.ts` produces) resolves `confinementBinary()` against Bun's
 * embedded filesystem, where no on-disk binary can live, and fails every
 * confined run on every platform. On Windows there is nothing to find even from
 * a source checkout, because the rung does not exist there.
 */
export function enforceableConfinementMode(
  mode: ConfinementMode,
  os: NodeJS.Platform = process.platform,
): ConfinementMode {
  if (mode === "danger-full-access") return mode;
  return confinementSupported(os) ? mode : "danger-full-access";
}

/**
 * Resolve a granted root to the path the kernel actually compares
 * (the `roots.ts` lesson): the native realpath follows the
 * component-by-component lookup a spawn performs, where the JS
 * implementation lexically collapses `..` before resolving a preceding
 * symlink — an as-spelled grant can match nothing. A missing root stays as
 * spelled: conservative, because inventing a fallback would grant a path the
 * caller never named.
 */
export function canonicalPath(path: string): string {
  try {
    return realpathSync.native(path);
  } catch {
    return path;
  }
}

/**
 * The one home for "where may this mode WRITE" — the landlock dialect's
 * spelling (the reference keeps one meaning and per-runner grants: their landlock
 * profile grants `/dev/null` unconditionally, adds `/tmp` and the workspace
 * under `workspace-write`). Deduplicated and canonical, so identical
 * content produces identical rule sets.
 */
export function writableRoots(
  mode: ConfinementMode,
  workspaceRoot?: string,
): string[] {
  if (mode !== "workspace-write") return ["/dev/null"];
  const roots = ["/dev/null", "/tmp", tmpdir()];
  if (workspaceRoot) roots.push(workspaceRoot);
  return [...new Set(roots.map(canonicalPath))];
}

/**
 * Wrap a command in the confinement binary.
 *
 * Returns `undefined` when the mode needs a backend and no usable one exists
 * — fail-closed: the caller must refuse rather than run the command raw
 * (the reference: "Missing or unusable confinement fails closed rather than returning
 * the original argv"). `danger-full-access` needs no backend by definition,
 * so it returns the raw command: the degradation path that keeps working on
 * platforms whose rungs are not built yet.
 */
export function wrapConfinedCommand(input: {
  mode: ConfinementMode;
  workspaceRoot?: string;
  rlimits?: ConfinementRlimits;
  command: string;
  args: string[];
  binaryPath?: string;
}): ConfinedCommand | undefined {
  const { mode, workspaceRoot, rlimits, command, args } = input;
  if (mode === "danger-full-access") return { command, args };
  // Fail-closed on ANY absent backend, including an explicitly named one:
  // wrapping a command in a nonexistent binary would swap a confinement
  // refusal for an exec error, which reads like a different failure.
  const binary = input.binaryPath ?? confinementBinary();
  if (!binary || !existsSync(binary)) return undefined;
  // argv carries only the flags: the binary is the `command`, and a second
  // copy here would arrive as a bogus first argument (usage refusal).
  const wrapped: string[] = [];
  for (const root of writableRoots(mode, workspaceRoot))
    wrapped.push("--read-write", root);
  for (const [name, value] of Object.entries(rlimits ?? {})) {
    if (value !== undefined) wrapped.push("--rlimit", `${name}=${value}`);
  }
  wrapped.push("--", command, ...args);
  return { command: binary, args: wrapped };
}

/**
 * Probe the backend: capability facts from `--probe`, plus the functional
 * half the reference's runner chain performs — a trivial command actually running
 * through confinement. `undefined` means no binary exists at all (the
 * fail-closed signal for the ro/rw modes).
 */
export function probeConfinement(
  binaryPath?: string,
): ConfinementProbe | undefined {
  const binary = binaryPath ?? confinementBinary();
  if (!binary) return undefined;
  const info = spawnSync(binary, ["--probe"], { encoding: "utf8" });
  if (info.status !== 0) return undefined;
  let facts: { landlockABI: number; rlimits: string[] };
  try {
    facts = JSON.parse(info.stdout) as {
      landlockABI: number;
      rlimits: string[];
    };
  } catch {
    return undefined;
  }
  const functional =
    facts.landlockABI >= 1 &&
    spawnSync(binary, ["--read-write", tmpdir(), "--", "true"], {
      encoding: "utf8",
    }).status === 0;
  return { ...facts, functional };
}

/** Whether the ro/rw modes can actually be enforced right now. */
export function confinementAvailable(binaryPath?: string): boolean {
  return probeConfinement(binaryPath)?.functional === true;
}
