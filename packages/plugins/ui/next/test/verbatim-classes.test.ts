/**
 * Every class the DOM uses verbatim must have a global rule.
 *
 * The CSS Modules migration renamed a region's own classes into module
 * locals, which is right: a component imports its module and reads
 * `styles.foo`. But a class the markup still writes VERBATIM — a parent
 * styling a child, a name several surfaces share — has to be defined
 * somewhere global, in the base sheet or in a module's `:global(...)`.
 *
 * This guard exists because that invariant was broken silently and at
 * scale: the token-layer rewrite of base.ts dropped the whole
 * `neu-select` family and the whole `neu-form` family, and later the
 * modal chrome, while the markup kept carrying those names. The result
 * was a shell that compiled, tested and built green — 230 tests — and
 * rendered bare, unstyled controls: no select box, no chevron, no menu,
 * no dialog title bar. The user found it in a screenshot; nothing in the
 * suite said a word.
 *
 * So the walk is the gate: a verbatim class with no rule fails this test
 * the day it lands, and a rule that goes missing fails it the same day.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const srcRoot = join(import.meta.dir, "..", "src");
const stylesDir = join(srcRoot, "styles");

/** Source files, walked the same way the shell's own tooling walks them. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** A class name, as the DOM would carry it. */
const CLASS_NAME = /^[a-zA-Z][\w-]*$/;

/**
 * Class names the markup writes verbatim: the literal `class="a b"` form
 * and the literal parts of a template (`class={`a ${styles.b}`}` — only
 * `a` counts; `styles.b` is a module local this guard says nothing
 * about).
 *
 * The template arm takes the span between the backticks that open and
 * close the attribute's literal. An earlier arm stopped at the first
 * `}`, which is inside the very interpolations it has to step over:
 * `class={`${styles.btn} neu-topbar-btn-primary`}` has its literal
 * AFTER an interpolation, and `class={`neu-select ${props.class ?? ""}`.trim()}`
 * has braces inside one. Both were invisible to it, so the most-used
 * class in the shell and a documented hook both went unchecked.
 * Interpolations are dropped before the split, so what is left is what
 * the browser would see as a literal class.
 */
function verbatimClasses(source: string): Set<string> {
  const names = new Set<string>();
  const add = (raw: string) => {
    const literal = raw.replace(/\$\{[^}]*\}/gu, " ");
    for (const token of literal.split(/\s+/u)) {
      if (CLASS_NAME.test(token)) names.add(token);
    }
  };
  for (const match of source.matchAll(/class="([^"]*)"/g)) add(match[1]!);
  for (const match of source.matchAll(/class=\{\s*`([^`]*)`/g)) add(match[1]!);
  return names;
}

/**
 * Class names defined as global rules: every selector in the base sheet,
 * and every `:global(...)` a module declares.
 */
function globalRuleNames(): Set<string> {
  const names = new Set<string>();
  const base = readFileSync(join(stylesDir, "base.ts"), "utf8");
  for (const match of base.matchAll(/^\s*([.#][A-Za-z][^{}\n]*?)\s*[,{]/gm)) {
    for (const part of match[1]!.split(",")) {
      const name = part.trim().match(/^\.([A-Za-z][\w-]*)/);
      if (name) names.add(name[1]!);
    }
  }
  for (const entry of readdirSync(stylesDir)) {
    if (!entry.endsWith(".module.css")) continue;
    const css = readFileSync(join(stylesDir, entry), "utf8");
    for (const match of css.matchAll(/:global\(([^)]*)\)/g)) {
      for (const part of match[1]!.split(",")) {
        const name = part.trim().match(/^\.([A-Za-z][\w-]*)/);
        if (name) names.add(name[1]!);
      }
    }
  }
  return names;
}

/**
 * Names that are verbatim in the DOM and deliberately have no rule of
 * their own. Each entry says why, so the list cannot grow by silence.
 */
const DOCUMENTED_HOOKS = new Map<string, string>([
  // The kit's own surface, which the shell does not restyle.
  ["natalia-composer-attachments", "the kit's composer — the kit styles it"],
  [
    "markdown-body",
    "the markdown hook; styled only as a descendant of the preview",
  ],
  // Hooks that carry no rule in the shell this package was copied from
  // either — verified by reading that sheet: they are handles for tests
  // or for a parent, not styled elements.
  ["ast-group-name", "an unstyled handle inside the AST group header"],
  [
    "constitution-row-override",
    "an unstyled handle inside the constitution row",
  ],
  [
    "constitution-row-overrides",
    "an unstyled handle inside the constitution row",
  ],
  [
    "constitution-row-overrides-title",
    "an unstyled handle inside the constitution row",
  ],
  ["neu-checkbox-list", "an unstyled handle around the settings checkboxes"],
  ["neu-tree", "an unstyled handle around the session tree"],
  ["neu-badge-running", "an unstyled hook beside the session badge"],
  ["neu-activity-label", "an unstyled hook inside the activity bar"],
  ["neu-gov-section-label", "an unstyled hook above a governance section"],
  ["review-count", "an unstyled hook beside a review count"],
  ["neu-topbar-btn-primary", "an unstyled hook on the topbar's primary button"],
  [
    "neu-topbar-panel-close",
    "an unstyled hook on the topbar panel's close button",
  ],
]);

test("every class the DOM writes verbatim has a global rule", () => {
  const defined = globalRuleNames();
  const missing = new Map<string, string[]>();
  for (const file of sourceFiles(srcRoot)) {
    const source = readFileSync(file, "utf8");
    for (const name of verbatimClasses(source)) {
      if (defined.has(name) || DOCUMENTED_HOOKS.has(name)) continue;
      const where = relative(srcRoot, file).split(/[\\/]/u).join("/");
      const seen = missing.get(name) ?? [];
      seen.push(where);
      missing.set(name, seen);
    }
  }
  const report = [...missing.keys()].sort().map((name) => {
    const where = missing.get(name)!.join(", ");
    return `${name}  (used in ${where})`;
  });
  expect(
    report,
    "these classes are written verbatim in the markup but no global rule " +
      "defines them — either the rule was dropped (restore it, verbatim, " +
      "and mark it shared) or the call site should read its module local " +
      "instead",
  ).toEqual([]);
});

test("the documented hooks are all still verbatim in the DOM", () => {
  // A hook that stops being used is a lie in the list above.
  const used = new Set<string>();
  for (const file of sourceFiles(srcRoot)) {
    for (const name of verbatimClasses(readFileSync(file, "utf8"))) {
      used.add(name);
    }
  }
  const stale = [...DOCUMENTED_HOOKS.keys()].filter((name) => !used.has(name));
  expect(
    stale,
    "a documented hook is no longer written verbatim — drop it from the list",
  ).toEqual([]);
});
