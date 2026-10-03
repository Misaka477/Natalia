import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPtyTerminalController } from "../src/index";
import type { TerminalController } from "@anthelia/runtime-services";

type PaneRead = Awaited<ReturnType<TerminalController["read"]>>;

/**
 * The pty backend keeps the pane's document in-process, so every extent field
 * is a real number. A null would be the very gap this file exists to pin --
 * the wezterm host's honest unknown -- so failing here is failing for the
 * right reason rather than passing vacuously on `null`.
 */
function requireExtent(
  read: PaneRead,
  what: string,
): { startLine: number; endLine: number; totalLines: number } {
  const { startLine, endLine, totalLines } = read;
  if (startLine === null || endLine === null || totalLines === null)
    throw new Error(`${what}: the pty controller must report a real extent`);
  return { startLine, endLine, totalLines };
}

/**
 * Paging a pane's document, with the extent a caller needs to walk it.
 *
 * `read` could always take a line range; what it did not report was how much document
 * there was, so a caller asking for `startLine: 400` received an empty string and no
 * way to tell "nothing there" from "there is nothing at all". Paging meant guessing,
 * and guessing is what a model does badly.
 *
 * So these assertions are about being able to WALK: the extent is reported, a window
 * past it is empty rather than an error, and a successor window is addressed from its
 * predecessor's end -- never from an arithmetic offset.
 */
test("a pane's document can be paged by a caller that knows its extent", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-paging-"));
  const controller = createPtyTerminalController({
    workspaceRoot: root,
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => undefined,
    windowMode: () => "windowless",
  });
  const waitFor = async (predicate: () => boolean, ms = 15_000) => {
    const deadline = Date.now() + ms;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(50);
    return predicate();
  };
  try {
    await controller.start({ command: "bash", cwd: root, id: "t_page" });
    await waitFor(() => controller.lastCommand?.("t_page")?.atPrompt ?? false);
    controller.write(
      "t_page",
      'for i in $(seq 1 60); do echo "line-$i"; done\n',
    );
    await waitFor(() =>
      (controller.lastCommand?.("t_page")?.commandLine ?? "").includes(
        "seq 1 60",
      ),
    );

    // An absent range is the tail window, and the window says where it sits:
    // the extent is reported, and it is at least the window that was served.
    const tailRead = await controller.read("t_page", { maxLines: 20 });
    const tail = requireExtent(tailRead, "the tail window");
    expect(tail.totalLines).toBeGreaterThanOrEqual(20);
    expect(tail.startLine).toBe(tail.totalLines - 20);
    expect(tail.endLine).toBe(tail.totalLines);
    expect(tailRead.text.split("\n").length).toBe(20);

    // A window beyond the extent is empty rather than an error, and the caller is
    // told the extent it asked past instead of being left to wonder.
    const beyondRead = await controller.read("t_page", {
      startLine: tail.totalLines + 50,
      maxLines: 20,
    });
    expect(beyondRead.text).toBe("");
    const beyond = requireExtent(beyondRead, "the window past the extent");
    expect(beyond.startLine).toBe(tail.totalLines + 50);
    expect(beyond.endLine).toBe(tail.totalLines);

    // Two windows compose into the single window spanning them -- but ONLY when the
    // successor is addressed from its predecessor's end. `startLine + maxLines`
    // assumes every window is exactly `maxLines` lines; the first version of this
    // test used `origin + 20`, which came out one line past w0's end, so the windows
    // overlapped and the join carried a duplicate. A window's endLine is the only
    // honest origin for its successor.
    const origin = tail.startLine - 20;
    const composed = await controller.read("t_page", {
      startLine: origin,
      maxLines: 40,
    });
    const w0Read = await controller.read("t_page", {
      startLine: origin,
      maxLines: 20,
    });
    const w0 = requireExtent(w0Read, "the first window");
    const w1 = await controller.read("t_page", {
      startLine: w0.endLine,
      maxLines: 20,
    });
    expect(w0Read.text + "\n" + w1.text).toBe(composed.text);

    controller.write("t_page", "exit\n");
    await controller.close();
  } finally {
    await controller.close().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}, 40_000);
