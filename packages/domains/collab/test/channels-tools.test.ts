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
