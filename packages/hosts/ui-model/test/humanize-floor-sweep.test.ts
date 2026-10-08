import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { readFileSync, readdirSync } from "node:fs";
import { resolve } from "node:path";
import { join } from "node:path";
import { humanizeToolResult, resultView } from "../src";

/**
 * The P0 floor's sweep (presentation plan P0.4): every model-facing tool
 * that answers with `JSON.stringify` and declares NO presenter must still
 * read as flattened text, because the generic row shows exactly what
 * resultView's preview holds. The sweep names each such tool and pins the
 * flatten on a representative JSON document — a new presenter-less JSON
 * tool is covered the moment it lands, and the floor cannot silently
 * regress to raw JSON in the UI.
 *
 * The tool dirs mirror the parameter-descriptions guard's list (same
 * families, same single source): every model-facing built-in surface.
 */

const TOOL_DIRS = [
  "packages/plugins/tools/ask/src",
  "packages/plugins/tools/fs-read/src",
  "packages/plugins/tools/fs-write/src",
  "packages/plugins/tools/process/src",
  "packages/plugins/tools/search/src",
  "packages/plugins/tools/shell/src",
  "packages/plugins/tools/todo/src",
  "packages/plugins/tools/web/src",
  "packages/plugins/browser/src",
  "packages/plugins/team/src",
  "packages/plugins/skills/src",
  "packages/domains/collab/src",
  "packages/framework/client/src/runtime",
] as const;

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..");

/**
 * Every way a tool declares its projection — the ONE detector both halves of
 * this sweep use. The floor's presenter check used to be a narrower regex
 * than the completeness sweep's marker list, so a tool wired through a
 * factory (`genericToolCard`, `collabOutput`) was counted as presenter-less
 * by one guard and wired by the other. Two detectors, one rule:
 *
 *   1. an inline `presentCall`/`presentResult` in the tool's block, or a
 *      factory the repo has used (the explicit marker list);
 *   2. a DELEGATED output block — `output: someFactory(...)` — which is how
 *      a family ships one projection for all its tools (R1's
 *      `processToolCard`, R2's `readFileOutput`). The convention is that
 *      such a factory declares the projection; a family that delegates to
 *      something which does not would be lying in its own name.
 */
const PRESENTER_MARKERS = [
  "presentCall",
  "collabOutput(",
  "terminalReadCard",
  "terminalInputCard",
  "genericToolCard(",
  // Family factories that declare the projection for their tools (R1's
  // process family, the template the others copy). A new factory needs no
  // entry here — rule 2 above covers it — but the ones a reader greps for
  // stay named.
  "processToolCard(",
] as const;

/** `output: <factory>(` — the family-factory spelling. */
const DELEGATED_OUTPUT = /output:\s*[a-zA-Z_$][\w$]*\(/u;

function declaresProjection(body: string): boolean {
  return (
    PRESENTER_MARKERS.some((marker) => body.includes(marker)) ||
    DELEGATED_OUTPUT.test(body)
  );
}

/** A representative JSON document a presenter-less tool might return. */
const SAMPLE = JSON.stringify({
  id: "probe_1",
  status: "running",
  paths: ["a.ts", "b.ts"],
  nested: { root: "/tmp/x", count: 2 },
});

type ToolFacts = {
  tool: string;
  file: string;
  returnsJSON: boolean;
  hasPresenter: boolean;
};

async function collectTools(
  file: string,
  relative: string,
): Promise<ToolFacts[]> {
  const text = await Bun.file(file).text();
  const out: ToolFacts[] = [];
  // Each tool definition starts at `name: "<tool>"`.
  const nameRe = /name: "([a-z_]+)",\n\s+description:/g;
  let match: RegExpExecArray | null;
  while ((match = nameRe.exec(text)) !== null) {
    const from = match.index;
    const nextName = text.indexOf('name: "', from + 1);
    const body = text.slice(from, nextName === -1 ? text.length : nextName);
    out.push({
      tool: match[1]!,
      file: relative,
      returnsJSON: /JSON\.stringify/.test(body),
      // A presenter is the output definition's presentCall/presentResult —
      // or a family factory that declares them for the tool (R1's
      // `processToolCard`, the shape the later families copy). Its absence
      // in this tool's block is the floor's case.
      hasPresenter: declaresProjection(body),
    });
  }
  return out;
}

test("no JSON-returning tool reaches the floor without a card (R1)", async () => {
  // The floor used to be a BUCKET this sweep proved readable: the tools with
  // no presenter fell back to the flatten, and the sweep named each of them
  // (record_decision, plan_pause, work_graph_query — pinned here for weeks).
  // R1 unified the two detector lists (the floor's presenter check had been
  // NARROWER than the completeness sweep's: it never saw the card factories,
  // so factory-wired tools were counted as presenter-less), and the bucket
  // is EMPTY — every JSON-returning tool in these dirs declares a card.
  //
  // So the guard inverts: a presenter-less JSON tool is now a FAILURE the
  // day it lands, not a member of a list. The flatten machinery is still
  // pinned below, on a synthetic tool: the fallback must READ correctly for
  // whoever lands without a card until the sweep catches them.
  const tools: ToolFacts[] = [];
  for (const dir of TOOL_DIRS) {
    const absolute = join(REPO_ROOT, dir);
    for (const entry of await readdir(absolute)) {
      if (
        !entry.endsWith("-tools.ts") &&
        !entry.endsWith("-tool.ts") &&
        entry !== "tools.ts"
      )
        continue;
      for (const found of await collectTools(
        join(absolute, entry),
        `${dir}/${entry}`,
      ))
        tools.push(found);
    }
  }
  const presenterlessJSON = tools.filter(
    (tool) => tool.returnsJSON && !tool.hasPresenter,
  );
  expect(
    presenterlessJSON.map((tool) => `${tool.file}: ${tool.tool}`),
    "a JSON-returning tool landed without a card — its result would show " +
      "raw JSON on the row; give it a presenter (or a family factory)",
  ).toEqual([]);
  // Anti-vacuity the other way round: the sweep must actually SEE the
  // surface (every tool in the dirs, not zero tools).
  expect(tools.length).toBeGreaterThan(50);
  // The floor, pinned on a synthetic presenter-less tool so the machinery
  // cannot rot while nobody uses it.
  for (const name of ["tool_without_a_card", "process_output"]) {
    const flattened = humanizeToolResult(SAMPLE, name);
    expect(flattened, name).not.toBe(SAMPLE);
    const view = resultView(SAMPLE, 8, 1200, { name });
    expect(view.preview, name).not.toBe(SAMPLE);
    expect(view.preview, name).toContain("id: probe_1");
    // And it is a READING, not a JSON dump with the punctuation swapped:
    // no raw-document markers survive anywhere in the preview (the user's
    // 2026-10-07 verdict — "拍扁就以为不是 json 是吧").
    expect(view.preview, name).not.toContain('{"');
    expect(view.preview, name).not.toContain('":');
    expect(view.preview, name).not.toContain('",');
  }
  // The same shape law over EVERY envelope the catalogue can answer with,
  // not only the pinned sample: an array of records renders one per line.
  const envelope = JSON.stringify({
    data: [
      { id: "a", kind: "x" },
      { id: "b", kind: "y" },
    ],
    total: 2,
  });
  for (const tool of presenterlessJSON) {
    const rendered = humanizeToolResult(envelope, tool.tool);
    const lines = rendered.split("\n");
    expect(lines[0], `${tool.tool}`).toBe("data:");
    expect(lines[1]?.startsWith("  · "), `${tool.tool}: ${lines[1]}`).toBe(
      true,
    );
    expect(lines[2]?.startsWith("  · "), `${tool.tool}: ${lines[2]}`).toBe(
      true,
    );
    expect(lines).toContain("total: 2");
  }
});

test("every transcript host routes its tool rows through the kit's toolCallRow", () => {
  // The P0 hole the user caught: the transcript's tool rows were built by
  // each host itself — app-neu had a local flatten, and agent-panel/
  // nia-panel passed `tool.result` RAW into the card. The presentation is
  // now ONE function in the kit (`toolCallRow`), which derives the row's
  // summary from the result and hands the raw result to the kit's
  // presenters — so a replayed event renders exactly like a live one.
  // This guard keeps the hosts out of the presentation business.
  const hosts = [
    "packages/plugins/ui/web/src/app-neu.tsx",
    "packages/plugins/ui/web/src/agent-panel.tsx",
    "packages/plugins/ui/web/src/nia-panel.tsx",
  ];
  const repoRoot = join(import.meta.dir, "../../../..");
  for (const host of hosts) {
    const source = readFileSync(join(repoRoot, host), "utf8");
    // The row model comes from the kit.
    const usesRow =
      /import\s*\{[^}]*\btoolCallRow\b[^}]*\}\s*from\s*"@natalia\/ui-kit"/s.test(
        source,
      );
    expect(usesRow, `${host} must build rows via toolCallRow`).toBe(true);
    expect(source.includes("toolCallRow(tool)")).toBe(true);
    // No host hand-builds a tool row or pre-flattens the result.
    expect(
      source.includes("output: tool.result"),
      `${host} must not pass a raw tool result into a hand-built card`,
    ).toBe(false);
    expect(
      source.includes("output: humanizeToolResult("),
      `${host} must not pre-flatten the result itself`,
    ).toBe(false);
  }
  // R5.5: the flatten lives in the contracts leaf and the RUNTIME is the
  // publisher of the floor — a presenter-less tool's default card carries
  // it, so the reading is produced where the data is. The kit renders that
  // body and parses nothing (R6 deletes its last flatten call).
  const bodySource = readFileSync(
    join(repoRoot, "packages/core/contracts/src/tool-body.ts"),
    "utf8",
  );
  expect(bodySource).toContain("export function toolResultBody");
  expect(bodySource).not.toContain("SPECIAL_CASES");
  // The runtime never publishes a raw prefix as a summary again.
  const runtimeSource = readFileSync(
    join(
      repoRoot,
      "packages/framework/client/src/runtime/tool-execution/execute-run.ts",
    ),
    "utf8",
  );
  expect(
    runtimeSource.includes("toolResultSummary(result, projectedRender)"),
  ).toBe(true);
  const subagentSource = readFileSync(
    join(
      repoRoot,
      "packages/framework/client/src/runtime/initialize/subagent-tools.ts",
    ),
    "utf8",
  );
  expect(subagentSource.includes("summary: result.slice(0, 200)")).toBe(false);
});

test("every tool.update publisher fills the structured slots (R0)", () => {
  // The card and its meta are the event's own fields now (UI refactor R0):
  // a publisher that still stuffed the card into `metadata.render` would
  // leave every consumer decoding a blob that no longer travels. There are
  // exactly two publishers — the main path (execute-run: the call card while
  // running, the result card once settled) and the subagent channel — and
  // this pins both, the way the 2026-10-07 summary slice was pinned (a
  // subagent publisher was missed once already).
  const repoRoot = join(import.meta.dir, "../../../..");
  const runtimeSource = readFileSync(
    join(
      repoRoot,
      "packages/framework/client/src/runtime/tool-execution/execute-run.ts",
    ),
    "utf8",
  );
  const subagentSource = readFileSync(
    join(
      repoRoot,
      "packages/framework/client/src/runtime/initialize/subagent-tools.ts",
    ),
    "utf8",
  );
  for (const [where, source] of [
    ["execute-run", runtimeSource],
    ["subagent-tools", subagentSource],
  ] as const) {
    // R5.5: the card slot is ALWAYS filled — the tool's own card when it
    // declared a presenter, the runtime's default projection otherwise.
    expect(
      source.includes(
        "card: projectedRender ?? defaultToolCard(tool.name, result)",
      ),
      `${where} must publish the result card on the event's card slot`,
    ).toBe(true);
    expect(
      source.includes("...(projectedMeta ? { meta: projectedMeta } : {})"),
      `${where} must publish presentationMeta on the event's meta slot`,
    ).toBe(true);
    // And the facts are computed FIRST, then handed to the presenter
    // (R1): `presentResult(args, result, projectedMeta)` — a card composed
    // from the facts rather than the result text parsed a second time.
    expect(
      /presentResult\?\.\(\s*[\s\S]{0,200}?projectedMeta/u.test(source),
      `${where} must hand the computed facts to presentResult`,
    ).toBe(true);
    // And the legacy blob is gone from the publisher side: a client still
    // READS it (an old event carries it), but nothing writes it anymore.
    expect(
      source.includes("render: projectedRender"),
      `${where} must not publish the card as a metadata blob`,
    ).toBe(false);
  }
  // The running phase publishes the tool's own call card.
  expect(
    runtimeSource.includes("...(projectedCall ? { card: projectedCall } : {})"),
  ).toBe(true);
  expect(runtimeSource.includes("metadata: { call:")).toBe(false);
});

test("every model-facing tool projects a card (the 2026-10-07 completeness sweep)", () => {
  // The user's report: "绝大多数的工具返回是 json 数据而不是按可读的那种
  // 返回". The row's summary is now derived from the result, and the tools
  // that were answering with a bare envelope were wired to the generic card
  // factory one by one (context/work-graph/generation/record/goal/plan/
  // process/todo). This sweep keeps the surface honest: a NEW tool without
  // a presenter fails here the day it lands.
  // The `*` is expanded HERE, not by resolve(): a literal `*` in a path
  // makes readdirSync throw ENOENT, the catch below skips the directory, and
  // every tool family under plugins/tools silently leaves the sweep — which
  // is exactly how this guard stopped covering read_file in R2.
  const repoRoot = join(import.meta.dir, "../../../..");
  const toolFamilies = readdirSync(join(repoRoot, "packages/plugins/tools"), {
    withFileTypes: true,
  })
    .filter((entry) => entry.isDirectory())
    .map((entry) => `packages/plugins/tools/${entry.name}/src`);
  const toolDirGlobs = [
    ...toolFamilies,
    "packages/plugins/browser/src",
    "packages/plugins/team/src",
    "packages/plugins/skills/src",
    "packages/plugins/native-terminal/src",
    "packages/framework/client/src/runtime",
    "packages/domains/collab/src",
    "packages/domains/goal-runtime/src",
  ];
  const unwired: string[] = [];
  for (const dir of toolDirGlobs) {
    const base = resolve(repoRoot, dir);
    let files: string[] = [];
    try {
      files = readdirSync(base)
        .filter((name) => name.endsWith(".ts") && !name.includes(".test."))
        .map((name) => join(base, name));
    } catch {
      continue;
    }
    for (const file of files) {
      const source = readFileSync(file, "utf8");
      const re = /name: "([a-z_]+)",\n\s+description:/g;
      let match: RegExpExecArray | null;
      while ((match = re.exec(source)) !== null) {
        const next = source.indexOf('name: "', match.index + 10);
        const body = source.slice(
          match.index + match[0].length,
          next === -1 ? source.length : next,
        );
        const wired = declaresProjection(body);
        if (!wired) unwired.push(`${file.split("packages/")[1]}: ${match[1]}`);
      }
    }
  }
  expect(
    unwired,
    `model-facing tools without a presenter: ${unwired.join(", ")}`,
  ).toEqual([]);
});

test("an envelope's records render one per line, never inlined (user 2026-10-07)", () => {
  // The four tools from the user's screenshot — context_search,
  // work_graph_query, list_generation_candidates, context_pack — all
  // answer with `{ <array>: [...], ... }`, and the old flatten inlined the
  // array onto the key's line: `data: [{a=1}, {b=2}]` — a JSON dump with
  // the punctuation swapped. A reader scans one record per line now.
  const search = humanizeToolResult(
    JSON.stringify({
      data: [
        { id: "ses:1", recordType: "evidence", score: 0.34 },
        { id: "ses:2", recordType: "decision", score: 0.31 },
      ],
      total: 3,
    }),
    "context_search",
  );
  const lines = search.split("\n");
  expect(lines[0]).toBe("data:");
  expect(lines[1]).toBe("  · id=ses:1, recordType=evidence, score=0.34");
  expect(lines[2]).toBe("  · id=ses:2, recordType=decision, score=0.31");
  expect(lines[3]).toBe("total: 3");
  // An empty envelope reads as an answer, not as `[]`.
  expect(
    humanizeToolResult(
      JSON.stringify({ candidates: [] }),
      "list_generation_candidates",
    ),
  ).toBe("candidates: (none)");
});
