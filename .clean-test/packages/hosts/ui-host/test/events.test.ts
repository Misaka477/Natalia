import { expect, test } from "bun:test";
import { createUiEventBus, eventMatches } from "../src";

test("empty and wildcard filters match every runtime event type", () => {
  expect(eventMatches("session.created", undefined)).toBe(true);
  expect(eventMatches("turn.submitted", [])).toBe(true);
  expect(eventMatches("navi.chat.message.added", ["*"])).toBe(true);
  expect(eventMatches("checkpoint.created", ["runtime.*"])).toBe(true);
});

test("turn, chat, and checkpoint prefixes match only their families", () => {
  expect(eventMatches("turn.submitted", ["runtime.turn.*"])).toBe(true);
  expect(eventMatches("turn.started", ["runtime.turn.*"])).toBe(true);
  expect(eventMatches("navi.chat.message.added", ["runtime.turn.*"])).toBe(
    false,
  );
  expect(eventMatches("navi.chat.message.added", ["runtime.navi.chat.*"])).toBe(
    true,
  );
  expect(eventMatches("nia.chat.turn.started", ["runtime.navi.chat.*"])).toBe(
    false,
  );
  expect(eventMatches("nia.chat.turn.started", ["runtime.nia.chat.*"])).toBe(
    true,
  );
  expect(eventMatches("turn.submitted", ["runtime.chat.*"])).toBe(false);
  expect(eventMatches("checkpoint.created", ["runtime.checkpoint.*"])).toBe(
    true,
  );
  expect(eventMatches("checkpoint.failed", ["runtime.checkpoint.*"])).toBe(
    true,
  );
  expect(eventMatches("session.created", ["runtime.checkpoint.*"])).toBe(false);
});

test("exact event names match with or without the runtime prefix", () => {
  expect(eventMatches("session.created", ["session.created"])).toBe(true);
  expect(eventMatches("session.created", ["runtime.session.created"])).toBe(
    true,
  );
  expect(eventMatches("turn.submitted", ["session.created"])).toBe(false);
});

test("the event bus fans out only to matching subscribers", () => {
  const bus = createUiEventBus();
  const all: string[] = [];
  const turns: string[] = [];
  const offAll = bus.subscribe((event) => all.push(event.type));
  const offTurns = bus.subscribe(
    (event) => turns.push(event.type),
    ["runtime.turn.*"],
  );
  bus.emit({
    type: "session.created",
    sessionID: "ses_1" as never,
    title: "Work",
  });
  bus.emit({
    type: "turn.submitted",
    id: "t1",
    text: "hi",
    byteLength: 2,
    lineCount: 1,
    sha256: "x",
  });
  offAll();
  offTurns();
  bus.emit({
    type: "turn.started",
    id: "t1",
  });
  expect(all).toEqual(["session.created", "turn.submitted"]);
  expect(turns).toEqual(["turn.submitted"]);
});
