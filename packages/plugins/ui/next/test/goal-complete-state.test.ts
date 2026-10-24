/**
 * A completed goal SHOWS as complete (audit item 7).
 *
 * The chain the item names, pinned where each link lives: the goal service
 * snapshots a finished goal with phase `"complete"`, the contract carries that
 * phase in the union, and the shell's goal control binds its `data-phase` to
 * whatever phase the goal reports — with a stylesheet rule for
 * `[data-phase="complete"]`, so the done state reads differently from a
 * running one rather than only being a value in a payload.
 *
 * A behavior test would need a goal driven to completion inside a rendered
 * shell; the invariant (every link present, and the complete phase among them)
 * is checkable from the sources in one place, which is what this file does.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const root = join(import.meta.dir, "..", "..", "..", "..", "..");

function source(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

describe("a completed goal is visible as completed", () => {
  test("the goal service produces the complete phase", () => {
    const service = source("packages/domains/goal/src/service.ts");
    expect(service).toContain('snapshotOf(current, "complete")');
    // It is terminal: a completed goal is not resumed by the next round.
    expect(service).toContain('if (current.phase === "complete")');
  });

  test("the contract carries the phase", () => {
    expect(source("packages/core/contracts/src/events.ts")).toContain(
      'export type GoalPhase = "active" | "paused" | "blocked" | "complete";',
    );
  });

  test("the control binds it, twice — main and the secondary surface", () => {
    const transcript = source(
      "packages/plugins/ui/next/src/controllers/transcript.tsx",
    );
    expect(transcript).toContain("data-phase={goal()!.phase}");
    expect(transcript).toContain('goal()!.phase === "complete"');
  });

  test("the complete state has its own style, not the running one", () => {
    expect(
      source("packages/plugins/ui/next/src/styles/transcript.module.css"),
    ).toContain('.control[data-phase="complete"]');
  });
});
