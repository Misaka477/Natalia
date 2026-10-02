import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * One live message path.
 *
 * The pane's socket had TWO handlers for the same message types: a
 * `handleServerMessage` function and the `ws.onmessage` closure. Only the closure
 * was wired; the function was defined and never called — 33 lines of a second
 * implementation of restore/output/error/exit/ready, one edit away from being
 * mistaken for the live one (and from being wired by someone "fixing" a bug in
 * the wrong copy).
 */
const root = join(import.meta.dir, "..", "..", "..", "..");
const source = () =>
  readFileSync(
    join(
      root,
      "packages",
      "plugins",
      "native-terminal",
      "src",
      "ui",
      "web-terminal.tsx",
    ),
    "utf8",
  );

test("there is exactly one message handler, and it is the wired one", () => {
  const text = source();
  // No dead copy.
  expect(text).not.toContain("function handleServerMessage(");
  // The live one, and it handles each type once.
  expect(text).toContain("ws.onmessage");
  for (const type of ["restore", "output", "error", "exit", "ready"])
    expect(
      (text.match(new RegExp(`message.type === "${type}"`, "gu")) ?? []).length,
      `${type} is handled more than once`,
    ).toBe(1);
});

test("the replay clears before writing, so an empty screen stays empty", () => {
  // The server now sends a restore UNCONDITIONALLY (empty text included); the
  // client must therefore clear on every one and write only what there is.
  const text = source();
  const restore = text.slice(
    text.indexOf('message.type === "restore"'),
    text.indexOf('message.type === "output"'),
  );
  expect(restore).toContain("term?.clear()");
  expect(restore).toContain("if (message.text)");
});
