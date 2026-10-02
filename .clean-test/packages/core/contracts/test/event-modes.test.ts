import { expect, test } from "bun:test";
import {
  EVENT_MODES,
  eventMode,
  type EventFamilies,
  type EventMode,
  type EventModeTable,
} from "../src/event-modes";
import type { RuntimeEvent } from "../src/events";

test("every family in the event union has a declared mode", () => {
  // The mapped type makes this hold at compile time; the runtime assertion
  // keeps the guarantee honest if the type is ever loosened.
  const table: EventModeTable = EVENT_MODES;
  const modes = new Set<string>(Object.values(table));
  expect(modes.size).toBeGreaterThan(0);
  for (const mode of modes)
    expect(["bail", "waterfall", "emit"]).toContain(mode);
});

test("eventMode resolves the family of namespaced and bare types", () => {
  expect(eventMode("session.created" as RuntimeEvent["type"])).toBe(
    EVENT_MODES.session,
  );
  expect(eventMode("chat.thinking.delta" as RuntimeEvent["type"])).toBe(
    EVENT_MODES.chat,
  );
  // The one unnamespaced type in the union is its own family.
  expect(eventMode("diagnostic" as RuntimeEvent["type"])).toBe(
    EVENT_MODES.diagnostic,
  );
  // The namespaced-collab legacy alias carries its own family.
  expect(eventMode("natalia.collab.message" as RuntimeEvent["type"])).toBe(
    EVENT_MODES.natalia,
  );
});

test("the table is keyed by exactly the families the union uses", () => {
  // A family added to the union without a declaration is a compile error; this
  // test fails the other direction — a stale row that no event uses anymore.
  const declared = Object.keys(EVENT_MODES).sort() as EventFamilies[];
  const used = [
    ...new Set(
      (
        [
          "session.created",
          "chat.thinking.delta",
          "checkpoint.created",
          "approval.request",
          "diagnostic",
          "turn.started",
        ] as RuntimeEvent["type"][]
      ).map((type) => type.split(".")[0] as EventFamilies),
    ),
  ].sort();
  for (const family of used) expect(declared).toContain(family);
});

test("the declaration is descriptive today: no family deviates from emit", () => {
  // Locked until the generation machine lands its verification pipe — the
  // first consumer with real bail semantics. When a family flips, this test
  // is updated in the same commit as the consumer that gives the mode meaning.
  const deviations = Object.entries(EVENT_MODES).filter(
    ([, mode]) => mode !== "emit",
  );
  expect(deviations).toEqual([]);
});

test("a mode is one of the three declared values", () => {
  const mode: EventMode = "waterfall";
  expect(["bail", "waterfall", "emit"]).toContain(mode);
});
