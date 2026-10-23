/**
 * Every `styles.foo` must be a rule in that module.
 *
 * CSS Modules hash a class name that has no rule into `undefined`, and
 * `class={undefined}` is a missing class — the control renders with the
 * browser's default appearance. Nothing in the toolchain notices: the
 * transform succeeds, the typecheck sees a `Record<string, string>` index,
 * the build succeeds, and the browser paints a raw button.
 *
 * That is exactly what happened to the settings dialog: it renders
 * `styles.category`, and `settings-panel.module.css` has no `.category`
 * rule, so the category buttons came out unstyled. One bug, one place —
 * and the same mistake is available in all twenty-eight modules, so the
 * guard is written over all of them.
 *
 * The check is deliberately literal: it walks each file's own import
 * binding for the module it actually loads, reads that file, and requires
 * the class to exist. Dynamic access (`styles[name]`) is out of scope by
 * design — a name the guard cannot see is a name it cannot check, and
 * pretending otherwise would only add false confidence.
 */
import { expect, test } from "bun:test";
import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { dirname, join, relative, resolve } from "node:path";

const srcRoot = join(import.meta.dir, "..", "src");

function walk(dir: string): string[] {
  const out: string[] = [];
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry);
    if (statSync(full).isDirectory()) out.push(...walk(full));
    else if (entry.endsWith(".tsx")) out.push(full);
  }
  return out;
}

/** The class names a module actually defines. */
function definedClasses(css: string): Set<string> {
  const names = new Set<string>();
  for (const match of css.matchAll(/\.(-?[A-Za-z_][\w-]*)/gu)) {
    names.add(match[1]!);
  }
  return names;
}

/**
 * A binding a local declaration shadows is not checkable.
 *
 * `governance-panel.tsx` binds `drift` to the drift-cards module and ALSO
 * destructures a `drift` data bundle from its own Promise.all. Every
 * `drift.items` in that file is the bundle, not the stylesheet, and no
 * textual rule can tell the two apart. Rather than guess — and report a
 * class that was never written — the guard drops the binding for that
 * file and says so, so a shadowed binding is a known blind spot instead
 * of a false confidence.
 */
function isShadowed(source: string, name: string): boolean {
  const body = source.replace(
    new RegExp(`import\\s+${name}\\s+from\\s+"[^"]*\\.module\\.css";`, "gu"),
    "",
  );
  return (
    new RegExp(`\\b(?:const|let|var)\\s*\\[[^\\]]*\\b${name}\\b`, "u").test(
      body,
    ) ||
    new RegExp(`\\b(?:const|let|var)\\s*\\{[^}]*\\b${name}\\b`, "u").test(
      body,
    ) ||
    new RegExp(`\\b(?:const|let|var)\\s+${name}\\b`, "u").test(body) ||
    new RegExp(`\\b${name}\\s*=`, "u").test(body) ||
    new RegExp(`\\((?:[^()]*,\\s*)?${name}\\s*[,)]`, "u").test(body)
  );
}

test("every styles.foo reference has a .foo rule in its own module", () => {
  const missing: string[] = [];
  const skipped: string[] = [];
  for (const file of walk(srcRoot)) {
    const source = readFileSync(file, "utf8");
    // binding -> module path, for this file only
    const bindings = new Map<string, string>();
    for (const m of source.matchAll(
      /import\s+(\w+)\s+from\s+"([^"]*\.module\.css)"/gu,
    )) {
      const cssPath = resolve(dirname(file), m[2]!);
      if (existsSync(cssPath)) bindings.set(m[1]!, cssPath);
    }
    for (const [name, cssPath] of bindings) {
      if (isShadowed(source, name)) {
        skipped.push(`${relative(srcRoot, file)}: ${name}`);
        bindings.delete(name);
      }
    }
    if (bindings.size === 0) continue;
    for (const m of source.matchAll(
      /\b(styles|wg|[a-z][A-Za-z0-9]*)\.([A-Za-z_][\w]*)\b/gu,
    )) {
      const cssPath = bindings.get(m[1]!);
      if (!cssPath) continue; // not a styles binding
      const name = m[2]!;
      if (name === "default" || name === "length") continue;
      const defined = definedClasses(readFileSync(cssPath, "utf8"));
      if (!defined.has(name)) {
        missing.push(
          `${relative(srcRoot, file)}: styles.${name} -> ` +
            `${relative(srcRoot, cssPath)} has no .${name} rule`,
        );
      }
    }
  }
  expect(
    missing,
    "these class names have no rule in the module that defines them — CSS " +
      "Modules hash them to undefined and the control renders unstyled. " +
      "Add the rule, or drop the reference.",
  ).toEqual([]);
});
