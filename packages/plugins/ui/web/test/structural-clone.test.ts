/**
 * The structural clone is what keeps the transcript's rows alive.
 *
 * `<For>` keys by element identity, so a snapshot that rebuilds every row each
 * frame rebuilds the DOM with it — the measured card-toolbar flicker, the click
 * that landed on a node replaced between mousedown and mouseup (image preview
 * never opening while the model streamed), and the media loader re-running per
 * remount. These pins are the contract that makes the rows stable:
 *
 *   - an unchanged branch is the PREVIOUS SNAPSHOT's object (identity), so
 *     Solid reuses the row;
 *   - a changed branch is a new object, and it is a COPY — never the live
 *     state's own object, so a later in-place mutation cannot reach into a
 *     snapshot Solid already holds;
 *   - an in-place mutation of a nested element IS seen (equality is by value,
 *     not by reference), which is why this cannot be a plain reference-reuse
 *     shortcut.
 */
import { expect, test } from "bun:test";
import { structuralClone } from "../src/structural-clone";

type Row = { id: string; text?: string; status?: string; tools?: string[] };

function state(rows: Row[], turns: number): { rows: Row[]; turns: number } {
  return { rows, turns };
}

test("an unchanged branch keeps the previous snapshot's identity", () => {
  const first = structuralClone(undefined, state([{ id: "a", text: "hi" }], 1));
  const second = structuralClone(first, state([{ id: "a", text: "hi" }], 1));
  // The whole tree was equal, so the snapshot itself is reused.
  expect(second).toBe(first);
  // And a row that did not move is the same object across frames.
  const streamed = structuralClone(
    second,
    state([{ id: "a", text: "hi" }, { id: "b", text: "partial" }], 1),
  );
  expect(streamed.rows[0]).toBe(second.rows[0]);
  expect(streamed.rows[1]).not.toBe(second.rows[1]);
});

test("a changed branch is copied, never the live state's own object", () => {
  const live = state([{ id: "a", text: "one" }], 1);
  const snapshot = structuralClone(undefined, live);
  // The live state is then mutated in place — the projection's own style.
  live.rows[0]!.text = "two";
  const next = structuralClone(snapshot, live);
  expect(next.rows[0]!.text).toBe("two");
  expect(next.rows[0]).not.toBe(live.rows[0]);
  // The snapshot Solid already holds is untouched by that later mutation.
  expect(snapshot.rows[0]!.text).toBe("one");
});

test("an in-place mutation of a nested element is seen", () => {
  const live = state([{ id: "a", text: "one", tools: ["t1"] }], 1);
  const snapshot = structuralClone(undefined, live);
  // Reference-reuse would miss this: the element object is the same one.
  const row = live.rows[0]!;
  row.tools!.push("t2");
  row.status = "done";
  const next = structuralClone(snapshot, live);
  expect(next.rows[0]!.tools).toEqual(["t1", "t2"]);
  expect(next.rows[0]!.status).toBe("done");
  expect(snapshot.rows[0]!.tools).toEqual(["t1"]);
  expect(snapshot.rows[0]!.status).toBeUndefined();
});

test("a shorter or longer array is rebuilt without reusing stale entries", () => {
  const snapshot = structuralClone(
    undefined,
    state([{ id: "a" }, { id: "b" }], 1),
  );
  const shrunk = structuralClone(snapshot, state([{ id: "a" }], 1));
  expect(shrunk.rows.length).toBe(1);
  expect(shrunk.rows[0]).toBe(snapshot.rows[0]);
  const grown = structuralClone(shrunk, state([{ id: "a" }, { id: "c" }], 2));
  expect(grown.rows[0]).toBe(shrunk.rows[0]);
  expect(grown.rows[1]!.id).toBe("c");
  expect(grown.turns).toBe(2);
});

test("a non-JSON value is carried by value", () => {
  const previous: { when: Date; fn: () => number } = {
    when: new Date(0),
    fn: () => 1,
  };
  const next: { when: Date; fn: () => number } = {
    when: new Date(0),
    fn: () => 2,
  };
  const out = structuralClone(previous, next);
  expect(out.when).not.toBe(previous.when);
  expect(out.fn).toBe(next.fn);
});
