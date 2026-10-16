/**
 * The correlation spine, swept across the publishers that report per-turn
 * problems (audit 缺口 3).
 *
 * `policy-turn-spine.test.ts` pins the three gates; this pins the rest of the
 * sweep: the Nia and Navi turns' attachment and phase diagnostics, and the
 * mailbox's plan-handoff checkpoint failure. Each knows its turn — the exec is
 * right there — and each now says so, so "which turn hit this" is one filter
 * away instead of unanswerable.
 *
 * The pin reads the source: a live harness would need to trigger an attachment
 * failure, a phase failure and a checkpoint failure in three different turns,
 * which is far larger than the invariant (a publisher in these files that
 * forgets `turnID`).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const root = join(
  import.meta.dir,
  "..",
  "..",
  "..",
  "domains",
  "collab",
  "src",
);
const files = ["chat-turn-nia.ts", "chat-turn-navi.ts", "mailbox-plans.ts"];

/**
 * The slice of source around ONE publisher: from its `publishForSession(`
 * up to the next one. A brace-matching extractor would have to understand
 * template literals first — a diagnostic's message interpolates `${…}` and
 * its closing brace is not the object's — which is exactly the shape this
 * file's mailbox publisher has.
 */
function publishers(file: string): string[] {
  const source = readFileSync(join(root, file), "utf8");
  const starts: number[] = [];
  let at = source.indexOf("publishForSession(");
  while (at !== -1) {
    starts.push(at);
    at = source.indexOf("publishForSession(", at + 1);
  }
  const slices: string[] = [];
  for (let index = 0; index < starts.length; index += 1) {
    const from = starts[index]!;
    const to = index + 1 < starts.length ? starts[index + 1]! : source.length;
    const slice = source.slice(from, to);
    if (slice.includes('type: "diagnostic"')) slices.push(slice);
  }
  return slices;
}

describe("every collab diagnostic names its turn", () => {
  test("the sweep still finds the five publishers", () => {
    expect(publishers("chat-turn-nia.ts").length).toBe(2);
    expect(publishers("chat-turn-navi.ts").length).toBe(2);
    expect(publishers("mailbox-plans.ts").length).toBe(1);
  });

  test("each carries turnID", () => {
    const missing: string[] = [];
    for (const file of files)
      for (const block of publishers(file))
        if (!/turnID:/u.test(block)) missing.push(block);
    expect(missing).toEqual([]);
  });
});
