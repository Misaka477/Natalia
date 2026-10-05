// THE bug this pins: the model sent the tool's OUTPUT back as its INPUT.
//
// Measured in the user's own transcript:
//   glob {"paths":[],"truncated":true,"nextCursor":"eyJ2..."}
//         ^^^^^ outputs            ^^^^^^^^^^ output
// The input schema declared four bare `{type: "string"}` properties with NO
// descriptions, so the model had nothing telling it that `cursor` is an opaque
// token it must copy verbatim, that the FIRST call must omit it, or that
// `paths`/`truncated`/`matches` are outputs and not arguments at all.
//
// A tool's description and its per-property descriptions ARE the product
// surface the model reads. If the model uses a tool wrong, that surface is
// wrong — which is what this file asserts.
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const source = readFileSync(
  join(import.meta.dir, "..", "src", "search-tools.ts"),
  "utf8",
);

/** Every `name: { type: ... }` property block inside a parameters object. */
function propertiesOf(toolName: string): string[] {
  const start = source.indexOf(`name: "${toolName}"`);
  expect(start, `${toolName} must exist`).toBeGreaterThan(-1);
  const paramsAt = source.indexOf("parameters: {", start);
  expect(paramsAt, `${toolName} must declare parameters`).toBeGreaterThan(-1);
  const block = source.slice(paramsAt, paramsAt + 6000);
  // Only the properties INSIDE `properties: {}` — `properties: {` itself and
  // `type:`/`required:`/`additionalProperties:` sit at the same indentation and
  // were being picked up as if they were tool arguments (measured: the first
  // run reported "glob.properties has no description").
  const propsAt = block.indexOf("properties: {");
  expect(propsAt, `${toolName} must declare properties`).toBeGreaterThan(-1);
  // Stop at the OUTPUT schema, whose `properties: {` sits at the SAME eight
  // spaces (output.schema is nested one level deeper) and was being swept in as
  // if it were an input argument — measured: "glob.properties has no description".
  const outputAt = block.indexOf("    output: {", propsAt);
  const afterProps = block.slice(
    propsAt,
    outputAt > propsAt ? outputAt : propsAt + 3000,
  );
  return [...afterProps.matchAll(/^\s{8}(\w+): \{\s*$/gmu)].map((m) => m[1]!);
}

for (const tool of ["glob", "grep"] as const) {
  test(`${tool}: every input property carries a description`, () => {
    const props = propertiesOf(tool);
    expect(props.length).toBeGreaterThan(0);
    // The cursor is the one that bit us; the rest matter just as much.
    expect(props).toContain("pattern");
    expect(props).toContain("cursor");
    // Each property block must contain a description key. Read the block that
    // follows the property name rather than counting, so a property whose
    // description is missing fails on its own.
    for (const prop of props) {
      const at = source.indexOf(
        `        ${prop}: {`,
        source.indexOf(`name: "${tool}"`),
      );
      const block = source.slice(at, source.indexOf("        },", at));
      expect(
        block.includes("description:"),
        `${tool}.${prop} has no description — the model cannot know what to pass`,
      ).toBe(true);
    }
  });

  test(`${tool}: the description says the cursor is opaque and omitted first`, () => {
    const at = source.indexOf(`name: "${tool}"`);
    // The WHOLE tool block, not just the top-level description: the cursor's
    // "VERBATIM" wording lives in its property description, which sits after
    // `parameters`. Slicing only to `requiresApproval` checked half the surface.
    const end = source.indexOf("async execute", at);
    const block = source.slice(at, end > at ? end : at + 6000);
    // THE three facts the model needed and did not have.
    expect(block, `${tool} must say the cursor is opaque`).toContain("OPAQUE");
    expect(
      block,
      `${tool} must say to omit the cursor on the first call`,
    ).toMatch(/do NOT pass `cursor`/u);
    expect(block, `${tool} must say to copy the cursor verbatim`).toContain(
      "VERBATIM",
    );
  });
}

test("neither search tool advertises its result fields as inputs", () => {
  // The exact confusion from the transcript: `paths` and `matches` are OUTPUT
  // fields. If they ever appear in the input schema, a model will pass them.
  const globInputs = propertiesOf("glob");
  const grepInputs = propertiesOf("grep");
  expect(globInputs).not.toContain("paths");
  expect(globInputs).not.toContain("truncated");
  expect(grepInputs).not.toContain("matches");
});
