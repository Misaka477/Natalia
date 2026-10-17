/**
 * Every agent runs the SAME tool-result gate.
 *
 * Measured defect this pins: the runtime has one result bound —
 * `boundToolOutput` (50 KB, spilling the full text to
 * `<workspace>/.natalia/tool-output/` and handing the model page 1 with the
 * marker naming the next page) — and the main agent's path applies it. The
 * other agent paths executed their tools DIRECTLY and bypassed it: a Navi chat
 * turn put a 1,513,973-character `read_file` result into one provider request,
 * which was refused with "The input you provided is invalid" and killed the
 * turn at 486k tokens, while the main agent's identical reads were being
 * spilled and paged.
 *
 * The five surfaces and their execution sites:
 *
 *   natalia   tool-execution/execute-run.ts          (the gate's home)
 *   navi      domains/collab/chat-turn-navi.ts        (direct execute)
 *   nia       domains/collab/chat-turn-nia.ts         (direct execute)
 *   subagent  initialize/subagent-tools.ts            (direct execute)
 *   team      the main loop, via the directive injected into the main context
 *
 * A new agent surface must reach the same bound, so this guard reads each
 * execution site and fails when one of them executes a tool without it. The
 * alternative — a per-surface bound — is how the hole opened.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const repo = join(import.meta.dir, "..", "..", "..");

async function source(...segments: string[]): Promise<string> {
  return await Bun.file(join(repo, ...segments)).text();
}

/** The execution site of one agent surface: the call and the gate beside it. */
async function site(
  path: string[],
  call: string,
  gate: string,
): Promise<void> {
  const text = await source(...path);
  const at = text.indexOf(call);
  expect(at, `${path.join("/")} executes tools at ${call}`).toBeGreaterThan(0);
  // The gate must be in the same function, not merely in the same file: the
  // bypassed paths each had a `redactToolOutput` beside the call and no bound.
  const body = text.slice(Math.max(0, at - 4000), at + 4000);
  expect(
    body.includes(gate),
    `${path.join("/")} must bound its tool result with ${gate}`,
  ).toBe(true);
}

test("natalia's own path is the gate's home", async () => {
  const text = await source(
    "framework",
    "client",
    "src",
    "runtime",
    "tool-execution",
    "execute-run.ts",
  );
  const at = text.indexOf("const bounded = await boundToolOutput(");
  expect(at).toBeGreaterThan(0);
  // The bound wraps the redacted, finalized content — the order the other
  // surfaces now copy.
  expect(text.slice(at, at + 260)).toContain("redactToolOutput(finalizedContent");
});

test("navi's chat turn runs the same bound", async () => {
  await site(
    ["domains", "collab", "src", "chat-turn-navi.ts"],
    "result = await tool.execute(parsed, {",
    "boundToolOutput(",
  );
});

test("nia's chat turn runs the same bound", async () => {
  await site(
    ["domains", "collab", "src", "chat-turn-nia.ts"],
    "result = await tool.execute(parsed, {",
    "boundToolOutput(",
  );
});

test("a subagent's tool call runs the same bound", async () => {
  await site(
    ["framework", "client", "src", "runtime", "initialize", "subagent-tools.ts"],
    "const completeResult = await tool.execute(parsed, {",
    "boundToolOutput(",
  );
});

/*
 * KNOWN FIXTURE DEBT (recorded, not hidden): the compaction fixture in
 * real-runtime-d.test.ts ("subagent compaction uses its active provider and
 * stays in the child lifecycle") built its ledger volume from ONE unbounded
 * `read_file` of a 168 KB file, which cleared its 85% threshold. With the gate
 * applied the child's read returns page 1 (measured: 50,422 characters), so the
 * preflight no longer triggers and the test times out.
 *
 * The fix is to build the fixture's volume THROUGH the gate — four DISTINCT
 * files, because identical calls are what the runtime's repeat guard blocks.
 * Attempted and reverted: with the volume actually crossing the threshold the
 * compaction fires, and the scripted child then stops matching its own branch
 * (the compacted summary no longer carries the task text the harness keys on),
 * so the run diverges instead of completing. That harness change is its own
 * piece of work: the child must be identified by its system prompt alone, which
 * is the one fact compaction cannot rewrite.
 */

test("team runs on the main loop, so it inherits the gate", async () => {
  // Team mode injects its directive into the MAIN context; it has no tool
  // execution of its own. If that ever changes, this test is where the new
  // surface is added to the table above.
  const admission = await source(
    "framework",
    "client",
    "src",
    "runtime",
    "session-admission.ts",
  );
  expect(admission).toContain("activeTeamBehavior.directive()");
  const direct = admission.indexOf("tool.execute(");
  expect(direct).toBe(-1);
});

test("no other surface executes a tool directly", async () => {
  // The registry of direct execution sites. A new one is either a new agent
  // surface (add it to the table and give it the gate) or a tool wrapper that
  // delegates to an already-gated path. Walked rather than read as one file:
  // the runtime is a directory tree, and a second site hiding in a sibling
  // module is exactly what this guard exists to catch.
  const { readdir } = await import("node:fs/promises");
  const { join: joinPath } = await import("node:path");
  const root = joinPath(repo, "framework", "client", "src", "runtime");
  const files: string[] = [];
  async function walk(dir: string): Promise<void> {
    for (const entry of await readdir(dir, { withFileTypes: true })) {
      const full = joinPath(dir, entry.name);
      if (entry.isDirectory()) await walk(full);
      else if (entry.name.endsWith(".ts")) files.push(full);
    }
  }
  await walk(root);
  const sites: string[] = [];
  for (const file of files) {
    const text = await Bun.file(file).text();
    for (const _ of text.matchAll(/await tool\.execute\(/gu))
      sites.push(file.slice(repo.length + 1));
  }
  expect(sites.map((site) => site.replaceAll("\\", "/"))).toEqual([
    "framework/client/src/runtime/initialize/subagent-tools.ts",
  ]);
});
