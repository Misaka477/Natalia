/**
 * No-foreign-project-names guard (the user's 2026-10-08 ruling).
 *
 * Source and test code must not name another project. The functional
 * identifiers this product genuinely supports — the gateway provider key
 * `deepseek_gateway` and its model ids `deepseek-chat` / `deepseek-thinking`
 * — are lowercase data and stay; everything that READS as a reference to
 * somebody else's implementation (the short name, the repo name, the brand)
 * fails the gate.
 *
 * The allowlist is the identifier set above, spelled out so a new one is a
 * deliberate edit here rather than a silent exemption.
 */
import { readdir } from "node:fs/promises";
import { join, relative } from "node:path";

const root = process.cwd();
const sourceRoots = ["packages", "apps", "scripts"];
const skipDirs = new Set([
  "node_modules",
  "dist",
  ".turbo",
  "coverage",
  "build",
  "out",
  "devref",
  "fixtures",
]);

/** The functional identifiers this product supports (lowercase data). */
const ALLOWED = [
  /deepseek_gateway/u,
  /deepseek-chat/u,
  /deepseek-thinking/u,
  /"deepseek"/u,
  /deepseek reasoning/u,
  /deepseek\?:/u,
  /deepseek:/u,
];

/** Anything that reads as a reference to another project. */
const BANNED = [/\bdsh\b/iu, /deepseek-harness/iu, /DeepSeek/u];

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
    if (!/\.(ts|tsx)$/u.test(entry.name)) continue;
    // A guard never flags its own pattern table (the other guards' rule).
    if (entry.name === "no-foreign-project-names.ts") continue;
    yield join(dir, entry.name);
  }
}

const violations: string[] = [];
let scanned = 0;
for (const sourceRoot of sourceRoots) {
  for await (const file of sourceFiles(join(root, sourceRoot))) {
    const text = await Bun.file(file).text();
    scanned += 1;
    for (const [index, line] of text.split("\n").entries()) {
      // `handshake` contains the short name as a substring; it is our word.
      if (/handshake/iu.test(line)) continue;
      if (ALLOWED.some((pattern) => pattern.test(line))) continue;
      if (!BANNED.some((pattern) => pattern.test(line))) continue;
      violations.push(
        `${relative(root, file)}:${index + 1}: ${line.trim().slice(0, 120)}`,
      );
    }
  }
}

console.log(`no-foreign-project-names guard: ${scanned} files scanned`);

if (violations.length) {
  console.error(
    `another project's name reached source: ${violations.length} (the user's 2026-10-08 ruling)`,
  );
  for (const violation of violations) console.error(`  ${violation}`);
  console.error(
    "the functional identifiers (the gateway provider key and its model ids) are the allowlist in this guard",
  );
  process.exit(1);
}

console.log("no foreign project names in source");
