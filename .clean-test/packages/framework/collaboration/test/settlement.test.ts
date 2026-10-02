import { expect, test } from "bun:test";
import type { RuntimeEvent, SettlementNotice } from "@anthelia/contracts";
import {
  buildSettlementNotice,
  deliverSettlement,
  deliverSubagentMessage,
  SETTLEMENT_SOURCE_KINDS,
  settlementNoticeText,
  subagentMessageText,
} from "../src";

/**
 * The settlement spine's pins (the Natalia settlement plan's block 1):
 * the notice is a durable fact FIRST, delivered second, and its failure
 * degrades — the dsh study's three disciplines, each observable here.
 */

const notice: SettlementNotice = {
  subject: "proc:dev-server",
  reason: "exited",
  summary: "dev server exited with code 1",
  detail: "exitCode 1",
  sourceKind: SETTLEMENT_SOURCE_KINDS.processExited,
};

function harness() {
  const published: RuntimeEvent[] = [];
  const woken: Array<{ id: string; text: string }> = [];
  const logs: Array<{ level: string; message: string }> = [];
  const ports = {
    isDisposed: () => false,
    publishForSession(_exec: unknown, event: RuntimeEvent) {
      published.push(event);
    },
    deliverInternalWake(_exec: unknown, id: string, text: string) {
      woken.push({ id, text });
      return "next-step";
    },
    nextSettlementSequence: (() => {
      let n = 0;
      return () => (n += 1);
    })(),
    serviceDirectory: {
      // logOf resolves the operation log through getOptional; the capture
      // stands in for the real one (production falls back to the noop the
      // same way when the log is absent).
      getOptional: () => ({
        info(channel: string, message: string) {
          logs.push({ level: "info", message: `${channel}:${message}` });
        },
        warn(channel: string, message: string) {
          logs.push({ level: "warn", message: `${channel}:${message}` });
        },
      }),
    } as never,
  };
  return { ports, published, woken, logs };
}

const exec = { session: { id: "ses_settle" } } as never;

test("the builder keeps the notice's shape with the detail optional", () => {
  const event = buildSettlementNotice({
    id: "settlement:1",
    at: "2026-09-25T00:00:00.000Z",
    notice,
  });
  expect(event).toMatchObject({
    type: "settlement.notice",
    id: "settlement:1",
    subject: "proc:dev-server",
    reason: "exited",
    summary: "dev server exited with code 1",
    detail: "exitCode 1",
    sourceKind: "process-exited",
    at: "2026-09-25T00:00:00.000Z",
  });
  // A detail-less notice carries no key, not an undefined one.
  const bare = buildSettlementNotice({
    id: "settlement:2",
    at: "2026-09-25T00:00:01.000Z",
    notice: { ...notice, detail: undefined },
  });
  expect("detail" in bare).toBe(false);
});

test("the notice text is an input, not a command", () => {
  const text = settlementNoticeText(notice);
  expect(text).toContain("internal settlement notice");
  expect(text).toContain("proc:dev-server exited");
  expect(text).toContain("dev server exited with code 1");
  expect(text).toContain("exitCode 1");
  // The discipline, verbatim in spirit: read it when you choose, and no
  // acknowledgement is requested (the advisor contract's layer-up rule).
  expect(text).toContain("when you choose");
  expect(text).toContain("not a user message");
  expect(text).toContain("needs no acknowledgement");
});

test("delivery publishes the fact first, then steers the turn", () => {
  const { ports, published, woken } = harness();
  expect(deliverSettlement(ports, exec, notice)).toBe(true);
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    type: "settlement.notice",
    subject: "proc:dev-server",
  });
  expect(woken).toHaveLength(1);
  expect(woken[0]!.text).toBe(settlementNoticeText(notice));
  // The id is derived from the notice, stable per sequence.
  expect(woken[0]!.id).toContain("turn_settle_settlement");
});

test("a failed delivery degrades — the thing that settled must not fail", () => {
  const { ports, logs } = harness();
  ports.publishForSession = () => {
    throw new Error("journal unavailable");
  };
  // A false, not a throw: the caller (a process registry reporting an
  // exit) continues.
  expect(deliverSettlement(ports, exec, notice)).toBe(false);
  expect(logs.some((entry) => entry.level === "warn")).toBe(true);
});

test("a wake-core failure degrades after the fact is durable", () => {
  const { ports, published } = harness();
  ports.deliverInternalWake = () => {
    throw new Error("turn steered away");
  };
  expect(deliverSettlement(ports, exec, notice)).toBe(false);
  // The fact still landed — replay and audit see the notice even when the
  // live delivery could not.
  expect(published).toHaveLength(1);
});

test("a disposed runtime publishes nothing and reports false", () => {
  const { ports, published, woken } = harness();
  ports.isDisposed = () => true;
  expect(deliverSettlement(ports, exec, notice)).toBe(false);
  expect(published).toHaveLength(0);
  expect(woken).toHaveLength(0);
});

test("a child's mid-run message is a fact and a wake, not a settlement", () => {
  const { ports, published, woken } = harness();
  const delivered = deliverSubagentMessage(ports as never, exec, {
    agentId: "a7",
    text: "the API slice is done",
  });
  expect(delivered).toBe(true);
  // The durable fact first: its own event kind, the reason set untouched.
  expect(published).toHaveLength(1);
  expect(published[0]).toMatchObject({
    type: "subagent.message",
    agentId: "a7",
    text: "the API slice is done",
  });
  expect((published[0] as { at?: string }).at).toBeString();
  // The wake: notice-shaped (reading it is the parent's choice), and it
  // says who spoke.
  expect(woken).toHaveLength(1);
  expect(woken[0]!.text).toBe(
    subagentMessageText("a7", "the API slice is done"),
  );
  expect(woken[0]!.text).toContain("internal subagent message");
  expect(woken[0]!.text).toContain("this is not a user message");
});

test("a child's message degrades like any notice's", () => {
  const { ports, published, woken, logs } = harness();
  ports.deliverInternalWake = () => {
    throw new Error("the wake channel is gone");
  };
  expect(
    deliverSubagentMessage(ports as never, exec, {
      agentId: "a7",
      text: "a late finding",
    }),
  ).toBe(false);
  expect(logs.some((entry) => entry.level === "warn")).toBe(true);
  // The fact is still durable — only the delivery degraded.
  expect(published).toHaveLength(1);
  expect(woken).toHaveLength(0);
});
