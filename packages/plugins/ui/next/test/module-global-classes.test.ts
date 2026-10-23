/**
 * A CSS module must never name a global class without :global().
 *
 * CSS Modules hash EVERY class name in the file into a local one. That is
 * the point of them — until a selector reaches for a class the DOM still
 * carries verbatim, which is the shared vocabulary the shell keeps global
 * (the pane, the shell, the kit's own surface). Written bare, that class
 * is hashed too, and the rule can never match anything. What was written
 * as a pane-scoped composer rule reaches the browser with the ancestor
 * hashed alongside the local name, so nothing matches and the composer
 * renders unstyled.
 *
 * That is exactly what happened: four modules, thirty-seven rules — the
 * entire composer, the entire queue dock, the rollback banner and the
 * right rail's responsive passes — rendered unstyled while every test,
 * the typecheck and the build stayed green, because none of them look at
 * the CSS the browser actually receives.
 *
 * The fix is one word: :global(.neu-pane) .composer. This guard makes
 * forgetting it fail the day it lands.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const srcRoot = join(import.meta.dir, "..", "src");
const stylesDir = join(srcRoot, "styles");

/** The class names the shell keeps global: every selector in the base
 *  sheet, which is the one stylesheet whose names reach the DOM as
 *  written. */
function globalClassNames(): Set<string> {
  const base = readFileSync(join(stylesDir, "base.ts"), "utf8");
  const names = new Set<string>();
  for (const match of base.matchAll(/^\s*([.#][A-Za-z][^{}\n]*?)\s*[,{]/gm)) {
    for (const part of match[1]!.split(",")) {
      const name = part.trim().match(/^\.([A-Za-z][\w-]*)/);
      if (name) names.add(name[1]!);
    }
  }
  return names;
}

/**
 * Selectors in a module that name a global class WITHOUT :global().
 *
 * `:global(...)` spans are stripped first, so a correctly written rule
 * contributes nothing. What is left is a bare mention of a name the
 * browser will hash.
 */
function bareGlobalSelectors(css: string, globals: Set<string>): string[] {
  const found: string[] = [];
  for (const raw of css.split("\n")) {
    const line = raw.trim();
    if (!line || line.startsWith("/*") || line.startsWith("*")) continue;
    // Only selector lines: they end in `{` or `,` and carry no declaration.
    if (!/[{,]\s*$/.test(line)) continue;
    if (line.includes(":") && !line.includes("::")) continue; // a declaration
    const stripped = line.replace(/:global\([^)]*\)/gu, " ");
    for (const name of globals) {
      const re = new RegExp(
        `\\.${name.replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")}(?![\\w-])`,
        "u",
      );
      if (re.test(stripped)) {
        found.push(line);
        break;
      }
    }
  }
  return found;
}

test("no CSS module names a global class without :global()", () => {
  const globals = globalClassNames();
  const offenders: string[] = [];
  for (const entry of readdirSync(stylesDir)) {
    if (!entry.endsWith(".module.css")) continue;
    const css = readFileSync(join(stylesDir, entry), "utf8");
    for (const selector of bareGlobalSelectors(css, globals)) {
      offenders.push(`${entry}: ${selector}`);
    }
  }
  expect(
    offenders,
    "these module selectors name a global class without :global() — CSS " +
      "Modules hash every bare class name, so the rule can never match " +
      "the DOM. Wrap the global name: :global(.neu-pane) .composer",
  ).toEqual([]);
});
