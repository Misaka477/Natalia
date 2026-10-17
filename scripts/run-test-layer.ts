/**
 * Run one shard of a test directory.
 *
 * WHY THIS EXISTS. `bun test` has no shard-by-index flag, so the client layer
 * was a hand-written list of file names — and a new file in that directory ran
 * nowhere. The list had drifted to 132-of-164: thirty-two test files, written
 * over many sessions, had never executed in CI. It also has no "no matches"
 * failure: given one real path and one stale path it runs the real one and
 * exits 0 (measured), which is how ten object-store tests hid behind a path
 * that stopped existing.
 *
 * So a layer names a DIRECTORY and a shard, not files: the shard is computed
 * from the directory's current contents, and a directory that holds no tests
 * fails the job instead of passing an empty run.
 *
 * Usage: bun scripts/run-test-layer.ts <dir> <shardIndex> <shardCount>
 *        [--exclude <substring>]... [--bun-arg <arg>]...
 */
import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

type Options = {
  dir: string;
  shard: number;
  shards: number;
  excludes: string[];
  bunArgs: string[];
};

function parseArgs(argv: readonly string[]): Options {
  const positional: string[] = [];
  const excludes: string[] = [];
  const bunArgs: string[] = [];
  for (let index = 0; index < argv.length; index += 1) {
    const arg = argv[index]!;
    if (arg === "--exclude") {
      const value = argv[index + 1];
      if (value === undefined) fail("--exclude needs a value");
      excludes.push(value);
      index += 1;
      continue;
    }
    if (arg === "--bun-arg") {
      const value = argv[index + 1];
      if (value === undefined) fail("--bun-arg needs a value");
      bunArgs.push(value);
      index += 1;
      continue;
    }
    positional.push(arg);
  }
  if (positional.length !== 3)
    fail(
      "usage: bun scripts/run-test-layer.ts <dir> <shardIndex> <shardCount>",
    );
  const [dir, shardText, shardsText] = positional as [string, string, string];
  const shard = Number(shardText);
  const shards = Number(shardsText);
  if (!Number.isInteger(shard) || !Number.isInteger(shards) || shards < 1)
    fail("shard index and count must be integers, count >= 1");
  if (shard < 0 || shard >= shards) fail("shard index out of range");
  return { dir, shard, shards, excludes, bunArgs };
}

function fail(message: string): never {
  console.error(`run-test-layer: ${message}`);
  process.exit(1);
}

function main(): void {
  const options = parseArgs(process.argv.slice(2));
  const dir = resolve(options.dir);
  try {
    if (!statSync(dir).isDirectory()) fail(`${options.dir} is not a directory`);
  } catch {
    // A layer that names a directory the repository does not have is the stale
    // path this script exists to make loud.
    fail(`${options.dir} does not exist`);
  }
  const files = readdirSync(dir)
    .filter((name) => name.endsWith(".test.ts"))
    .filter((name) => !options.excludes.some((needle) => name.includes(needle)))
    .sort();
  if (files.length === 0)
    fail(
      `${options.dir} holds no test files (the excludes removed all of them)`,
    );
  const shardFiles = files.filter(
    (_, index) => index % options.shards === options.shard,
  );
  if (shardFiles.length === 0) {
    // Legitimate when a directory has fewer files than shards, and still not a
    // silent pass: the emptiness is reported on the job's log.
    console.log(
      `run-test-layer: shard ${options.shard}/${options.shards} of ${options.dir} is empty (${files.length} files)`,
    );
    return;
  }
  console.log(
    `run-test-layer: shard ${options.shard}/${options.shards} of ${options.dir} → ${shardFiles.length}/${files.length} files`,
  );
  const run = spawnSync(
    "bun",
    [
      "test",
      ...options.bunArgs,
      ...shardFiles.map((name) => join(options.dir, name)),
    ],
    { stdio: "inherit", shell: process.platform === "win32" },
  );
  process.exit(run.status ?? 1);
}

main();
