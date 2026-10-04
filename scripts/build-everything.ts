/**
 * THE ONE-SHOT BUILD: every native artifact a distribution needs, in one
 * command, fail-loud.
 *
 * The seven steps, in dependency order:
 *
 *   1. the confinement backend   (the shell tools fail CLOSED without it)
 *   2. the object-store's native crate — the cdylib (the store's FFI) AND
 *      the resident index daemon binary
 *   3. the AST packs             (the wasm core + the 44 languages)
 *   4. the license manifest      (the build's own metadata gate)
 *   5. the wezterm fork, Windows (the cross build's three .exe — the only
 *      platform still carrying the fork, and only until the ConPTY bridge
 *      flips; POSIX releases ship no terminal executables at all)
 *   6. the plugin distribution   (ts-build in distribution mode + store)
 *   7. the releases              (linux-x64 + windows-x64, self-verified)
 *
 * What it is NOT: a test runner. Tests are the verify chain's business;
 * this builds. What it refuses to do: continue past a failed step. A
 * distribution built half-way is not a distribution, and a step that
 * "mostly worked" is how a release ships with the wrong native binaries.
 *
 * Flags (each skips honestly, and every skip is printed in the summary):
 *   --skip-wezterm-windows   no cross toolchain
 *   --skip-release           natives only, no standalone bundles
 */

import { spawnSync } from "node:child_process";
import { rmSync, statSync } from "node:fs";
import { join } from "node:path";

type Step = {
  name: string;
  skipFlag?: string;
  run: () => { ok: boolean; detail?: string };
};

const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";

function command(
  args: string[],
  options: { env?: Record<string, string>; cwd?: string } = {},
): { ok: boolean; detail?: string } {
  const result = spawnSync(npm, args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: { ...process.env, ...options.env },
  });
  if (result.status !== 0) {
    const tail = [result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .split("\n")
      .filter((line) => line.trim())
      .slice(-6)
      .join(" | ");
    return {
      ok: false,
      detail: `${args.join(" ")} exited ${result.status}: ${tail}`,
    };
  }
  return { ok: true };
}

function cargo(
  args: string[],
  options: { cwd?: string } = {},
): { ok: boolean; detail?: string } {
  const result = spawnSync("cargo", args, {
    cwd: options.cwd ?? root,
    encoding: "utf8",
    env: {
      ...process.env,
      CARGO_HOME: process.env.CARGO_HOME ?? "/tmp/natalia-cargo",
    },
  });
  if (result.status !== 0) {
    const tail = [result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .split("\n")
      .filter((line) => line.trim())
      .slice(-6)
      .join(" | ");
    return {
      ok: false,
      detail: `cargo ${args.join(" ")} exited ${result.status}: ${tail}`,
    };
  }
  return { ok: true };
}

/** The artifact's size — the step's proof, printed at the end. */
function sizeOf(path: string): string | undefined {
  try {
    const bytes = statSync(path).size;
    return bytes >= 1024 * 1024
      ? `${(bytes / (1024 * 1024)).toFixed(1)} MiB`
      : `${Math.round(bytes / 1024)} KiB`;
  } catch {
    return undefined;
  }
}

const steps: Step[] = [
  {
    name: "the confinement backend",
    run: () =>
      cargo([
        "build",
        "--release",
        "--manifest-path",
        "packages/hosts/confinement/native/Cargo.toml",
      ]),
  },
  {
    name: "the object-store native crate (the cdylib and the daemon)",
    run: () =>
      cargo(["build", "--release"], {
        cwd: join(root, "packages/framework/object-store/native"),
      }),
  },
  {
    name: "the AST wasm packs",
    run: () => command(["run", "diff:build-wasm"]),
  },
  {
    name: "the license manifest",
    run: () => command(["run", "licenses:check"]),
  },
  {
    name: "the wezterm fork, Windows (the cross build's three .exe)",
    skipFlag: "--skip-wezterm-windows",
    // The colon form, not the dash one: the dash named a script package.json
    // has never carried, so this step died with "Missing script" on any host
    // that reached it — found while retiring the Ubuntu twin beside it.
    run: () => command(["run", "native-terminal:build-wezterm:windows-cross"]),
  },
  {
    name: "the plugin distribution",
    run: () => {
      const built = command(["run", "build:distribution"], {
        env: { NATALIA_BUILD_SKIP_NATIVE: "1" },
      });
      if (!built.ok) return built;
      return command(["run", "refresh:plugin-store"]);
    },
  },
  {
    name: "the releases (linux-x64 and windows-x64)",
    skipFlag: "--skip-release",
    run: () => {
      // The shared staging directory the two native builds populate: the
      // release trims each bundle to its own platform's binaries, and a
      // stale directory is how a release ships with the wrong ones (the
      // bug this round's self-check now catches at the other end).
      rmSync(join(root, "dist", "release"), {
        recursive: true,
        force: true,
      });
      return command(["run", "release:build", "--", "--all"]);
    },
  },
];

const argv = process.argv.slice(2);
const skipped = new Set(argv);
const unknown = argv.filter(
  (arg) => arg.startsWith("--") && !steps.some((step) => step.skipFlag === arg),
);
if (unknown.length > 0) {
  console.error(`unknown flag(s): ${unknown.join(", ")}`);
  process.exit(2);
}

console.log("building every native artifact the distribution needs\n");
const results: Array<{ name: string; state: string }> = [];
for (const [index, step] of steps.entries()) {
  const label = `[${index + 1}/${steps.length}] ${step.name}`;
  if (step.skipFlag && skipped.has(step.skipFlag)) {
    console.log(`SKIP  ${label}`);
    results.push({ name: step.name, state: "skipped" });
    continue;
  }
  const started = Date.now();
  const outcome = step.run();
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (!outcome.ok) {
    console.log(`FAIL  ${label} (${seconds}s)`);
    console.log(`      ${outcome.detail}`);
    results.push({ name: step.name, state: "failed" });
    break; // fail-loud: a half-built distribution is not a distribution
  }
  console.log(`ok    ${label} (${seconds}s)`);
  results.push({ name: step.name, state: "ok" });
}

console.log("\nthe artifacts:");
const proofs: Array<[string, string]> = [
  [
    "the confinement backend",
    "packages/hosts/confinement/native/target/release/confinement-exec",
  ],
  [
    "the object-store cdylib",
    "packages/framework/object-store/native/target/release/libnatalia_object_store.so",
  ],
  [
    "the index daemon",
    "packages/framework/object-store/native/target/release/natalia-object-store-daemon",
  ],
  ["the wasm core", "packages/framework/diff-wasm/src/natalia_diff_wasm.wasm"],
  // Retired on this platform by decision (2026-10-04): the POSIX runtime, the
  // release tree and the build chain no longer carry the fork's binaries. The
  // row is annotated rather than removed because the fork itself is deleted in
  // Phase 2 (after the ConPTY bridge flips) -- until then this line is the
  // record of why "not built" is the correct, intended state for it.
  [
    "wezterm (Ubuntu) - retired",
    "packages/plugins/native-terminal/wezterm/target/release/wezterm",
  ],
  [
    "wezterm (Windows)",
    "packages/plugins/native-terminal/wezterm/target/release/wezterm.exe",
  ],
  ["the plugin distribution", "dist/ts/plugins"],
  ["the linux release", "dist/release"],
];
for (const [label, path] of proofs) {
  const size = sizeOf(join(root, path));
  console.log(
    `  ${label.padEnd(28)} ${size ? size.padStart(9) : "not built"}  ${path}`,
  );
}

const failed = results.filter((result) => result.state === "failed");
if (failed.length > 0) {
  console.error(`\nBUILD FAILED at: ${failed[0]!.name}`);
  process.exit(1);
}
console.log("\nBUILD OK — the distribution is ready to install");
