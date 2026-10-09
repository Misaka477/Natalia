import { expect, test } from "bun:test";
import type { RuntimeMessagePage, SessionID } from "@anthelia/contracts";
import { createSessionHistoryTool } from "../src/runtime/session-history-tool";
import type { RuntimeContext } from "@anthelia/substrate";
import type { SessionRecord } from "@anthelia/session";
import { sessionStoreController } from "@anthelia/session-store";
import { createTestContext } from "@anthelia/runtime-services";
import type { SessionStoreController } from "@anthelia/session-store";

const PAGE: RuntimeMessagePage = {
  data: [],
  cursor: { previous: "older", next: "newer" },
};

function harness() {
  const captured: Array<{
    id: SessionID;
    options: { limit?: number; order?: "asc" | "desc"; cursor?: string };
  }> = [];
  const session = { id: "ses_history" } as unknown as SessionRecord;
  const ctx = {
    state: {
      serviceDirectory: createTestContext([
        sessionStoreController.mock({
          messages: (
            id: SessionID,
            _fallback: SessionRecord,
            options: {
              limit?: number;
              order?: "asc" | "desc";
              cursor?: string;
            },
          ) => {
            captured.push({ id, options });
            return Promise.resolve(PAGE);
          },
        } as unknown as SessionStoreController),
      ]),
    },
    ports: {
      getReady: () => Promise.resolve(),
      getSessionID: () => "ses_history",
      getExecutionBySession: () =>
        new Map([["ses_history" as SessionID, { session }]]),
      getSession: () => session,
      resolveService: () => ({
        messages: (
          id: SessionID,
          _fallback: SessionRecord,
          options: { limit?: number; order?: "asc" | "desc"; cursor?: string },
        ) => {
          captured.push({ id, options });
          return Promise.resolve(PAGE);
        },
      }),
    },
  } as unknown as RuntimeContext;
  return { tool: createSessionHistoryTool(ctx), captured };
}

test("session_history passes the cursor back and clamps the limit", async () => {
  const { tool, captured } = harness();
  const result = await tool.execute(
    { cursor: "page-2", limit: 999, order: "desc" },
    { workspaceRoot: "/w", sessionID: "ses_history" },
  );
  expect(captured).toHaveLength(1);
  expect(captured[0]!.id).toBe("ses_history");
  expect(captured[0]!.options).toEqual({
    limit: 200,
    cursor: "page-2",
    order: "desc",
  });
  expect(JSON.parse(result)).toEqual(PAGE);
});

test("session_history defaults to a bounded page when no args are given", async () => {
  const { tool, captured } = harness();
  const result = await tool.execute(
    {},
    { workspaceRoot: "/w", sessionID: "ses_history" },
  );
  expect(captured[0]!.options).toEqual({ limit: 40 });
  expect(JSON.parse(result).cursor).toEqual({
    previous: "older",
    next: "newer",
  });
});

test("the history page drops thinking rows, so private reasoning never answers (F4)", async () => {
  // The 2026-10-10 sweep's F4: `limit=5` returned reasoning text inside the
  // page — a tool answer is injected into context and logged, so private
  // reasoning both floods the context and breaks the no-private-reasoning
  // rule. The page is a record of what was SAID.
  const thinkingText = "PRIVATE-REASONING-MUST-NOT-ANSWER";
  const session = { id: "ses_history" } as unknown as SessionRecord;
  const page = {
    data: [
      {
        id: "turn_1",
        turnID: "turn_1",
        submitted: { id: "turn_1", text: "hello", at: "" },
        rows: [
          { id: "turn_1:user", turnID: "turn_1", kind: "user", event: {} },
          {
            id: "turn_1:thinking",
            turnID: "turn_1",
            kind: "thinking",
            event: { type: "thinking.done", id: "turn_1", text: thinkingText },
          },
          {
            id: "turn_1:assistant",
            turnID: "turn_1",
            kind: "assistant",
            event: { type: "content.done", id: "turn_1", text: "hi" },
          },
        ],
      },
    ],
    cursor: {},
  };
  const ctx = {
    ports: {
      getReady: () => Promise.resolve(),
      getSessionID: () => "ses_history",
      getExecutionBySession: () =>
        new Map([["ses_history" as SessionID, { session }]]),
      getSession: () => session,
      resolveService: () => ({
        messages: () => Promise.resolve(page),
      }),
    },
    state: {
      serviceDirectory: {
        getOptional: () => ({
          messages: () => Promise.resolve(page),
        }),
      },
    },
  } as unknown as RuntimeContext;
  const tool = createSessionHistoryTool(ctx);
  const answer = String(
    await tool.execute({ limit: 5 }, { workspaceRoot: "/tmp" } as never),
  );
  // The reasoning text is not in the answer at all.
  expect(answer).not.toContain(thinkingText);
  expect(answer).not.toContain("thinking");
  // What was said still is.
  expect(answer).toContain("hello");
  expect(answer).toContain("hi");
});
