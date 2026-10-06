import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
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
  // Pinned members: known presenter-less JSON tools the plan listed.
  for (const name of [
    "browser_tabs",
    "team_fanout",
    "record_decision",
    "plan_pause",
  ])
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
