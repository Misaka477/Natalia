/**
 * Event-fallback guard (interface spec §4.2, landing point for P2).
 *
 * The spec's consumption-side discipline: every switch over `RuntimeEventData`
 * must handle the known branches plus a default fallback, and `assertNever`
 * exhaustiveness assertions are forbidden — the union gains new members as a
 * legitimate unknown value, exactly as a plugin-added variant is (dsh's session
 * format documents the same rule: "switches must NOT use assertNever — a
 * plugin-added variant is a valid unknown value").
 *
 * This mechanizes the check the spec scheduled for P2: a repo-wide grep that
 * fails the gate on any `assertNever` reaching production source. An
 * intentional exception carries a reason on the line, so the allow-list is
 * self-documenting and a stale entry fails like the other guards'.
 */
import { readdir, readFile } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const sourceRoots = ["packages", "apps"];
const skipDirs = new Set([
  "node_modules",
  "dist",
  ".turbo",
  "coverage",
  "build",
  "out",
]);

async function* sourceFiles(dir: string): AsyncGenerator<string> {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return;
  }
  for (const entry of entries) {
    if (entry.isDirectory()) {
      if (skipDirs.has(entry.name)) continue;
      yield* sourceFiles(join(dir, entry.name));
      continue;
    }
    if (!entry.name.endsWith(".ts")) continue;
    // Production source only, matching the other guards: the src trees. Bin
    // scripts and tests are tooling, not the event-consuming surface, and a
    // guard must never flag its own message strings.
    const path = join(dir, entry.name);
    if (!path.includes("/src/")) continue;
    yield path;
  }
}

const violations: string[] = [];
let scanned = 0;

for (const sourceRoot of sourceRoots) {
  for await (const file of sourceFiles(join(root, sourceRoot))) {
    const text = await readFile(file, "utf8");
    scanned += 1;
    const lines = text.split("\n");
    for (let index = 0; index < lines.length; index += 1) {
      const line = lines[index]!;
      if (!/\bassertNever\b/.test(line)) continue;
      // An intentional use must justify itself on the same line.
      const justified = /assertNever[^\n]*\/\/\s*fallback-ok:\s*\S/u.test(line);
      if (justified) continue;
      const where = `${relative(root, file)}:${index + 1}`;
      violations.push(`${where}: ${line.trim()}`);
    }
  }
}

console.log(`event fallback guard: ${scanned} files scanned`);

if (violations.length) {
  console.error(
    `assertNever reached production source: ${violations.length} (spec §4.2: event switches fall back, never exhaust-assert)`,
  );
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    "an intentional use carries `// fallback-ok: <reason>` on the same line",
  );
  process.exit(1);
}

console.log(
  "no assertNever in production source (unknown-fallback discipline holds)",
);
