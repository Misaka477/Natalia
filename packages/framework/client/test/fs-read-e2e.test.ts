// Does read_file actually work, end to end, in the real runtime?
//
// The report was "文件读写类工具报 schema 异常" for read_file / write_file /
// edit_file / glob / grep. Nothing in the shipped configuration explained it, and
// this test is the missing measurement: a real turn, in the real runtime, with
// the real plugin loaded, calling read_file the way the schema declares.
//
// Every assertion below is grounded in code that was READ, not guessed:
//   - `submitAndWait` already waits for the turn to settle
//     (session-execution/core.ts:53 waitForTurnSettled), so no separate
//     turn.finished wait — an earlier revision added one and it timed out.
//   - `read_file` with no offset/length returns the file's content verbatim
//     (fs-read-tools.ts:84-85 `return content`).
//   - `tool.update` carries that output in `result` (contracts/events.ts:1032
//     `result?: string`), with `name` and `status` beside it.
//   - the workspace MUST come from `officialPluginWorkspace`, because
//     real-runtime-harness.ts aliases it AS mkdtemp: importing node:fs's
//     mkdtemp instead yields a bare directory with no plugin store, and every
//     tool call then fails with "Unknown tool" (three rounds lost to that).
import { writeFile } from "node:fs/promises";
import { join } from "node:path";
import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { createRealRuntimeClient } from "./real-runtime-harness";
import { officialPluginWorkspace as mkdtemp } from "./plugin-test-helpers";

const READ_TARGET = "probe-read-target.txt";
const READ_BODY = "NATALIA_FS_READ_PROBE_OK";

test("read_file executes in a real turn and returns the file's content", async () => {
  const root = await mkdtemp("fs-read-e2e");
  await writeFile(join(root, READ_TARGET), READ_BODY, "utf8");

  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_fs_read_e2e",
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request) {
        // One step: call read_file with the argument name the schema declares,
        // then close the turn once the tool result is in the transcript.
        if (!request.messages.some((message) => message.role === "tool")) {
          yield {
            type: "tool_call" as const,
            calls: [
              {
                id: "read-1",
                name: "read_file",
                arguments: JSON.stringify({ path: READ_TARGET }),
              },
            ],
          };
          return;
        }
        yield { type: "content" as const, text: "read it" };
        yield { type: "done" as const };
      },
    },
  });
  client.start((event) => events.push(event), { replay: "none" });
  // Already settled when this resolves: submitAndWait waits for the turn.
  await client.submitAndWait!("read the probe file");

  const updates = events.filter(
    (event): event is Extract<RuntimeEvent, { type: "tool.update" }> =>
      event.type === "tool.update",
  );
  const forRead = updates.filter((event) => event.name === "read_file");
  expect(forRead.length).toBeGreaterThan(0);

  const done = forRead.at(-1)!;
  // The tool ran and said so. A failure here is what the report described, so
  // the failure text is part of the message: it names the reason instead of
  // leaving "expected succeeded, got failed".
  expect(
    done.status,
    `read_file ended as ${done.status}: ${done.summary ?? ""}`,
  ).toBe("succeeded");

  // And the content came back, verbatim, in `result` — the field the contract
  // declares for the tool's output, which is what read_file returns.
  // Print the whole event first: three earlier revisions guessed which envelope
  // carries the body and each guess was wrong, so the event is shown rather
  // than guessed at again.
  console.error("READ_FILE_EVENT " + JSON.stringify(done));
  expect(done.result).toContain(READ_BODY);

  await client.dispose?.();
});
