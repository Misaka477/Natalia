import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * Every transcript host's tool-row signature lists every field the row's
 * derivation reads (UI refactor R0).
 *
 * The bug this guards is the one that cost the user a day: the row signature
 * listed the result and the status but NOT `argumentsRaw`, so a row cached
 * while arguments were still streaming kept its half-parsed arguments
 * forever — the signature never changed again. R0 adds the card and its
 * structured facts as things the row RENDERS, so they belong to the row's
 * identity for exactly the same reason.
 *
 * A signature that omits a field the derivation reads pins a stale row: the
 * card stops updating, the Q&A stays cramped, and nothing in the code looks
 * broken. Hence a mechanical check over the three hosts' signature blocks.
 */

const webRoot = join(import.meta.dir, "..", "src");
const hosts = ["app-neu.tsx", "agent-panel.tsx", "nia-panel.tsx"] as const;

/** The ToolBlock fields a tool row's derivation reads. */
const REQUIRED_FIELDS = [
  "name",
  "result",
  "summary",
  "argumentsRaw",
  // The structured slots R0 added: the card a row dispatches on, the meta
  // beside it, and the legacy blob the replay fallback decodes.
  "card",
  "meta",
  "metadata",
] as const;

test("every host's tool-row signature lists the fields the row renders", () => {
  for (const host of hosts) {
    const source = readFileSync(join(webRoot, host), "utf8");
    // Each host builds its tool rows through the kit's toolCallRow; the
    // signature block guarding that create() is the one under check.
    const blocks = [...source.matchAll(/signature: \[([\s\S]*?)\]/gu)]
      .map((match) => match[1]!)
      .filter((block) => /tool\.argumentsRaw/u.test(block));
    expect(
      blocks.length,
      `${host}: expected at least one tool-row signature`,
    ).toBeGreaterThan(0);
    for (const block of blocks) {
      const fields = new Set(
        [...block.matchAll(/\btool\.(\w+)/gu)].map((match) => match[1]!),
      );
      for (const field of REQUIRED_FIELDS)
        expect(
          fields.has(field),
          `${host}: the tool-row signature must list tool.${field} — a field the row renders that the signature omits pins a stale row`,
        ).toBe(true);
    }
  }
});
