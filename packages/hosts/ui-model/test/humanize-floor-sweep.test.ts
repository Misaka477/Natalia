import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { readFileSync } from "node:fs";
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
      // A presenter is the output definition's presentCall/presentResult;
      // its absence in this tool's block is the floor's case.
      hasPresenter: /present(?:Call|Result)\s*[:(]/.test(body),
    });
  }
  return out;
}

test("every presenter-less JSON tool's result is flattened, never raw", async () => {
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
  // Anti-vacuity: the sweep must actually see the surface it claims.
  expect(presenterlessJSON.length).toBeGreaterThan(20);
  // Pinned members: known presenter-less JSON tools the plan listed. (The
  // families P1 wired — collab/terminal/browser/mcp/team/skills/process —
  // correctly left this set; the record tools and the work-graph read are
  // what the floor still carries.)
  for (const name of ["record_decision", "plan_pause", "work_graph_query"])
    expect(
      presenterlessJSON.some((tool) => tool.tool === name),
      `${name} was not swept`,
    ).toBe(true);
  // The floor: the flatten changes the JSON, and resultView's preview is
  // the flattened text (what the generic row shows).
  for (const tool of presenterlessJSON) {
    const flattened = humanizeToolResult(SAMPLE, tool.tool);
    expect(flattened, `${tool.file}: ${tool.tool}`).not.toBe(SAMPLE);
    const view = resultView(SAMPLE, 8, 1200, { name: tool.tool });
    expect(view.preview, `${tool.file}: ${tool.tool}`).not.toBe(SAMPLE);
    expect(view.preview).toContain("id: probe_1");
  }
});

test("every transcript host flattens tool output through the model layer", () => {
  // The P0 hole the user caught: the model layer's flattener covered the
  // panels' OTHER paths but the transcript's tool rows were built by each
  // host itself — app-neu had a local flatten, and agent-panel/nia-panel
  // passed `tool.result` RAW into the card, which is where the raw JSON in
  // the UI came from. The flatten now lives in exactly one place
  // (humanizeToolResult) and every host calls it. This guard reads the
  // sources so the hole cannot reopen quietly.
  const hosts = [
    "packages/plugins/ui/web/src/app-neu.tsx",
    "packages/plugins/ui/web/src/agent-panel.tsx",
    "packages/plugins/ui/web/src/nia-panel.tsx",
  ];
  const repoRoot = join(import.meta.dir, "../../../..");
  for (const host of hosts) {
    const source = readFileSync(join(repoRoot, host), "utf8");
    // The import may be merged with other ui-model names, so match on the
    // binding appearing in an import statement from that module.
    const importsHumanize =
      /import\s*\{[^}]*\bhumanizeToolResult\b[^}]*\}\s*from\s*"@natalia\/ui-model"/s.test(
        source,
      );
    expect(importsHumanize, `${host} must import the flattener`).toBe(true);
    expect(
      source.includes("output: tool.result ?? tool.summary,"),
      `${host} must not pass a raw tool result into the card`,
    ).toBe(false);
    expect(
      source.includes("humanizeToolResult("),
      `${host} must flatten through humanizeToolResult`,
    ).toBe(true);
  }
});
