/**
 * A declared timeout is a PAIR, or the runtime's deadline guard never runs.
 *
 * `execute-run` builds a tool's deadline like this:
 *
 *   tool.timeoutSec !== undefined && tool.maxTimeoutSec !== undefined
 *     ? timeoutSecOr(requested, tool.timeoutSec, tool.maxTimeoutSec)
 *     : tool.timeoutSec
 *
 * So a tool that declares `timeoutSec` alone gets a FIXED budget: the model's
 * `timeoutSec` argument is ignored, and nothing clamps it if the deployment
 * raises the default. That is the shape `record_validation` had — a naked `120`
 * passed to its runner with no declaration at all, so the guard did not exist
 * and no caller could raise it for a suite that legitimately takes ten minutes.
 *
 * The gate is a source walk: every tool block that names `timeoutSec` must also
 * name `maxTimeoutSec`, so the pair cannot drift apart one tool at a time.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

/** Every TypeScript source under the packages, excluding tests and build output. */
function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        // `native/` holds Rust crates; their sources are not tool definitions.
        if (entry.name !== "native") walk(path);
        continue;
      }
      if (entry.name.endsWith(".ts") && !entry.name.includes(".test."))
        found.push(path);
    }
  };
  walk(join(repoRoot, "packages"));
  return found;
}

test("a tool that OFFERS a timeoutSec argument also declares the pair", () => {
  // The rule is about the model-visible knob, not about every fixed budget: a
  // browser click's 20 seconds is deliberately fixed and offers no argument, so
  // there is nothing to ignore. The defect shape is a tool that ADVERTISES
  // `timeoutSec` and then cannot honour it, because `execute-run` only clamps
  // when both the default and the ceiling are declared.
  const ignored: string[] = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("timeoutSec")) continue;
    const blocks = source.split(/\n(?=\s*name: "[a-z_]+",\n)/u);
    for (const block of blocks) {
      if (!/name: "[a-z_]+",/u.test(block)) continue;
      if (!block.includes("requiresApproval")) continue; // not a tool definition
      // The ARGUMENT: a schema property named timeoutSec.
      const offersArgument = /timeoutSec:\s*\{\s*\n\s*type: "number"/u.test(
        block,
      );
      if (!offersArgument) continue;
      const name = /name: "([a-z_]+)",/u.exec(block)?.[1] ?? "?";
      if (block.includes("maxTimeoutSec:")) continue;
      ignored.push(
        `${file.replace(repoRoot, "").replace(/\\/gu, "/")}: ${name}`,
      );
    }
  }
  expect(
    ignored,
    "a tool advertises a timeoutSec argument without declaring maxTimeoutSec — " +
      "the runtime cannot clamp it, so the argument is silently ignored",
  ).toEqual([]);
});
