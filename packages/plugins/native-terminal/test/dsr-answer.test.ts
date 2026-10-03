import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

import { createPtyTerminalController } from "../src/index";

/**
 * The bridge answers the cursor-position query, and the SHELL can see the answer.
 *
 * A shell that runs a full line editor asks where the cursor is before it draws
 * anything, and blocks until a terminal replies. This bridge is that terminal — it owns
 * the pty the child writes into — and it does not answer: the child waits forever, its
 * read-line call returns empty, and the command-level read comes back with no command.
 * bash and zsh never ask, which is why only a pane that does could show it.
 *
 * WHY THE SHELL READS THE ANSWER ITSELF. The reply is written to the pty master, which
 * is the child's INPUT — so it never appears in the pane's output stream, and an
 * assertion on the rendered text cannot see it. The first version of this test asserted
 * exactly that and passed with the reply removed: it was observing the query being
 * stripped, not the answer arriving. So the observable half is the child's own read of
 * its stdin, which is what a line editor does.
 */
test("a pane's cursor query is answered, and the shell reads the reply", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-dsr-"));
  const controller = createPtyTerminalController({
    workspaceRoot: root,
    publish: () => undefined,
    onPerformance: () => undefined,
    runtimeID: () => "runtime-test",
    userRuntimeHome: () => undefined,
    windowMode: () => "windowless",
  });
  try {
    await controller.start({ command: "bash", cwd: root, id: "t_dsr" });
    const waitFor = async (predicate: () => boolean, ms = 10_000) => {
      const deadline = Date.now() + ms;
      while (!predicate() && Date.now() < deadline) await Bun.sleep(50);
      return predicate();
    };
    await waitFor(() => controller.lastCommand?.("t_dsr")?.atPrompt ?? false);

    // Ask the question a line editor asks, then read one second of stdin: the reply
    // is input to the child, so a read with a timeout either gets it or times out.
    // `od` makes the bytes visible in the output the command-level read captures.
    controller.write(
      "t_dsr",
      "printf '\\033[6n'; IFS= read -r -t 2 -d 'R' reply; printf 'REPLY=[%s]' \"$reply\"\n",
    );
    // Wait for the command to FINISH, not merely to be seen. `output` is a
    // projection of the screen taken at the `D` marker, so it is undefined until
    // the command settles — asserting on it while the command is still running
    // reads a missing value and proves nothing. `exitCode` having a value is the
    // signal that the fold completed.
    const settled = await waitFor(
      () => controller.lastCommand?.("t_dsr")?.exitCode !== undefined,
    );
    expect(settled, "the command settled, so the reply was consumed").toBe(
      true,
    );
    const command = controller.lastCommand?.("t_dsr");
    // The reply body is `ESC [ <rows> ; <cols>` before the trailing R, so the digits
    // and the semicolon are the shape that matters — not exact values, which are the
    // pane's geometry.
    // The reply is `ESC [ <rows> ; <cols> R`. It arrives as the shell's stdin AND
    // is echoed back by the pty's line discipline, so both halves are in the output:
    // the raw reply, and the shell's own read of it. The digits are the pane's
    // geometry, so the SHAPE is asserted rather than exact values.
    // The reply is `ESC [ <rows> ; <cols> R`. It arrives as the shell's stdin AND is
    // echoed back by the pty's line discipline, so both halves are in the output: the
    // raw reply, and the shell's own read of it. The digits are the pane's geometry,
    // so the SHAPE is asserted rather than exact values.
    expect(command?.output).toContain("REPLY=[");
    // `<rows>;<cols>R` is the reply's body with the ESC prefix -- the prefix is not
    // matched on because the screen renderer owns escape bytes and may not hand the
    // same one back. 50;200 is this pane's geometry, and a reply is the only thing that
    // produces that shape in a shell's output.
    expect(command?.output).toMatch(/[0-9]+;[0-9]+R/);
    // printed, not guessed: the reply arrives as the shell's stdin and is echoed by
    // the pty, so it is in the output alongside the shell's own read of it.
    if (process.env.NATALIA_PROBE_DSR)
      console.error("PROBE_COMMAND=" + JSON.stringify(command));
    controller.write("t_dsr", "exit\n");
    await controller.close();
  } finally {
    await controller.close().catch(() => {});
    await rm(root, { recursive: true, force: true }).catch(() => {});
  }
}, 30_000);
