/**
 * The command is reachable — and only a command is drawn as one.
 *
 * Measured defect this pins: a `run_shell` card showed
 * `Start-Process -FilePath 'D:/Software_Development/mini...` — the card's title
 * (the command) clipped by CSS in the header, with no tooltip, no wrap and no
 * disclosure. The command was the ONLY thing missing from the body, so the full
 * text was unreachable: the reader could see what a shell call printed but not
 * what it ran.
 *
 * The reference rows keep the header to the family label plus the summary and
 * put the command in the body, which is what the expanded card now does. The
 * command rides the card's own fold, so the toggle's promise counts it — a
 * control that promises N lines and delivers N is the rule this card already
 * lives by.
 *
 * The `$` prefix belongs to the `terminal` kind ALONE. Every card kind carries a
 * title — a path, an id, a task — and drawing `$ <title>` in front of those told
 * the reader a task id was the command that ran: `record_validation`'s card put
 * its `taskID` behind a shell prompt (`$ fourier-contour-video`) while the
 * command it actually ran appeared nowhere.
 */
import { expect, test } from "bun:test";

const kit = await Bun.file(
  new URL("../src/transcript.tsx", import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/u,
    "$1",
  ),
).text();

test("the command is a body line of the EXPANDED terminal card, not only a clipped header", () => {
  const at = kit.indexOf("const commandLines = (): ToolCardLine[] => {");
  expect(at).toBeGreaterThan(0);
  const body = kit.slice(at, at + 700);
  // Only a terminal card's title IS a command.
  expect(body).toContain('current?.kind !== "terminal"');
  // Prefixed the way a shell prompt reads, so a reader cannot mistake the
  // command for output.
  expect(body).toContain("`$ ${current.title}`");
  // Only when open: the collapsed card is unchanged, and the header's clipped
  // title plus a hover is the collapsed form.
  expect(body).toContain("!expanded()");
  // It rides the same line list the cap and the fold read.
  expect(kit).toContain(
    "const allLines = () => [...commandLines(), ...bodyLines()];",
  );
});

test("the fold toggle's count includes the command, and a card with no output still opens", () => {
  // The promise counts the command lines in BOTH states, so "展开全部（N 行）"
  // delivers exactly N.
  const at = kit.indexOf("const totalLineCount = () =>");
  expect(at).toBeGreaterThan(0);
  expect(kit.slice(at, at + 160)).toContain(
    "bodyLines().length + commandLineCount()",
  );
  // Hidden lines include the command while closed, which is what makes the
  // toggle appear for a card whose output is empty. `foldableCount` is the
  // expanded-independent half: it answers "is there anything to fold back?"
  // and must count the command unconditionally.
  const foldable = kit.indexOf("const foldableCount = () =>");
  expect(foldable).toBeGreaterThan(0);
  expect(kit.slice(foldable, foldable + 420)).toContain("commandLineCount()");
  // `hiddenCount` is the "how many are hidden right now" half, and it is zero
  // once the card is open.
  const hidden = kit.indexOf("const hiddenCount = () =>");
  expect(hidden).toBeGreaterThan(0);
  expect(kit.slice(hidden, hidden + 120)).toContain(
    "expanded() ? 0 : foldableCount()",
  );
  expect(kit).toContain(
    "展开全部（${totalLineCount()} 行，已折叠 ${hiddenCount()} 行）",
  );
});

test("an expanded tool card can be collapsed again", () => {
  // The measured defect: the 收起 control rendered only when
  // `hiddenCount() > 0`, and `hiddenCount()` is 0 BY DEFINITION once the card
  // is open — so the button that opened the card deleted itself in the act of
  // opening, and a tool card could be expanded but never collapsed.
  const collapse = kit.indexOf(">\n              收起");
  expect(collapse).toBeGreaterThan(0);
  // Its condition is the fold's availability, not the current hidden count.
  const before = kit.slice(Math.max(0, collapse - 400), collapse);
  expect(before).toContain("expanded() && foldableCount() > 0");
  expect(before).not.toContain("hiddenCount() > 0");
});

test("the header's clipped title carries the full command as its hover", () => {
  expect(kit).toContain(
    '<span class="natalia-tool-title" title={card()?.title}>',
  );
});
