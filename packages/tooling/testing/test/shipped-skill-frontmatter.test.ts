import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { readdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

/**
 * Every skill any plugin ships parses to a REAL description.
 *
 * The parser is line-based (`^([\w-]+):\s*(.*)$` per frontmatter line), so
 * it does not understand YAML block scalars. A `description: >-` with the
 * text folded onto the following lines therefore parses to the literal
 * `>-`, the skill still loads (the value is non-empty, so the required
 * gate passes), and the model is shown `>-` where a sentence should be.
 * Measured in the wild: two shipped skills listed as
 * `browser-bridge-setup (plugin): >-` while the five that use a
 * single-line description read fine.
 *
 * The guard is on the FORMAT, not on those two files: the next skill
 * written with a folded block is caught here, whichever package ships it.
 */

/** The repository root: this file sits at packages/tooling/testing/test/. */
const packageRoot = dirname(
  dirname(dirname(dirname(fileURLToPath(import.meta.url)))),
);

/** Every `packages/plugins/<name>/skills/<skill>/SKILL.md` in the repo. */
async function shippedSkillFiles(): Promise<string[]> {
  const plugins = join(packageRoot, "plugins");
  const found: string[] = [];
  for (const entry of await readdir(plugins, { withFileTypes: true })) {
    if (!entry.isDirectory()) continue;
    const skillsDir = join(plugins, entry.name, "skills");
    if (!existsSync(skillsDir)) continue;
    for (const skill of await readdir(skillsDir, { withFileTypes: true })) {
      if (!skill.isDirectory()) continue;
      const file = join(skillsDir, skill.name, "SKILL.md");
      if (existsSync(file)) found.push(file);
    }
  }
  return found.sort();
}

/** The frontmatter's description, read the way the shipped parser reads it. */
function frontmatterDescription(markdown: string): string | undefined {
  const lines = markdown.split(/\r?\n/u);
  if (lines[0]?.trim() !== "---") return undefined;
  for (const line of lines.slice(1)) {
    if (line.trim() === "---") break;
    const match = /^([\w-]+):\s*(.*)$/u.exec(line);
    if (match?.[1] === "description") return match[2]!.trim();
  }
  return undefined;
}

test("every shipped skill's description is a sentence, not a YAML block marker", async () => {
  const files = await shippedSkillFiles();
  // Seven at the time of writing: the skills package's five, the browser
  // bridge's setup SOP, and the computer-use discipline.
  expect(files.length).toBeGreaterThanOrEqual(7);
  for (const file of files) {
    const markdown = await readFile(file, "utf8");
    const description = frontmatterDescription(markdown);
    const label = file.replace(`${packageRoot}\\`, "").replaceAll("\\", "/");
    expect(description, `${label}: no description line`).toBeDefined();
    // The failure that shipped: a folded block scalar's indicator.
    expect(
      description,
      `${label}: description is the YAML block marker "${description}" — ` +
        `the parser is line-based, so write the sentence on the same line ` +
        `as "description:"`,
    ).not.toMatch(/^[>|][+-]?$/u);
    // A real sentence, the bar the model-facing listing needs.
    expect(description!.length, `${label}: too short`).toBeGreaterThan(40);
    expect(description, `${label}: not a sentence`).toMatch(/\s/u);
    expect(description!.endsWith("."), `${label}: no full stop`).toBe(true);
  }
});
