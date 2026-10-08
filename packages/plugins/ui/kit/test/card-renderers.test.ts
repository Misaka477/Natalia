import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The framework layer's card dispatch (UI refactor R0), guarded as contract.
 *
 * Two invariants hold the architecture the plan states:
 *
 *   1. **卡型完备** — every `ToolCard` kind has EXACTLY ONE renderer in the
 *      kit. The renderer table is `Record<ToolCard["kind"], ...>`, so a new
 *      kind fails the compiler the moment it is added to the union; this
 *      test pins the other direction (no renderer exists without a kind,
 *      none is duplicated) by reading both sources as text.
 *
 *   2. **框架无工具名** — the card dispatch names KINDS, never tools. A
 *      tool owns what its result means; the framework owns how a kind
 *      looks. The allowed tool-name sugar (the row-label table, the keyed
 *      toolviews still living out their migration) stays in message.ts, and
 *      this guard keeps it out of transcript.tsx — the dispatch surface.
 *      Each later batch shrinks the allowed set; R6 deletes it entirely.
 */

const kitRoot = join(import.meta.dir, "..");
const repoRoot = join(kitRoot, "..", "..", "..", "..");
const transcript = readFileSync(join(kitRoot, "src", "transcript.tsx"), "utf8");
const message = readFileSync(join(kitRoot, "src", "message.ts"), "utf8");
const contractsEvents = readFileSync(
  join(repoRoot, "packages/core/contracts/src/events.ts"),
  "utf8",
);

/** The vocabulary the decoder validates a decoded card's kind against. */
function contractKinds(): string[] {
  const block = /export const TOOL_CARD_KINDS = \[([^\]]*)\]/u.exec(
    contractsEvents,
  );
  expect(block, "contracts must declare TOOL_CARD_KINDS").not.toBeNull();
  return [...block![1]!.matchAll(/"([a-z]+)"/gu)].map((match) => match[1]!);
}

/** The kinds the `ToolCard` union actually carries. */
function unionKinds(): string[] {
  const start = contractsEvents.indexOf("export type ToolCard =");
  expect(start, "contracts must export the ToolCard union").toBeGreaterThan(-1);
  const end = contractsEvents.indexOf("\n};", start);
  const body = contractsEvents.slice(start, end);
  return [...body.matchAll(/kind: "([a-z]+)"/gu)].map((match) => match[1]!);
}

/** The renderer table's keys, in dispatch order. */
function rendererKeys(): string[] {
  const block =
    /const CARD_RENDERERS: CardRendererMap = \{([\s\S]*?)\n\};/u.exec(
      transcript,
    );
  expect(
    block,
    "transcript must dispatch through one CARD_RENDERERS table keyed by kind",
  ).not.toBeNull();
  return [...block![1]!.matchAll(/^\s{2}(\w+):/gmu)].map((match) => match[1]!);
}

/** The tool names the kit's own tables allow outside the dispatch surface. */
function allowedToolNames(): string[] {
  const names: string[] = [];
  const labels = /const TOOL_ROW_LABELS[^{]*\{([\s\S]*?)\n\};/u.exec(message);
  if (labels)
    names.push(
      ...[...labels[1]!.matchAll(/^\s{2}(?:"([a-z0-9_]+)"|([a-z0-9_]+)):/gmu)]
        .map((match) => match[1] ?? match[2]!)
        .filter(Boolean),
    );
  const keyed =
    /const KEYED_TOOLVIEW_NAMES: ReadonlySet<string> = new Set\(\[([\s\S]*?)\]\)/u.exec(
      message,
    );
  if (keyed)
    names.push(
      ...[...keyed[1]!.matchAll(/"([a-z0-9_]+)"/gu)].map((m) => m[1]!),
    );
  return names;
}

test("the card vocabulary and the decoder's kind list agree", () => {
  // A kind in the union that the decoder's list does not know would fail the
  // decode (an unknown kind reads as malformed) — the two must be one set.
  const kinds = contractKinds();
  expect(kinds.length).toBeGreaterThan(0);
  expect([...unionKinds()].sort()).toEqual([...kinds].sort());
});

test("every card kind has exactly one renderer (卡型完备)", () => {
  const keys = rendererKeys();
  expect(keys.slice().sort()).toEqual([...contractKinds()].sort());
  // And no kind is rendered twice: a duplicated key in a Record literal is a
  // compile error, but a second switch arm would not be — so the table is
  // the ONE dispatch, and it is counted.
  expect(new Set(keys).size).toBe(keys.length);
  // The dispatch is driven by the kind, not by a name: one table keyed by
  // the union's own discriminant, and a switch that hands each kind its
  // narrowed variant (a field that is not on that kind is a compile error).
  expect(transcript).toContain("const CARD_RENDERERS: CardRendererMap = {");
  expect(transcript).toContain("switch (card.kind)");
});

test("the framework's dispatch surface names no tool (框架无工具名)", () => {
  // The allowed sugar lives in message.ts; the dispatch (transcript.tsx)
  // must not reach for a tool name. Adding one here is how the kit would
  // drift back to per-tool special cases (the 2026-10-08 Q&A fight).
  const allowed = allowedToolNames();
  expect(allowed.length).toBeGreaterThan(0);
  const dispatch = transcript
    .split("\n")
    .filter((line) => !line.trimStart().startsWith("//"))
    .join("\n");
  for (const name of allowed)
    expect(
      dispatch.includes(`"${name}"`) || dispatch.includes(`'${name}'`),
      `transcript.tsx must not name the tool ${name}`,
    ).toBe(false);
});
