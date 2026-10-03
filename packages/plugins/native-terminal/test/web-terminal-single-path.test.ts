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

test("OSC 52 — the clipboard write — is refused on purpose", () => {
  // A program in the pane can ask the terminal to write the human's clipboard
  // (OSC 52), and the pane is where the MODEL's commands run — so the ask can
  // come from something the human never launched. xterm 5.5.0 registers no
  // OSC 52 handler, so the sequence is dropped today; this pins the decision
  // rather than leaving the safety to a version's internals: the handler is
  // registered AND returns false, and the comment names the threat so the
  // next reader does not "restore" it as a missing feature.
  const text = source();
  expect(text).toContain("registerOscHandler(52, () => false)");
  // And the model's own screen never carries the sequence either: the virtual
  // screen drops every OSC, which is what keeps a clipboard write out of the
  // pane's READ as well as out of the human's clipboard.
  const screen = readFileSync(
    join(
      root,
      "packages",
      "plugins",
      "native-terminal",
      "src",
      "terminal-screen.ts",
    ),
    "utf8",
  );
  expect(screen).toContain("function skipOsc(");
});

test("a reconnect restores the caret, not just the buffer", () => {
  // VSCode's process reconnection serializes the buffer AND the cursor; ours
  // replayed only the text, so after a panel reopen or a browser reload the
  // caret sat at the origin while the shell was mid-line-editor — the next
  // keystroke lands somewhere the human did not choose. The transport now
  // carries the host's cursor in the restore frame when it has one, and the
  // client parks the caret there: CSI row;col, 1-based, from the host's
  // 0-based pair.
  const text = source();
  const restore = text.slice(
    text.indexOf('message.type === "restore"'),
    text.indexOf('message.type === "output"'),
  );
  // The buffer is still replayed first, and the clear still comes before it.
  expect(restore).toContain("term?.clear()");
  expect(restore).toContain("if (message.text) term?.write(message.text)");
  // Then the caret, only when the host reported both coordinates (a backend
  // that cannot report one keeps the origin rather than being told 0;0).
  expect(restore).toContain(
    "message.cursorX != null && message.cursorY != null",
  );
  expect(restore).toContain(
    "\\x1b[${message.cursorY + 1};${message.cursorX + 1}H",
  );
});
