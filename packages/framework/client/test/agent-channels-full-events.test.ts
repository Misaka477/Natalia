import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The channel audit's pin: EVERY channel that rebuilds a provider request from
 * the session's events must widen to the durable log first.
 *
 * The defect this guards against (issue #3 / report P30) was navi and nia
 * folding `exec.session.events`, which on the fast-attach path is only the
 * post-epoch tail: the model then saw a conversation that started mid-air. The
 * other channels already used `ensureSessionFullEvents`; these two did not, and
 * the whole class is worth one pin rather than four fixed-and-forgotten files.
 *
 * What each channel does today:
 *   main      — builds every step from the live ledger (execute-calls pushes
 *               `assistant(toolCalls)` and `role:"tool_call"` entries with a
 *               `pairID` as it goes), so there is no rebuild to widen;
 *   subagent  — widen, then ask the store's worker for the transcript;
 *   team      — fans out through subagents.spawn, so it inherits subagent's;
 *   navi/nia  — widen, then fold the history (the two this round repaired).
 */

const root = join(import.meta.dir, "..", "..", "..", "..");
function source(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

const WIDENING_CHANNELS = [
  "packages/domains/collab/src/chat.ts",
  "packages/domains/collab/src/mailbox-plans.ts",
  "packages/domains/collab/src/chat-turn-navi.ts",
  "packages/domains/collab/src/chat-turn-nia.ts",
  "packages/framework/client/src/runtime/subagent-runtime.ts",
] as const;

test("every rebuild-from-events channel widens to the durable log", () => {
  for (const file of WIDENING_CHANNELS) {
    const text = source(file);
    // The CALL, not the import: `ensureSessionFullEvents(` followed by
    // arguments. A bare mention in an import or a comment satisfies neither the
    // audit nor the eye, and is exactly how the navi/nia gap read for so long.
    expect(
      text,
      `${file} must call ensureSessionFullEvents before folding the history`,
    ).toMatch(/[ .]ensureSessionFullEvents\(/u);
  }
});

test("the main channel pairs its tool calls live, so there is nothing to rebuild", () => {
  // The main turn's assistant message carries the calls and each call enters
  // the ledger with its `pairID`; both happen as the step runs.
  const exec = source(
    "packages/framework/client/src/runtime/tool-execution/execute-calls.ts",
  );
  expect(exec).toContain("toolCalls: effectiveCalls");
  expect(exec).toContain("pairID: call.id");
});

test("the team channel runs through subagents, so it inherits the widen", () => {
  const fanout = source("packages/plugins/team/src/fan-out.ts");
  expect(fanout).toContain("input.subagents.spawn");
  expect(fanout).toContain("input.subagents.wait");
});

test("a sandboxed child's tool list carries one entry per name", () => {
  // F-A: every sandboxed child died on its first step with
  // "ProviderError: Tool names must be unique". The runner pushes its own
  // `sandbox_diff` (the self-scoped one) beside the host's `sandbox_diff`
  // instead of replacing it, so the provider refused the whole list.
  // `team_fanout` spawns sandboxed children — the whole team path was down —
  // while `agent_spawn` (this path pushes nothing) worked.
  const source = readFileSync(
    join(
      import.meta.dir,
      "..",
      "src",
      "runtime",
      "initialize",
      "subagent-runner.ts",
    ),
    "utf8",
  );
  // The runner's own tools go through the displacement helper.
  expect(source).toContain("withRunnerTools(visibleTools, [");
  // And no bare push of a same-named tool survives next to it.
  expect(source).not.toContain("visibleTools.push(sandboxSelfDiffTool())");
  // The helper filters the host's same-named entries out before appending.
  expect(source).toMatch(
    /visible\.filter\(\(tool\) => !names\.has\(tool\.name\)\)/u,
  );
});
