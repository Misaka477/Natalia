import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { basename, dirname, join, resolve } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";

/**
 * The prefix a test-governance root carries, and the workspace it belongs to.
 *
 * A test wants the governance ledger BESIDE its workspace (it survives a
 * workspace relocation, exactly like production) rather than inside it (the
 * workspace gets removed). The seam for that was a process-global env var —
 * and under `bun test --max-concurrency=N` test FILES share a worker process,
 * so one file's value answered another file's `governanceViews(itsWorkspace)`
 * with the wrong ledger: rules read back from a different workspace, and a
 * revoke for a rule that was never in this workspace's set. Measured on CI as
 * `real-runtime-c` answering `[]` for decisions it had just written, and on the
 * constitution read/revoke guard reading another test's rules.
 *
 * The seam stays, but it is now BOUND to the workspace it was set for: the
 * root's basename carries the workspace's own basename, and a resolver given a
 * workspace accepts the override only when the two correspond. A stale value
 * from another file no longer answers for this one — this workspace falls back
 * to its own path.
 */
const TEST_GOVERNANCE_PREFIX = ".natalia-test-governance-";

/** The governance root a test wants for `workspaceRoot`, beside the workspace. */
export function testGovernanceRootFor(workspaceRoot: string): string {
  const suffix = basename(resolve(workspaceRoot)) || "workspace";
  return join(
    resolve(workspaceRoot),
    "..",
    `${TEST_GOVERNANCE_PREFIX}${suffix}`,
  );
}

/** The env var name the seam reads. */
export const TEST_GOVERNANCE_ROOT_ENV = "NATALIA_TEST_GOVERNANCE_ROOT";

/** True when `root` is the test-governance root belonging to `workspaceRoot`. */
function correspondsToWorkspace(root: string, workspaceRoot: string): boolean {
  const expected = basename(testGovernanceRootFor(workspaceRoot));
  return basename(resolve(root)) === expected;
}

export function resolveGovernanceRoot(workspaceRoot?: string) {
  const override = process.env[TEST_GOVERNANCE_ROOT_ENV];
  if (override) {
    // With no workspace to belong to, the override is the whole answer.
    if (!workspaceRoot) return resolve(override);
    // Bound to its workspace: a value left behind by another test file in the
    // same worker process does not answer for this one.
    if (correspondsToWorkspace(override, workspaceRoot))
      return resolve(override);
  }
  if (!workspaceRoot) return undefined;
  // Workspace-tier governance lives under the workspace it belongs to. The
  // plugin store is process/instance infrastructure and must never be the
  // shared bucket that leaks decisions or rules across workspaces.
  return resolve(workspaceRoot, ".natalia", "governance");
}

function parseJsonl(path: string): RuntimeEvent[] {
  let raw: string;
  try {
    raw = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
  const events: RuntimeEvent[] = [];
  for (const line of raw.split("\n")) {
    if (!line.trim()) continue;
    events.push(JSON.parse(line) as RuntimeEvent);
  }
  return events;
}

export function loadInstanceGovernance(root: string | undefined): {
  events: RuntimeEvent[];
  degraded: boolean;
} {
  if (!root) return { events: [], degraded: false };
  try {
    return {
      events: [
        ...parseJsonl(join(root, "constitution.jsonl")),
        ...parseJsonl(join(root, "decisions.jsonl")),
      ],
      degraded: false,
    };
  } catch {
    return { events: [], degraded: true };
  }
}

export function appendInstanceEvent(
  root: string | undefined,
  file: "constitution.jsonl" | "decisions.jsonl",
  event: RuntimeEvent,
) {
  if (!root) return;
  const path = join(root, file);
  mkdirSync(dirname(path), { recursive: true });
  appendFileSync(path, `${JSON.stringify(event)}\n`);
}
