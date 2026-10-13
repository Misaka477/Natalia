/**
 * The sandbox policy's path law: where a write may land.
 *
 * One home for the containment judgement every write path answers to —
 * the mode's writable roots (the confinement package's `writableRoots`,
 * the same set the kernel-level wrapper grants) and an ownership domain
 * (the fan-out sub-agent's writePaths) are the same QUESTION at two
 * heights, so they share one spelling.
 *
 * The judgement is canonicalize-then-contain, the sandbox study's rule in our
 * own words: a path is REALPATHED before it is compared, because a lexical
 * `allowed/../../../etc/x` waves through every prefix match and the kernel
 * then resolves it outside the root. The re-normalisation resolves the
 * deepest EXISTING ancestor, so a path whose tail does not exist yet — the
 * file the write is about to create — still gets a truthful answer about
 * its directory. A path that resolves outside the root is answered with
 * the path itself, which can never match a relative domain: "not inside"
 * is the only truthful reading.
 */

import { canonicalPath, writableRoots } from "@anthelia/confinement";
import type { ConfinementMode } from "@anthelia/confinement";
import {
  CONFINEMENT_COMPOSITION_ROW_ID,
  CONFINEMENT_MODES,
} from "@anthelia/contracts";
import type { CompositionProfile } from "@anthelia/composition";
import {
  dirname,
  isAbsolute,
  join,
  parse,
  relative,
  resolve,
  sep,
} from "node:path";

/**
 * Where a path ACTUALLY lands, resolved the way the kernel resolves it:
 * component by component, following a symlink when the component exists,
 * popping on `..` against what has been resolved so far.
 *
 * This exists because `canonicalPath` (a whole-path realpath) returns the
 * path AS SPELLED when the tail does not exist — and a write's tail is
 * exactly the file that does not exist yet. A prefix judgement over the
 * as-spelled path waves through both escapes: `allowed/../../../etc/x`
 * still spells its way inside the root, and `allowed/link/new.txt` (link
 * pointing outside) spells its way inside the domain while the kernel
 * would create the file outside. Resolving component by component is the
 * only spelling that answers "where does this write land".
 */
export function landedPath(path: string): string {
  const abs = resolve(path);
  // Start from the absolute path's own root — "/" on POSIX, "C:\" (or a
  // UNC share) on Windows. Seeding the walk with the bare separator
  // instead made Windows land every path at "\C:\...": the leading
  // separator never matches the canonical root, so every in-process
  // write read as an escape and was refused. The containment tests that
  // only assert refusals kept passing — a fail-closed bug hides behind
  // the escapes it refuses.
  const { root } = parse(abs);
  let current = root;
  for (const segment of abs.slice(root.length).split(sep)) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") {
      current = dirname(current);
      continue;
    }
    const next = join(current, segment);
    const canonical = canonicalPath(next);
    // A symlink that exists is followed (the kernel's lookup); a component
    // that does not exist yet stays as spelled — the write will create it.
    current = canonical === next ? next : canonical;
  }
  return current;
}

/**
 * The path's position relative to a root — "" for the root itself, the
 * relative spelling inside it, or the PATH UNCHANGED when it resolves
 * outside. The unchanged-path answer is the load-bearing half: an
 * absolute path can never accidentally match a relative domain, so
 * "outside" is the only reading a caller can make of it.
 */
export function relativeToRoot(path: string, root: string): string {
  const rel = relative(resolve(root), resolve(path));
  if (rel === ".." || rel.startsWith(`..${sep}`) || isAbsolute(rel))
    return path;
  return rel;
}

/**
 * Whether `path` — judged on where it ACTUALLY lands — sits inside one of
 * the domains (each relative to `root`, a file or a directory prefix).
 */
export function pathWithinDomains(input: {
  path: string;
  root: string;
  domains: readonly string[];
}): boolean {
  // The domain vocabulary spells "/" on every platform (a sub-agent's
  // writePaths, a constitution rule's appliesTo), while `relative` speaks
  // the host's separator. Normalizing here is the same convention the
  // constitution path match keeps — without it every domain comparison
  // failed on Windows and each sub-agent's domain read as empty.
  const relative = relativeToRoot(
    landedPath(input.path),
    canonicalPath(input.root),
  ).replaceAll(sep, "/");
  return input.domains.some(
    (domain) =>
      relative === domain ||
      relative.startsWith(domain.endsWith("/") ? domain : `${domain}/`),
  );
}

/**
 * The policy home (洞 2's item 1): one place owns the mode and the root,
 * and ONE resolution entry every write path asks — the shell tool's spawn,
 * the fs tools' judgement, the terminal pane's spawn, the sandbox
 * controller's candidate commands. bash and fs asking the same resolve is
 * what makes "bash circles one root, fs circles another" a state that
 * cannot exist rather than one that must not.
 *
 * The precedence is the reference's, spelled out: an explicit mode (an
 * escalation's per-call grant) beats the session's override (the human
 * switching rungs mid-session), which beats the deployment default (the
 * composition row, then the legacy config key, then the schema default —
 * each gated to what the host can ENFORCE, because the mode a deployment
 * requests and the mode a kernel provides are different questions). The
 * root follows the same shape: the session's own cwd (a sub-agent's
 * worktree) beats the configured workspace root.
 */
export type SandboxPolicy = {
  mode: ConfinementMode;
  workspaceRoot: string;
};

/** What the mode resolution reads (the root is not its question). */
export type SandboxModeSources = {
  profile?: CompositionProfile | undefined;
  /** The legacy config key — the row's fallback, retired by a drop-in. */
  configMode?: string | undefined;
  os?: NodeJS.Platform | undefined;
};

export type SandboxPolicySources = SandboxModeSources & {
  /** The session's own root (a sub-agent's worktree). Beats the configured. */
  sessionRoot?: string | undefined;
  /** The configured workspace root — the fallback when no session root. */
  deploymentRoot: string;
};

export type SandboxPolicyInput = SandboxPolicySources & {
  /** An explicit mode for this call: the escalation's per-call grant. */
  explicitMode?: ConfinementMode | undefined;
  /** The session's rung override, when the human switched mid-session. */
  sessionMode?: ConfinementMode | undefined;
};

const legalMode = (mode: string | undefined): mode is ConfinementMode =>
  typeof mode === "string" &&
  (CONFINEMENT_MODES as readonly string[]).includes(mode);

/**
 * The deployment default: the composition profile's sandbox row, then the
 * legacy config key, then the schema default — and then the platform gate,
 * which is why this is a function and not a lookup (the mode a host
 * REQUESTS and the mode it can ENFORCE are different questions, and only
 * the enforceability one may reach an execution).
 */
export function resolveDeploymentMode(
  sources: SandboxModeSources,
): ConfinementMode {
  const row = sources.profile?.rows.find(
    (candidate) =>
      candidate.id === CONFINEMENT_COMPOSITION_ROW_ID && !candidate.disabled,
  );
  const rowMode =
    typeof row?.config?.mode === "string" ? row.config.mode : undefined;
  const requested = legalMode(rowMode)
    ? rowMode
    : legalMode(sources.configMode)
      ? sources.configMode
      : "workspace-write";
  return enforceableConfinementMode(requested, sources.os);
}

/** The full per-call policy: explicit > session override > deployment. */
export function resolveSandboxPolicy(input: SandboxPolicyInput): SandboxPolicy {
  const mode =
    input.explicitMode ?? input.sessionMode ?? resolveDeploymentMode(input);
  return {
    mode: enforceableConfinementMode(mode, input.os),
    workspaceRoot: input.sessionRoot ?? input.deploymentRoot,
  };
}

/**
 * The roots a policy may write — the confinement package's own home, so
 * the in-process fence and the kernel-level wrapper grant the same set
 * ("fs cannot write /tmp but bash can" is not a state that exists).
 */
export function sandboxWritableRoots(policy: SandboxPolicy): string[] {
  return writableRoots(policy.mode, policy.workspaceRoot);
}

/**
 * Whether a path — judged on where it ACTUALLY lands — sits inside one
 * root. The single-root spelling of the same question `isWritableUnderPolicy`
 * asks of the mode's set: the main agent's in-process writes have no kernel
 * fence, so their containment is this judgement, and a write path that
 * spells its way out (a symlink inside the workspace, a traversal) is
 * refused here rather than waved through by a lexical prefix match.
 */
export function isInsideRoot(path: string, root: string): boolean {
  const landed = landedPath(path);
  const canonicalRoot = canonicalPath(root);
  return (
    landed === canonicalRoot ||
    landed.startsWith(
      canonicalRoot.endsWith(sep) ? canonicalRoot : `${canonicalRoot}${sep}`,
    )
  );
}

/**
 * The containment judgement for a policy: the path, judged on where it
 * ACTUALLY lands, inside one of the mode's writable roots.
 */
export function isWritableUnderPolicy(
  policy: SandboxPolicy,
  path: string,
): boolean {
  const landed = landedPath(path);
  return sandboxWritableRoots(policy).some(
    (root) =>
      landed === root ||
      landed.startsWith(root.endsWith(sep) ? root : `${root}${sep}`),
  );
}

import { enforceableConfinementMode } from "@anthelia/confinement";
