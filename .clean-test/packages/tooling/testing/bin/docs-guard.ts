/**
 * Docs freshness gate.
 *
 * The generated blocks in `docs/*-reference.md` are derived from the same
 * constants the contracts and transports use, and a contract change that does not
 * regenerate them is caught by `api-reference.test.ts` — but late, and among two
 * thousand other tests, where it reads as one more red rather than as the
 * actionable one-liner it is.
 *
 * This gate runs that single test first so the failure arrives before the suite
 * and names the command that fixes it. It deliberately runs the existing test
 * rather than re-deriving the blocks: a second renderer would drift from the
 * first, and the whole point of these documents is that they cannot.
 */
import { spawnSync } from "node:child_process";
import { join } from "node:path";

const root = process.cwd();
const apiReferenceTest = join(
  root,
  "packages",
  "hosts",
  "transport",
  "test",
  "api-reference.test.ts",
);

const result = spawnSync("bun", ["test", apiReferenceTest], {
  cwd: root,
  stdio: "ignore",
});

if (result.status === 0) process.exit(0);

console.error(
  [
    "generated docs are stale",
    "",
    "A contract, transport or event change landed without regenerating the",
    "reference documents. Run:",
    "",
    "  npm run docs:api-reference",
    "",
    "then re-run. The gate runs the same test the suite does, so this is the",
    "only report you need.",
  ].join("\n"),
);
process.exit(1);
