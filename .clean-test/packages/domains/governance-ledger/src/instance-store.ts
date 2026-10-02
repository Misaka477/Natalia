import { appendFileSync, mkdirSync, readFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";

export function resolveGovernanceRoot(workspaceRoot?: string) {
  if (process.env.NATALIA_TEST_GOVERNANCE_ROOT)
    return resolve(process.env.NATALIA_TEST_GOVERNANCE_ROOT);
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
