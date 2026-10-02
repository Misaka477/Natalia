import { expect, test } from "bun:test";
import {
  dedupeVirtualItems,
  duplicateValues,
  duplicateVirtualIndexes,
} from "@natalia/ui-kit";

test("dedupeVirtualItems keeps one entry per logical index", () => {
  const items = [
    { index: 4, key: "d" },
    { index: 5, key: "e" },
    { index: 5, key: "e" },
    { index: 6, key: "f" },
  ];
  expect(dedupeVirtualItems(items)).toEqual([
    { index: 4, key: "d" },
    { index: 5, key: "e" },
    { index: 6, key: "f" },
  ]);
});

test("duplicateValues reports each repeated value once in first-seen order", () => {
  expect(duplicateValues(["a", "b", "a", "b", "c", "a"])).toEqual(["a", "b"]);
  expect(
    duplicateVirtualIndexes([{ index: 1 }, { index: 2 }, { index: 1 }]),
  ).toEqual([1]);
});
