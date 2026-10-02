import { readdir } from "node:fs/promises";
import { join } from "node:path";

/**
 * The hole the79 census exposed: `guard:deps` is the CYCLE guard, and
 * nothing reconciled a package's SOURCE imports against its manifest —
 * nine undeclared workspace imports lived green for rounds (bun's
 * hoisting resolved them regardless).
 *
 * Why beyond tidiness: an undeclared dependency breaks the moment
 * anything consumes the package outside this workspace's hoisted tree
 * — a published d.ts referencing an undeclared type, a frozen install
 * that never linked it, an importer reasoning from manifests alone
 * (like this very rule).
 *
 * src-scoped on purpose: production code's workspace imports must live
 * in `dependencies`. Type-only imports count — emitted declarations
 * need the package exactly as much as a value import does.
 */

async function listSourceFiles(dir: string): Promise<string[]> {
  const out: string[] = [];
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return out;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) out.push(...(await listSourceFiles(full)));
    else if (/\.(?:ts|tsx)$/u.test(entry.name)) out.push(full);
  }
  return out;
}

export async function findUndeclaredWorkspaceImports(input: {
  ownName: string;
  packageDir: string;
  deps: Readonly<Record<string, string>>;
}): Promise<string[]> {
  const failures: string[] = [];
  for (const file of await listSourceFiles(join(input.packageDir, "src"))) {
    const text = await Bun.file(file)
      .text()
      .catch(() => undefined);
    if (text === undefined) continue;
    for (const match of text.matchAll(
      /from\s+"((?:@anthelia|@natalia)\/[^/"]+)/gu,
    )) {
      const target = match[1]!;
      if (target === input.ownName) continue; // a package naming itself
      if (!(target in input.deps))
        failures.push(
          `${file}: imports ${target} which its manifest does not declare`,
        );
    }
  }
  return failures;
}
