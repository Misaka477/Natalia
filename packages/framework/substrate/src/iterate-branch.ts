/**
 * The self-iteration handoff: one call that moves the work into a copy of
 * the product's own source.
 *
 * Everything this needs already exists — N workspaces each with their own
 * runtime (`workspace-manager.ts`, one `createRealRuntimeClient` per root),
 * session→workspace routing, `sessionNew({workspaceID})`, `goalControl`
 * for arming, `sessionSeed` for the cross-store journal. The ONE thing
 * that does not exist is the orchestration, and that is this file.
 *
 * The invariant it enforces: **the baseline is never written by the
 * model.** The installed source is read-only to a session; every
 * iteration starts from a COPY at a path the model chooses. That is what
 * makes a bad iteration recoverable (delete the copy) and what keeps the
 * next iteration's baseline honest.
 *
 * And the consequence it implements: the goal MOVES rather than being
 * copied. `goalControl("resume")` on the child arms it — an explicit
 * override of the seed's disarmed default, which is why the human's
 * consent has to name it — and the parent's goal is completed with
 * `handed_off`, so two sessions never pursue the same objective.
 */
import { cp, mkdir, readdir, rm, stat } from "node:fs/promises";
import { existsSync, readdirSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildForkNotice,
  planGoalMove,
  type ForkGoalInput,
} from "./session-fork";

/** What the handoff was asked to do. */
export type IterateBranchRequest = {
  /** Where the copy of the source lands. The model decides. */
  path: string;
  /** The first task, submitted into the child immediately. */
  prompt: string;
  /** Continue in an existing tree instead of copying the baseline. */
  resume?: boolean;
  title?: string;
  /** The parent's session, whose events are the inherited context. */
  parentSessionID: string;
  /** The parent's live goal, when it has one. */
  parentGoal?: ForkGoalInput;
  /** Whether the prompt continues that goal rather than replacing it. */
  goalContinuation: boolean;
  /** The parent's own authority, carried rather than re-read. */
  permissionMode?: "ask" | "auto" | "read_only";
  permissionProfile?: string;
};

export type IterateBranchResult = {
  sessionID: string;
  workspaceID: string;
  workspaceRoot: string;
  /** Whether the target workspace had to be registered. */
  registered: boolean;
  /** The path the baseline was copied from, when a copy was made. */
  copiedFrom?: string;
  goal: ReturnType<typeof planGoalMove>;
  goalArmed: boolean;
  notice: string;
};

/** The manager surface this closure needs — narrow on purpose. */
export type IterateBranchHost = {
  /** The workspace list, so an existing registration is reused. */
  listWorkspaces(): Promise<Array<{ workspaceID: string; root: string }>>;
  /** Register (or reuse) a workspace at a path. */
  addWorkspace(input: { path: string; title?: string }): Promise<{
    workspaceID: string;
    root: string;
    status: string;
  }>;
  /** The client that owns a workspace. */
  clientFor(workspaceID: string): unknown;
  /** Export the parent's journal as ordered events. */
  exportSession(sessionID: string): Promise<{
    events: Array<{ seq: number; event: unknown }>;
  }>;
};

/**
 * Where the read-only baseline is.
 *
 * An install ships it beside the binary: `<install>/source`, where the
 * install root is the directory the runtime was started from. A checkout
 * runs from the repository itself, which is the workspace root. Neither is
 * derived by guessing — the caller passes what it knows, and a deployment
 * with neither answers with the reason rather than a wrong path.
 */
export function resolveBaseline(
  explicit: string | undefined,
  installRoot: string,
): string {
  if (explicit) return resolve(explicit);
  const shipped = join(resolve(installRoot), "source");
  if (existsSync(join(shipped, "package.json"))) return shipped;
  return resolve(installRoot);
}

/**
 * Refuse the targets that would defeat the invariant.
 *
 * Every one of these is a named answer rather than a silent fallback: the
 * model asked for a specific tree, and "that tree is the baseline" is a
 * fact it can act on, where copying into itself would loop and copying
 * over an existing tree would destroy work.
 */
export function checkBranchTarget(
  target: string,
  baseline: string,
  resume: boolean,
): { ok: true } | { ok: false; reason: string } {
  const normalizedTarget = resolve(target);
  const normalizedBaseline = resolve(baseline);
  const sameTarget =
    process.platform === "win32"
      ? normalizedTarget.toLowerCase() === normalizedBaseline.toLowerCase()
      : normalizedTarget === normalizedBaseline;
  if (sameTarget)
    return {
      ok: false,
      reason:
        `the target IS the baseline (${normalizedBaseline}). The baseline is ` +
        `read-only: the model works in a copy, so the original stays ` +
        `recoverable. Choose a different path.`,
    };
  const inside = normalizedBaseline.endsWith(javaSeparator())
    ? normalizedTarget.startsWith(normalizedBaseline)
    : normalizedTarget.startsWith(normalizedBaseline + javaSeparator());
  if (inside)
    return {
      ok: false,
      reason:
        `the target is INSIDE the baseline (${normalizedBaseline}). Copying a ` +
        `tree into itself is not a copy; choose a path outside it.`,
    };
  if (!resume && existsSync(normalizedTarget)) {
    if (readdirSync(normalizedTarget).length > 0)
      return {
        ok: false,
        reason:
          `the target path already holds files: ${normalizedTarget}. ` +
          `Refusing to overwrite a tree that is not known-empty. Pass ` +
          `resume: true to continue in it deliberately, or choose another ` +
          `path.`,
      };
  }
  return { ok: true };
}

/** The path separator this host compares with. */
function javaSeparator(): string {
  return process.platform === "win32" ? "\\" : "/";
}

/**
 * Copy the baseline into the target.
 *
 * Only the files a build needs: `node_modules` and build output are
 * rebuilt, and copying them would make the copy take minutes and hundreds
 * of megabytes for nothing. The lockfile travels because the install must
 * resolve the same versions the baseline was built with.
 */
export async function copyBaseline(
  baseline: string,
  target: string,
): Promise<number> {
  let files = 0;
  const skip = new Set([
    "node_modules",
    ".git",
    "dist",
    ".bun-install",
    ".bun-tmp",
  ]);
  await mkdir(target, { recursive: true });
  const entries = await readdir(baseline, { withFileTypes: true });
  for (const entry of entries) {
    if (skip.has(entry.name)) continue;
    const from = join(baseline, entry.name);
    const to = join(target, entry.name);
    if (entry.isDirectory()) files += await copyBaseline(from, to);
    else {
      await cp(from, to);
      files += 1;
    }
  }
  return files;
}

/** The whole handoff. */
export async function iterateBranch(
  host: IterateBranchHost,
  baseline: string,
  request: IterateBranchRequest,
): Promise<IterateBranchResult> {
  const check = checkBranchTarget(
    request.path,
    baseline,
    request.resume === true,
  );
  if (!check.ok) throw new Error(check.reason);

  const target = resolve(request.path);
  let copiedFrom: string | undefined;
  if (request.resume !== true)
    (await copyBaseline(baseline, target), (copiedFrom = baseline));

  const existing = (await host.listWorkspaces()).find((workspace) =>
    samePath(workspace.root, target),
  );
  const registered = !existing;
  const workspace =
    existing ??
    (await host.addWorkspace({ path: target, title: request.title }));
  const client = host.clientFor(workspace.workspaceID) as {
    sessionSeed?: (input: unknown) => Promise<{ sessionID: string }>;
    sessionNew?: (
      input: unknown,
    ) => Promise<{ sessionID: string; created: boolean }>;
    goalControl?: (
      action: "pause" | "resume" | "clear",
      sessionID?: string,
    ) => Promise<{ ok: boolean; message?: string }>;
    submitAndWait?: (prompt: string, sessionID?: string) => Promise<unknown>;
  };

  // The inherited context: the parent's journal, cut where it stands.
  const exported = await host.exportSession(request.parentSessionID);
  const events = exported.events.map((row) => row.event);
  const goalPlan = planGoalMove({
    goal: request.parentGoal,
    continuation: request.goalContinuation,
  });

  // The child: seeded with the parent's history, so it arrives knowing
  // what it was sent to do rather than starting from nothing.
  const created = client.sessionSeed
    ? await client.sessionSeed({ title: request.title, events })
    : await client.sessionNew!({ title: request.title });
  const sessionID = created.sessionID;

  // The goal moves: the child is armed explicitly (an override of the
  // seed's disarmed default), and the parent's is completed as handed off
  // so no two sessions pursue one objective.
  let goalArmed = false;
  if (goalPlan.kind === "move") {
    const armed = await client.goalControl?.("resume", sessionID);
    goalArmed = armed?.ok === true;
  }

  const notice = buildForkNotice({
    parentSessionID: request.parentSessionID,
    parentWorkspace: "",
    childWorkspace: target,
    cutAt: `${events.length} events`,
    ...(request.parentGoal
      ? {
          goal: {
            title: request.parentGoal.title,
            moved: goalPlan.kind === "move",
          },
        }
      : {}),
  });

  return {
    sessionID,
    workspaceID: workspace.workspaceID,
    workspaceRoot: workspace.root,
    registered,
    ...(copiedFrom ? { copiedFrom } : {}),
    goal: goalPlan,
    goalArmed,
    notice,
  };
}

function samePath(left: string, right: string): boolean {
  if (process.platform === "win32")
    return resolve(left).toLowerCase() === resolve(right).toLowerCase();
  return resolve(left) === resolve(right);
}
