import { expect, test } from "bun:test";
import {
  isCardExpanded,
  resetExpandedCards,
  setCardExpanded,
  toolCardKey,
} from "../src/expanded-cards";

/**
 * The expansion survives the virtual list (audit ③): a row scrolled out of
 * the viewport unmounts, and its `expanded` local signal died with it — the
 * reader expanded a 202-line read, scrolled away, came back, and the card
 * was collapsed again. Expansion is row-scoped truth, so it lives keyed by
 * the card's identity and a remount reads it back.
 *
 * The identity is the CALL's durable id, the way the reference implementation
 * keys its rows (`call:${callId}`). A position is only the fallback for a row
 * that carries no id: an index moves when the list shifts, and the reader's
 * expansion then either vanishes or lands on a neighbour.
 */

test("the key is the call's durable id when there is one", () => {
  expect(toolCardKey({ callID: "turn_1:call_a" }, "msg_1", 0)).toBe(
    "call:turn_1:call_a",
  );
  // The same call keeps its key whatever position it is rendered at.
  expect(toolCardKey({ callID: "turn_1:call_a" }, "msg_1", 3)).toBe(
    toolCardKey({ callID: "turn_1:call_a" }, "msg_1", 0),
  );
  // Different calls never collide, even inside one message.
  expect(toolCardKey({ callID: "call_a" }, "msg_1", 0)).not.toBe(
    toolCardKey({ callID: "call_b" }, "msg_1", 0),
  );
});

test("a call without an id falls back to the message plus its index", () => {
  // A hand-built row (a test, a host that skipped the projection) still has a
  // stable key inside one message.
  expect(toolCardKey({}, "msg_1", 0)).toBe("msg_1:0");
  expect(toolCardKey(undefined, "msg_1", 2)).toBe("msg_1:2");
  expect(toolCardKey({}, "msg_2", 0)).not.toBe(toolCardKey({}, "msg_1", 0));
});

test("an expansion persists across a remount and a reset clears it", () => {
  resetExpandedCards();
  const key = toolCardKey({ callID: "call_rm" }, "msg_rm", 0);
  expect(isCardExpanded(key)).toBe(false);
  setCardExpanded(key, true);
  // The remount reads the store, not a fresh signal.
  expect(isCardExpanded(key)).toBe(true);
  // A collapse is recorded too — not just the expansion.
  setCardExpanded(key, false);
  expect(isCardExpanded(key)).toBe(false);
  // One row's expansion never leaks into another's.
  setCardExpanded(key, true);
  expect(
    isCardExpanded(toolCardKey({ callID: "call_other" }, "msg_rm", 0)),
  ).toBe(false);
  resetExpandedCards();
  expect(isCardExpanded(key)).toBe(false);
});
