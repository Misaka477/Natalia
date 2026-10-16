/**
 * A failed tool call's record, read back from the operations log
 * (audit 缺口 3/4).
 *
 * The record is not "something was logged" — it carries the whole subject:
 * which tool, which call, WHICH TURN (the correlation spine), and, when the
 * failure is a refusal, the rule that said no and the path it judged as
 * separate fields. The confinement spawn's fail-closed refusal is the case
 * that made the fields matter: its rule names the MODE (`confinement mode ro
 * requires a backend`), so a reader branches instead of parsing prose.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SandboxRefusal } from "@anthelia/contracts";
import { createToolRegistry, type RuntimeTool } from "@anthelia/tools";
import type { SessionID } from "@anthelia/contracts";
import { createRealRuntimeClient } from "../src";
import type { StreamingProvider } from "@anthelia/runtime";

function toolCallProvider(name: string): StreamingProvider {
  let sent = false;
  return {
    provider: "test",
    model: "test",
    async *stream() {
      if (sent) {
        yield { type: "done" } as never;
        return;
      }
      sent = true;
      yield {
        type: "tool_call",
        calls: [
          {
            id: "call_refused",
            name,
            arguments: JSON.stringify({ path: "/tmp/whatever" }),
          },
        ],
      } as never;
    },
  };
}

test("a refusal's failed call lands in the log with its rule and path", async () => {
  const workspaceRoot = await mkdtemp(join(tmpdir(), "tool-failure-record-"));
  const refusing: RuntimeTool = {
    name: "refusing_tool",
    description: "Always refuses, structurally.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: { path: { type: "string" } },
      required: ["path"],
      additionalProperties: false,
    },
    async execute() {
      throw new SandboxRefusal({
        rule: "confinement mode ro requires a backend",
        path: workspaceRoot,
        reason: "terminal start refused",
      });
    },
  };
  const client = createRealRuntimeClient({
    workspaceRoot,
    sessionID: "ses_tool_failure" as SessionID,
    provider: toolCallProvider("refusing_tool"),
    tools: createToolRegistry([refusing]),
  });
  client.start(() => {});
  try {
    await client.submitAndWait!("go");
    const records =
      (await client.operationRecords?.({
        component: "tool",
        level: "error",
      })) ?? [];
    expect(records.length).toBeGreaterThan(0);
    const record = records.find(
      (entry) =>
        (entry.fields as Record<string, unknown>).tool === "refusing_tool",
    );
    expect(record).toBeDefined();
    const fields = record!.fields as Record<string, unknown>;
    // The subject: the tool, the call, the turn.
    expect(fields.callID).toBe("call_refused");
    expect(typeof fields.turnID).toBe("string");
    expect(String(fields.turnID).length).toBeGreaterThan(0);
    // The refusal's own structure — not parsed back out of the prose.
    expect(fields.rule).toBe("confinement mode ro requires a backend");
    expect(fields.path).toBe(workspaceRoot);
    expect(String(fields.error)).toContain("terminal start refused");
  } finally {
    await client.dispose?.();
    await rm(workspaceRoot, { recursive: true, force: true });
  }
}, 30_000);
