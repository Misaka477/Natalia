/**
 * Two spawn facts that only bite on Windows, pinned in the source.
 *
 * 1. The PTY bridges are spawned with `windowsHide: true`. The ConPTY bridge is a
 *    CONSOLE-subsystem executable (PE subsystem 3, measured), so spawning it from
 *    a GUI process without CREATE_NO_WINDOW makes Windows allocate a VISIBLE
 *    console window — one per pane. That is the "terminal windows keep popping
 *    up" report, and it is invisible on Linux where the same code runs.
 *
 * 2. The read-image card carries the media file's PATH, never a fabricated
 *    attachment id. The runtime's own result sentence is
 *    `image attached: <absolute path>`; the card used to put that string in
 *    `attachmentID`, so the client asked the runtime for an attachment by that
 *    name and was refused ("attachment is not referenced by session") — every
 *    read-image card showed 加载失败.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");

const controller = readFileSync(
  join(
    repoRoot,
    "packages",
    "plugins",
    "native-terminal",
    "src",
    "pty-terminal-controller.ts",
  ),
  "utf8",
);

test("every PTY bridge spawn hides its console window", () => {
  // All three bridges (python, rust, conpty) go through `spawn(helper, …)`.
  const bridgeSpawns = controller
    .split("\n")
    .map((line, index) => ({ line, index }))
    .filter(({ line }) => /spawn\((helper|"python3")/u.test(line));
  expect(bridgeSpawns.length).toBeGreaterThanOrEqual(3);
  for (const { line, index } of bridgeSpawns) {
    // The options object is on the same line or the next few.
    const window = controller
      .split("\n")
      .slice(index, index + 5)
      .join("\n");
    expect(
      `${line} → hides: ${window.includes("windowsHide: true")}`,
    ).toContain("hides: true");
  }
});

test("the read-image card hands over a path, not an attachment id", () => {
  const tool = readFileSync(
    join(
      repoRoot,
      "packages",
      "plugins",
      "tools",
      "fs-read",
      "src",
      "fs-read-tools.ts",
    ),
    "utf8",
  );
  // The fabricated id is gone, and the path is set instead.
  expect(tool).not.toContain("attachmentID: attachmentIDFromResult");
  expect(tool).toContain("path: attachedPathFromResult");
  // The comment must name what the sentence really is, so the next reader does
  // not restore the old assumption.
  expect(tool).toContain("image attached: <path>");
});

test("the runtime serves a workspace media path through the read authorization", () => {
  const runtime = readFileSync(
    join(
      repoRoot,
      "packages",
      "framework",
      "client",
      "src",
      "runtime",
      "attachment-runtime.ts",
    ),
    "utf8",
  );
  // The store-only branch is what refused every read-image preview.
  expect(runtime).toContain("authorizeWorkspaceRead");
  expect(runtime).toContain('input.mediaType.startsWith("image/")');
  // Media only: this route shows a picture, it is not a general file reader.
  expect(runtime).not.toContain(
    "readFile(resolved);\n        return `data:text/",
  );
});
