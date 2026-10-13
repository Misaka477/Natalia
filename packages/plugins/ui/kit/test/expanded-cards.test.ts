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
 * the card's row id and a remount reads it back.
 */

test("the key is the message id plus the call's index", () => {
  // A message can carry several tool calls and the durable ToolCall shape
  // has no id of its own, so the index is what tells them apart.
  expect(toolCardKey("msg_1", 0)).toBe("msg_1:0");
  expect(toolCardKey("msg_1", 2)).not.toBe(toolCardKey("msg_1", 0));
  expect(toolCardKey("msg_2", 0)).not.toBe(toolCardKey("msg_1", 0));
});

test("an expansion persists across a remount and a reset clears it", () => {
  resetExpandedCards();
  const key = toolCardKey("msg_rm", 0);
  expect(isCardExpanded(key)).toBe(false);
  setCardExpanded(key, true);
  // The remount reads the store, not a fresh signal.
  expect(isCardExpanded(key)).toBe(true);
  // A collapse is recorded too — not just the expansion.
  setCardExpanded(key, false);
  expect(isCardExpanded(key)).toBe(false);
  // One row's expansion never leaks into another's.
  setCardExpanded(key, true);
  expect(isCardExpanded(toolCardKey("msg_rm", 1))).toBe(false);
  resetExpandedCards();
  expect(isCardExpanded(key)).toBe(false);
});
