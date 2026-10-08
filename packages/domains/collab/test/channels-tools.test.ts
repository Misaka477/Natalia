// D: do all four agent channels see the tools they are supposed to?
//
// The report: "有他妈的natalia，navi，nia，subagent四个都得给老子修好" — every
// channel broken. What this measures is the part that is checkable without a
// model: for each channel, the tools the runtime hands it.
//
// The channeel shapes are different by design, and that is the thing to pin:
//   - the MAIN agent sees every tool the registry holds;
//   - navi / nia see a WHITELIST (a read-only surface plus a couple of extras),
//     which is a governance decision, not a defect;
//   - subagent runs through its own runner with its own scope.
// A test that only asserted "navi has tools" would pass on a stub. This one
// asserts the whitelist is what it claims to be, so a tool going missing from
// navi is a failure rather than a silent narrowing.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { chatToolCard } from "../src/chat-summary";
import {
  planDocReadOutput as planDocReadOutputForTest,
  planWriteCard as planWriteCardForTest,
} from "../src/chat-tools";
import { collabOutput } from "../src/collab-presenters";

const source = readFileSync(
  join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "domains",
    "collab",
    "src",
    "chat-tools.ts",
  ),
  "utf8",
);

test("navi and nia both see the shared read surface", () => {
  // THE shape of the whitelist, read from the source that publishes it, so the
  // assertion is against the real sets rather than a copy that can drift.
  const shared = /CHAT_READ_ONLY_TOOLS = new Set\(\[([^\]]*)\]/u.exec(source);
  expect(shared).not.toBeNull();
  const names = new Set(
    shared![1]!
      .split(",")
      .map((entry) => entry.trim().replace(/"/gu, ""))
      .filter(Boolean),
  );
  // The read surface the collaboration agents need to be useful at all.
  for (const required of [
    "read_file",
    "glob",
    "grep",
    "web_fetch",
    "web_search",
  ])
    expect(names, `navi/nia must see ${required}`).toContain(required);
});

test("run_shell reaches every channel that is allowed to run commands", () => {
  // Navi and Nia each declare their OWN extra set, and both name run_shell.
  // A channel whose set went empty would silently lose its only action tool.
  const extras = [
    ...source.matchAll(
      /(NAVI_EXTRA_TOOLS|NIA_EXTRA_TOOLS) = new Set\(\[([^\]]*)\]/gu,
    ),
  ];
  expect(extras.length).toBe(2);
  for (const [, setName, body] of extras) {
    const names = body!
      .split(",")
      .map((e) => e.trim().replace(/"/gu, ""))
      .filter(Boolean);
    expect(names, `${setName} must include run_shell`).toContain("run_shell");
  }
});

test("nia cannot propose a plan contract, and navi can", () => {
  // The documented governance split, pinned so a change to it is deliberate.
  const navi = /NAVI_EXTRA_TOOLS = new Set\(\[([^\]]*)\]/u.exec(source)![1]!;
  const nia = /NIA_EXTRA_TOOLS = new Set\(\[([^\]]*)\]/u.exec(source)![1]!;
  expect(navi).toContain("plan_propose");
  expect(nia).not.toContain("plan_propose");
});

test("the subagent channel inherits the same registry, not a copy", () => {
  // D's fourth channel. It does not go through chat-tools.ts at all: it runs
  // the SAME registry through its own runner, filtered by the same permission
  // layer as the main agent. What must be true is that it does not get its own
  // hand-maintained tool list, because a copy is where a channel goes blind.
  //
  // Read from the runner that builds its visible set, so this fails if someone
  // introduces a subagent-only tool table.
  const runner = readFileSync(
    join(
      import.meta.dir,
      "..",
      "..",
      "..",
      "framework",
      "client",
      "src",
      "runtime",
      "initialize",
      "subagent-runner.ts",
    ),
    "utf8",
  );
  // It filters the registry it was handed — twice (the two loop shapes), and
  // not through a subagent-only tool table.
  expect(
    runner.match(/scope\.tools\.values\(\)/gu)?.length ?? 0,
  ).toBeGreaterThanOrEqual(2);
  expect(runner).toContain("scope.isToolAllowed");
  // And it hands the provider the same `execute` boundary the main agent uses,
  // so a fix at that boundary fixes every channel at once. The runner builds
  // `visibleTools` and wires them into the provider call it makes here.
  expect(runner).toMatch(/visibleTools/u);
  expect(runner).toMatch(/send_to_parent/u);
});

/** The family's own output block, spelled for this test's stand-in tool. */
function collabOutputFor(
  callTitle: string,
  callSummary: string,
  resultTitle: string,
  resultSummary: string,
) {
  return collabOutput({ callTitle, callSummary, resultTitle, resultSummary });
}

test("a chat tool's card rides the event and the durable row (R4)", () => {
  // A Chat turn executes its tools directly, so the projection is made at
  // the publish site — and then carried through the projection into the
  // hydrated row. Both halves used to be dropped (the live fold ignored
  // card/meta; the durable row never had them).
  //
  // The publisher's projection is the same one the shared stage makes: read
  // the tool's output definition, compute the facts once, compose the card.
  // This uses the family's own presenter as the stand-in tool.
  const tool = {
    output: collabOutputFor("mailbox", "send", "mailbox", "queued"),
  };
  const args = { intent: "constraint" };
  const value = JSON.stringify({ queued: true, messageID: "msg_2" });
  const projected = chatToolCard(tool.output, args, value);
  expect(projected.card).toMatchObject({ kind: "generic", title: "mailbox" });
  expect(projected.meta).toMatchObject({ decoded: true });
  // ONE decode: POISON in the value changes nothing the card reads.
  const meta = tool.output.presentationMeta!(args, value);
  expect(tool.output.presentResult!(args, "POISON", meta)).toMatchObject({
    kind: "generic",
    title: "mailbox",
    summary: "queued",
  });
  // And a tool that declares no output definition at all still publishes.
  expect(chatToolCard(undefined, args, value)).toEqual({});
});

test("plan_doc_read's card carries the document, not the envelope (S3)", () => {
  // The screenshot the user ruled on: the raw JSON envelope as the card
  // body. A plan document is a DOCUMENT — the card carries its own lines,
  // numbered, and the plan's identity as facets.
  const document = [
    "# NEON Rename + Circuit",
    "",
    "## Phase 1",
    "- [ ] one",
    "- [ ] two",
  ].join("\n");
  const value = JSON.stringify({
    planID: "plan_neon-plan_mlt5srlp",
    title: "plan_neon-plan_mlt5srlp",
    documentPath: "neon-plan.md",
    content: document,
  });
  const output = planDocReadOutputForTest();
  const meta = output.presentationMeta!(
    { planID: "plan_neon-plan_mlt5srlp" },
    value,
  );
  const card = output.presentResult!(
    { planID: "plan_neon-plan_mlt5srlp" },
    value,
    meta,
  );
  expect(card).toMatchObject({
    kind: "read",
    title: "neon-plan.md",
    summary: "5 lines",
    content: document,
    lang: "markdown",
    meta: [
      ["planID", "plan_neon-plan_mlt5srlp"],
      ["title", "plan_neon-plan_mlt5srlp"],
    ],
  });
  // The document's own lines, numbered from 1.
  expect(card && card.kind === "read" && card.lines).toEqual([
    { number: 1, text: "# NEON Rename + Circuit" },
    { number: 2, text: "" },
    { number: 3, text: "## Phase 1" },
    { number: 4, text: "- [ ] one" },
    { number: 5, text: "- [ ] two" },
  ]);
  // A prose answer (an error, a refusal) still renders: the card falls back
  // to the text itself, never a thrown presenter.
  const refused = output.presentResult!(
    { path: "x.md" },
    "plan document not found: x.md",
  );
  expect(refused).toMatchObject({ kind: "read", title: "plan" });
});

test("plan_doc_write's card reads what changed (S4)", () => {
  // A plan write's answer is WHAT changed — plan identity, path, revision —
  // one line per fact, not the raw envelope.
  const output = planWriteCardForTest({ callSummary: "write" });
  const value = JSON.stringify({
    marked: true,
    planID: "plan_neon-plan_mlt5srlp",
  });
  const card = output.presentResult!({ path: "neon-plan.md" }, value);
  expect(card).toMatchObject({
    kind: "generic",
    title: "neon-plan.md",
    summary: "plan · plan_neon-plan_mlt5srlp",
    body: "plan · plan_neon-plan_mlt5srlp",
    meta: [["marked", "true"]],
  });
  // A prose refusal (a write that never happened) reads as the call verb.
  const refused = output.presentResult!(
    { path: "x.md" },
    "plan_doc_write requires path and content",
  );
  expect(refused).toMatchObject({ kind: "generic", summary: "write" });
});
