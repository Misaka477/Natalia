import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPtyTerminalController } from "../src/index";

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

    const tail = await controller.read("t_page", { maxLines: 20 });

    const origin = tail.startLine - 20;
    const composed = await controller.read("t_page", {
      startLine: origin,
      maxLines: 40,
    });
    const w0 = await controller.read("t_page", {
      startLine: origin,
      maxLines: 20,
    });
    const w1 = await controller.read("t_page", {
      // The next window starts where the previous one ENDED, not at an
      // arithmetic offset. `startLine + maxLines` assumes every window is exactly
      // `maxLines` lines; `origin + 20` came out one line past w0's end, so the two
      // windows overlapped by a line and the join carried a duplicate. A window's
      // own `endLine` is the only honest origin for its successor.
      startLine: w0.endLine,
      maxLines: 20,
    });

    // The extent is reported, and it is at least the window that was served.
    expect(tail.totalLines).toBeGreaterThanOrEqual(20);
    // An absent range is the tail window, and the window says where it sits.
    expect(tail.startLine).toBe(tail.totalLines - 20);
    expect(tail.endLine).toBe(tail.totalLines);
    expect(tail.text.split("\n").length).toBe(20);

    // A window beyond the extent is empty rather than an error.
    const beyond = await controller.read("t_page", {
      startLine: tail.totalLines + 50,
      maxLines: 20,
    });
    expect(beyond.text).toBe("");
    expect(beyond.startLine).toBe(tail.totalLines + 50);
    expect(beyond.endLine).toBe(tail.totalLines);

    // Two origin-addressed windows compose into the single window spanning them.
    // Both sides are addressed from the SAME origin: a tail window and an
    // origin-addressed one are different windows, so comparing them was never
    // going to match -- which is what the first attempt at this did.
    expect(w0.text + "\n" + w1.text).toBe(composed.text);

    controller.write("t_page", "exit\n");
    await controller.close();
  } finally {
    await controller.close().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}, 40_000);
