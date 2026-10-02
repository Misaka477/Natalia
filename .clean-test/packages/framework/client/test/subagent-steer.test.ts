import { expect, test } from "bun:test";
import {
  parentMessageContent,
  steerRoute,
} from "../src/runtime/initialize/subagent-steer";

test("a parent message names its sender and carries the words verbatim", () => {
  const content = parentMessageContent("a1", "a2", "stop editing, use the API");

  // The child must be able to tell who is speaking: collapsing the runtime's
  // framing into the parent's words would let a child mistake a correction for
  // its own earlier reasoning.
  expect(content).toContain('source="parent_message"');
  expect(content).toContain('trust="parent"');
  expect(content).toContain('agent_id="a2"');
  expect(content).toContain("Agent a1 sent a message:");
  expect(content).toContain("stop editing, use the API");
});

test("a parent message is framed as a correction, not a new task", () => {
  const content = parentMessageContent("a1", "a2", "look again");

  expect(content).toContain("not as a new task");
});

test("a running child receives the message at its nearest step", () => {
  expect(steerRoute({ status: "running", hasLiveLedger: true })).toBe(
    "delivered",
  );
});

test("a paused child is woken and steered", () => {
  expect(steerRoute({ status: "paused", hasLiveLedger: true })).toBe("resumed");
});

test("a child with no live ledger queues the message", () => {
  // A status alone cannot say whether a runner is holding the ledger right now:
  // a terminal child and one between continuations both read "not running".
  expect(steerRoute({ status: "stopped", hasLiveLedger: false })).toBe(
    "queued",
  );
  expect(steerRoute({ status: "completed", hasLiveLedger: false })).toBe(
    "queued",
  );
  expect(steerRoute({ status: "failed", hasLiveLedger: false })).toBe("queued");
});

test("a live ledger outranks the recorded status", () => {
  // The one case that would silently drop a message: the record says paused but
  // a runner is mid-step, or the reverse. The ledger is the truth.
  expect(steerRoute({ status: "paused", hasLiveLedger: true })).toBe("resumed");
  expect(steerRoute({ status: "running", hasLiveLedger: true })).toBe(
    "delivered",
  );
});
