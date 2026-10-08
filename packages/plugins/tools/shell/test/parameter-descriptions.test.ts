import { expect, test } from "bun:test";
import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * The parameter-description guard, over every model-facing tool the repo ships.
 *
 * The rule, learned from a whole tool catalogue (33 files, 40+
 * tools): a tool's parameters carry a description on EVERY key, because the
 * description is what the model reads when it decides how to call. An
 * undescribed parameter is a coin flip: the model guesses its semantics from
 * its name, and guesses wrong often enough to matter (`maxBytes` — bytes of
 * what? `path` — relative to what? `id` — mine to choose or assigned?).
 *
 * The one deliberate exception is the `description` parameter itself, whose
 * own description already names its contract on the three tools that declare
 * it (run_shell, process_start, agent_spawn/agent_message).
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
] as const;

const REPO_ROOT = join(import.meta.dir, "..", "..", "..", "..", "..");

interface ToolParam {
  tool: string;
  key: string;
  described: boolean;
  file: string;
}

/** Pulls each tool's parameter keys out of its `parameters: { properties: ... }` block. */
async function collectParams(
  file: string,
): Promise<Array<{ tool: string; key: string; described: boolean }>> {
  const text = await Bun.file(file).text();
  const out: Array<{ tool: string; key: string; described: boolean }> = [];
  // Each tool definition starts at `name: "<tool>"`.
  const nameRe = /name: "([a-z_]+)",\n\s+description:/g;
  let match: RegExpExecArray | null;
  while ((match = nameRe.exec(text)) !== null) {
    const tool = match[1];
    const from = match.index;
    // The PARAMETERS block, not the output schema: `output.schema` describes
    // the result's shape, and its fields are not parameters a model chooses.
    // Cutting at the `output:` key (or the next tool) keeps the sweep honest.
    const paramsStart = text.indexOf("parameters:", from);
    if (paramsStart < 0) continue;
    const propsStart = text.indexOf("properties:", paramsStart);
    if (propsStart < 0) continue;
    const nextBoundary = Math.min(
      ...[
        text.indexOf("output:", propsStart),
        text.indexOf('name: "', propsStart),
      ].filter((at) => at >= 0),
      text.length,
    );
    const body = text.slice(propsStart, nextBoundary);
    // Top-level parameter keys sit at the parameters block's own indentation;
    // a nested schema's keys (an array's `items`, an object's fields) are
    // deeper and are NOT parameters a model chooses, so they are out of scope
    // for this rule — the rule is about what the model must decide.
    const propsIndent = /\n(\s*)properties:\s*\{/.exec(
      text.slice(paramsStart, paramsStart + 200),
    );
    // The parameters' own keys sit exactly TWO spaces deeper than the
    // `properties:` line; anything deeper is a nested schema and out of scope.
    const baseIndent = propsIndent ? propsIndent[1].length + 2 : 8;
    const keyRe = new RegExp(`^ {${baseIndent}}(\\w+):\\s*\\{`, "gm");
    let key: RegExpExecArray | null;
    while ((key = keyRe.exec(body)) !== null) {
      // The key's own object: from its brace to the matching one.
      const start = key.index + key[0].length - 1;
      let depth = 0;
      let end = start;
      for (; end < body.length; end += 1) {
        if (body[end] === "{") depth += 1;
        else if (body[end] === "}") {
          depth -= 1;
          if (depth === 0) break;
        }
      }
      const declared = body.slice(start, end + 1);
      // A description in any quote style the repo uses (a template literal for
      // one that names a constant), and across any wrap.
      out.push({
        tool,
        key: key[1],
        described: /description:\s*\n?\s*["'`]/.test(declared),
      });
    }
  }
  return out;
}

test("every model-facing tool describes every parameter", async () => {
  const params: ToolParam[] = [];
  for (const dir of TOOL_DIRS) {
    const absolute = join(REPO_ROOT, dir);
    for (const entry of await readdir(absolute)) {
      if (!entry.endsWith("-tools.ts")) continue;
      for (const found of await collectParams(join(absolute, entry)))
        params.push({ ...found, file: `${dir}/${entry}` });
    }
  }
  // Sanity: the sweep must actually see the catalogue, not an empty tree.
  expect(params.length).toBeGreaterThan(40);
  const undescribed = params.filter(
    (param) => !param.described && param.key !== "description",
  );
  expect(
    undescribed.map((param) => `${param.file}: ${param.tool}.${param.key}`),
    // An undescribed parameter is a coin flip for the model: `maxBytes` (bytes
    // of what?), `path` (relative to what?), `id` (mine to choose?). The
    // description IS the parameter's semantics.
  ).toEqual([]);
});

test("the sweep really inspects the tool catalogue it claims to", async () => {
  // A guard that reads no files passes vacuously; pin the tools it must see.
  const seen = new Set<string>();
  for (const dir of TOOL_DIRS) {
    const absolute = join(REPO_ROOT, dir);
    for (const entry of await readdir(absolute)) {
      if (!entry.endsWith("-tools.ts")) continue;
      for (const found of await collectParams(join(absolute, entry)))
        seen.add(found.tool);
    }
  }
  for (const tool of [
    "run_shell",
    "read_file",
    "write_file",
    "edit_file",
    "glob",
    "grep",
    "web_fetch",
    "web_search",
    "todo_read",
    "todo_write",
    "process_start",
    "ask_user",
  ])
    expect(seen.has(tool), `${tool} was not inspected`).toBe(true);
});
