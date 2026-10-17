/**
 * The command is reachable.
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
 */
import { expect, test } from "bun:test";

const kit = await Bun.file(
  new URL("../src/transcript.tsx", import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/u,
    "$1",
  ),
).text();

test("the command is a body line of the EXPANDED card, not only a clipped header", () => {
  const at = kit.indexOf("const commandLines = (): ToolCardLine[] => {");
  expect(at).toBeGreaterThan(0);
  const body = kit.slice(at, at + 700);
  // Prefixed the way a shell prompt reads, so a reader cannot mistake the
  // command for output.
  expect(body).toContain("`$ ${title}`");
  // Only when open: the collapsed card is unchanged, and the header's clipped
  // title plus a hover is the collapsed form.
  expect(body).toContain("if (!title || !expanded()) return [];");
  // It rides the same line list the cap and the fold read.
  expect(kit).toContain("const allLines = () => [...commandLines(), ...bodyLines()];");
});

test("the fold toggle's count includes the command, and a card with no output still opens", () => {
  // The promise counts the command lines in BOTH states, so "展开全部（N 行）"
  // delivers exactly N.
  const at = kit.indexOf("const totalLineCount = () =>");
  expect(at).toBeGreaterThan(0);
  expect(kit.slice(at, at + 160)).toContain("bodyLines().length + commandLineCount()");
  // Hidden lines include the command while closed, which is what makes the
  // toggle appear for a card whose output is empty.
  const hidden = kit.indexOf("const hiddenCount = () =>");
  expect(hidden).toBeGreaterThan(0);
  expect(kit.slice(hidden, hidden + 260)).toContain(
    "(expanded() ? 0 : commandLineCount())",
  );
  expect(kit).toContain("展开全部（${totalLineCount()} 行，已折叠 ${hiddenCount()} 行）");
});

test("the header's clipped title carries the full command as its hover", () => {
  expect(kit).toContain('<span class="natalia-tool-title" title={card?.title}>');
});
