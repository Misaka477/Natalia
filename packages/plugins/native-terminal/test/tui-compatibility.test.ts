import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import { createPtyTerminalController } from "../src/index";

/**
 * A full-screen TUI through a real pane, read through the model's window.
 *
 * The terminal's contract is not "echo works": a full-screen application
 * repositions the cursor, paints regions and asks the terminal questions, and
 * a pane that forwards bytes but emulates no screen shows none of it. Every
 * program here is exercised the way an operator meets it — spawned as the
 * pane's command through the DEFAULT spawn (the Rust bridge when built, Python
 * otherwise), in a real pty, read back through `read()` (the same
 * virtual-screen window the model reads), never fed by hand.
 *
 * The commands carry `TERM=xterm-256color` because the harness environment
 * may bring `TERM=dumb`, under which tmux refuses to start at all ("missing or
 * unsuitable terminal") and vim limits its output — a pane must be able to
 * describe itself as a capable terminal regardless of the host shell's TERM.
 *
 * Each test skips when its program is absent: a machine without vim is not a
 * broken machine, and a skipped TUI is honest where a failed one would be
 * noise. What is NOT skipped is the shape: the program's own screen content
 * must appear in the read, which is what separates a virtual screen from a
 * byte tap.
 */
function controllerFor(root: string) {
  return createPtyTerminalController({
    workspaceRoot: root,
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => undefined,
    windowMode: () => "windowless",
  });
}

const has = (binary: string) => Bun.which(binary) !== null;

/** Poll the pane's screen until it shows `needle`, or fail with what it shows. */
async function screenShows(
  controller: ReturnType<typeof controllerFor>,
  id: string,
  needle: string,
  ms = 10_000,
): Promise<string> {
  const deadline = Date.now() + ms;
  let text = "";
  while (Date.now() < deadline) {
    text = (await controller.read(id, { maxLines: 24 })).text;
    if (text.includes(needle)) return text;
    await Bun.sleep(100);
  }
  throw new Error(
    `the pane's screen never showed ${JSON.stringify(needle)}; it shows:\n${text}`,
  );
}

test("vim's full-screen render lands in the pane's virtual screen", async () => {
  if (!has("vim")) {
    console.warn("skipped: no vim on this machine");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "natalia-tui-vim-"));
  await writeFile(join(root, "tui.txt"), "NATALIA_TUI_VIM_LINE\n");
  const controller = controllerFor(root);
  const started = await controller.start({
    // `-u NONE` isolates vim from the developer's configuration: the render
    // under test is vim's own, not this machine's vimrc. `--not-a-term` keeps
    // it out of the terminal-warning path when the pty is briefly unavailable.
    command:
      "TERM=xterm-256color vim --not-a-term -n -u NONE -c 'set nomore' tui.txt",
    cwd: root,
    id: "tui_vim",
    rows: 24,
    cols: 80,
  });
  expect(started.host).toBe("pty");
  const text = await screenShows(controller, "tui_vim", "NATALIA_TUI_VIM_LINE");
  // The file's content is ON SCREEN — not merely somewhere in the byte
  // stream — which is the whole difference between a virtual screen and a tap.
  expect(text).toContain("NATALIA_TUI_VIM_LINE");
  // And vim's filler rows: the virtual screen carries the regions vim paints,
  // so an empty buffer reads as `~` lines rather than as nothing at all.
  expect(text).toContain("~");
  await controller.close();
}, 25_000);

test("tmux's status bar and pane content both render", async () => {
  if (!has("tmux")) {
    console.warn("skipped: no tmux on this machine");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "natalia-tui-tmux-"));
  const controller = controllerFor(root);
  // A PRIVATE server socket: without `-L`, new-session joins whatever tmux
  // server is already running, and the window-list index counts the leftovers
  // — measured `[0]`, `[1]`, `[2]` on consecutive runs of the same spec, each
  // one a session an earlier probe left behind. A named socket makes the test
  // hermetic and the index stable.
  const socket = `natalia-tui-${process.pid}-${Date.now()}`;
  await controller.start({
    // `-f /dev/null` is the isolation: a fresh, empty config, so the render
    // under test is tmux's own rather than the developer's status line. The
    // explicit grid keeps the session's geometry equal to the pane's.
    command: `TERM=xterm-256color tmux -L ${socket} -f /dev/null new-session -x 80 -y 24 'echo NATALIA_TMUX_PANE; sleep 30'`,
    cwd: root,
    id: "tui_tmux",
    rows: 24,
    cols: 80,
  });
  const text = await screenShows(controller, "tui_tmux", "NATALIA_TMUX_PANE");
  // The pane's own command output, inside tmux.
  expect(text).toContain("NATALIA_TMUX_PANE");
  // And tmux's status bar — the window list tmux draws over the whole bottom
  // row: `[0]` is the window-list marker, stable across tmux versions. (The
  // window's NAME is deliberately NOT asserted: it races between the session
  // command and tmux's automatic rename — measured both "tmux" and "bash" on
  // consecutive runs of the same spec. The window LIST and its position are
  // the contract; the name is a cosmetics detail.)
  expect(text).toContain("[0]");
  // And its POSITION: the status bar is the pane's LAST row. A byte tap
  // interleaves draws with echoes and cannot promise that; a virtual screen
  // can, because the screen is what tmux actually painted. This is the
  // assertion a screen-less forwarding path fails.
  const lastRow =
    text
      .split("\n")
      .filter((line) => line.trim())
      .at(-1) ?? "";
  expect(lastRow).toContain("[0]");
  await controller.close();
}, 25_000);

test("less renders the file and its END status line", async () => {
  if (!has("less")) {
    console.warn("skipped: no less on this machine");
    return;
  }
  const root = await mkdtemp(join(tmpdir(), "natalia-tui-less-"));
  await writeFile(join(root, "page.txt"), "NATALIA_TUI_LESS_PAGE\n");
  const controller = controllerFor(root);
  await controller.start({
    command: "TERM=xterm-256color less page.txt",
    cwd: root,
    id: "tui_less",
    rows: 24,
    cols: 80,
  });
  const text = await screenShows(
    controller,
    "tui_less",
    "NATALIA_TUI_LESS_PAGE",
  );
  expect(text).toContain("NATALIA_TUI_LESS_PAGE");
  // The END marker is less's own status line: a one-screen file, read to its
  // end, with the prompt saying so. A byte tap never shows it; a virtual
  // screen does, because less draws it over the bottom row — which is also
  // why the position, not just the presence, is what this asserts.
  expect(text).toContain("END");
  const lastRow =
    text
      .split("\n")
      .filter((line) => line.trim())
      .at(-1) ?? "";
  expect(lastRow).toContain("END");
  await controller.close();
}, 25_000);

test("an emoji survives the round trip, and a resize repaints the screen", async () => {
  // Two properties a pane owes a human, both cheap to lose and invisible to
  // an ASCII test: a wide (double-width) glyph must occupy two cells rather
  // than corrupting the line, and a resize must repaint the screen at the new
  // geometry — the model's window is the pane's screen, so the two cannot
  // disagree about the size.
  const root = await mkdtemp(join(tmpdir(), "natalia-tui-emoji-"));
  const controller = controllerFor(root);
  await controller.start({
    command: "bash --norc --noprofile",
    cwd: root,
    id: "tui_emoji",
    rows: 24,
    cols: 80,
  });
  const wait = async (predicate: () => boolean, ms = 10_000) => {
    const deadline = Date.now() + ms;
    while (!predicate() && Date.now() < deadline) await Bun.sleep(50);
  };
  await wait(() => controller.lastCommand?.("tui_emoji")?.atPrompt === true);
  controller.write("tui_emoji", "echo EMOJI=🎉-TAIL\n");
  const text = await screenShows(controller, "tui_emoji", "TAIL");
  // The glyph is intact and the line's tail still reads after it: the screen's
  // width accounting held. (The pty carries the bytes; the screen is where the
  // double-width glyph must become two cells and still let the letters after
  // it read in the right columns.)
  expect(text).toContain("EMOJI=");
  expect(text).toContain("TAIL");
  // And the resize: the model's window is the pane's screen, so the two
  // cannot disagree about the size. 40 rows from 24 — a TUI's whole reason
  // to redraw. The read reports the pane's own geometry, which is the screen's.
  await controller.resize("tui_emoji", 40, 120, "human");
  const read = await controller.read("tui_emoji", { maxLines: 60 });
  expect(read.rows).toBe(40);
  expect(read.cols).toBe(120);
  await controller.close();
}, 25_000);
