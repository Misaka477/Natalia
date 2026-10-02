/**
 * The three-zone discipline, machine-checkable for the runtime zone
 * (architecture decisions §5): the runtime's telemetry belongs to the
 * operation log — leveled, correlated, rotated, redaction-sealed — not to
 * raw console streams.
 *
 * Scope: `packages/framework/client/src` (the runtime zone). The CLI's
 * stdout IS its UI and plugin logs are the plugin's own zone (self-
 * contained) — neither is this guard's business. One allowlist entry:
 * workspace-manager runs before any runtime exists (no service directory
 * to log through) — console there is the documented host-facade boundary
 * until the host data plane (decisions §6 / T4).
 */
import { readdir, readFile } from "node:fs/promises";
import { join, resolve } from "node:path";

const ROOT = resolve(import.meta.dir, "../../../..");
const SCAN_DIR = join(ROOT, "packages/framework/client/src");
const ALLOW = new Set(["workspace-manager.ts"]);
const PATTERN =
  /console\.(log|warn|error|debug|info|trace|time|timeEnd|dir|table|group|groupEnd|assert|count)\s*\(/;

async function walk(dir: string): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  const files: string[] = [];
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...(await walk(full)));
    else if (entry.name.endsWith(".ts")) files.push(full);
  }
  return files;
}

const violations: string[] = [];
for (const file of await walk(SCAN_DIR)) {
  const name = file.split("/").pop() ?? "";
  if (ALLOW.has(name)) continue;
  const lines = (await readFile(file, "utf8")).split("\n");
  lines.forEach((line, index) => {
    if (PATTERN.test(line))
      violations.push(
        `${file.slice(ROOT.length + 1)}:${index + 1}: ${line.trim().slice(0, 120)}`,
      );
  });
}

if (violations.length > 0) {
  console.error(
    "console guard: runtime-zone console use found (use the operation log):",
  );
  for (const violation of violations) console.error("  " + violation);
  console.error(
    "allowed only in workspace-manager.ts (pre-runtime host facade, decisions §6)",
  );
  process.exit(1);
}
console.log(
  `console guard: ${SCAN_DIR.slice(ROOT.length + 1)} clean (allowlist: ${[...ALLOW].join(", ") || "none"})`,
);
