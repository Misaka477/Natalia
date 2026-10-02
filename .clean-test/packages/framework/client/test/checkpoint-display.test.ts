import { expect, test } from "bun:test";
import { checkpointDisplayLine } from "../src";
import { checkpointProgressView } from "@natalia/ui-model";
import type { RuntimeEvent } from "@anthelia/contracts";

test("checkpoint progress and result events project for TUI and plain output", () => {
  const created: RuntimeEvent = {
    type: "checkpoint.created",
    id: "checkpoint_1",
    reason: "manual",
    sequence: 1,
    complete: true,
    files: 3,
    changes: 2,
    contextJournalOffset: 4,
    step: 2,
    tokenEstimate: 120,
    diskUsageBytes: 2048,
  };
  const preview: RuntimeEvent = {
    type: "rollback.previewed",
    preview: {
      checkpointID: "checkpoint_0",
      dryRun: true,
      changes: [{ kind: "delete", path: "test_example.py" }],
      context: {
        truncateMessages: 3,
        targetJournalOffset: 1,
        targetStep: 0,
        targetTokens: 10,
        compactionGeneration: 0,
      },
      resources: [
        {
          kind: "terminal",
          id: "pty_1",
          action: "stop",
          summary: "running shell",
        },
      ],
      ignoredFiles: 1,
      diskUsageBytes: 2048,
      complete: true,
      warnings: [],
    },
  };

  expect(checkpointDisplayLine(created)).toContain("checkpoint_1");
  expect(checkpointProgressView(created)).toEqual({
    title: "Checkpoint checkpoint_1",
    detail: "3 tracked files, 2 changes, step 2, 120 tokens",
    severity: "info",
  });
  expect(checkpointDisplayLine(preview)).toContain(
    "truncate 3 context messages",
  );
  expect(checkpointProgressView(preview)?.detail).toContain(
    "1 resources affected",
  );
});
