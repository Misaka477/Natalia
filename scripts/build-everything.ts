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
 *   --skip-install           build only; do not deploy or touch the plugin store
 *
 * THE INSTALL IS A STEP, NOT AN AFTERTHOUGHT. A build that stops at
 * `dist/release` has not reached the thing a user runs: the runtime loads its
 * plugins from the PLUGIN STORE (`<natalia home>/plugin-store/node_modules`),
 * and `dist/release/<platform>/plugins` is only the source those are copied
 * FROM (`plugin-runtime.ts` installs by `cp`). Copying the release tree without
 * re-installing the official plugins leaves the store holding the previous
 * build — which is exactly how a shipped UI fix reached the distribution and
 * never reached the screen. `natalia plugin reconcile` does NOT close that gap:
 * it audits the lock and copies nothing.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, rmSync, statSync } from "node:fs";
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
    run: () => {
      // POSIX-only, and measurably so: the crate's `confinement-exec` calls
      // `CommandExt::exec`, which exists on Unix and not on Windows
      // (`method not found in &mut Command`, 26 errors). A platform branch is
      // a runtime check, never a baked-in choice — so this says why it is not
      // building here instead of failing the whole run.
      if (process.platform === "win32")
        return {
          ok: true,
          detail:
            "not built on Windows — the crate's launcher uses CommandExt::exec, which is Unix-only",
        };
      return cargo([
        "build",
        "--release",
        "--manifest-path",
        "packages/hosts/confinement/native/Cargo.toml",
      ]);
    },
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
  {
    name: "install into the running deployment",
    skipFlag: "--skip-install",
    run: () => {
      // Where the built tree goes. Read from the environment, never assumed:
      // a hard-coded `E:\Natalia` would make this script Windows-only, and the
      // deployment directory is the one fact this repository cannot know.
      const deployDir = process.env.NATALIA_DEPLOY_DIR;
      if (!deployDir)
        return {
          ok: false,
          detail:
            "NATALIA_DEPLOY_DIR is unset — name the directory the built tree should be copied into (e.g. E:\\Natalia), or pass --skip-install to build only",
        };
      // The plugins directory of whichever platform release exists. Read from
      // the tree rather than a table, so a platform added later needs no edit
      // here and the ids cannot drift from what was actually built.
      const releaseRoot = join(root, "dist", "release");
      let pluginsDir: string | undefined;
      try {
        for (const entry of readdirSync(releaseRoot)) {
          for (const version of readdirSync(join(releaseRoot, entry))) {
            const candidate = join(releaseRoot, entry, version, "plugins");
            try {
              if (statSync(candidate).isDirectory()) pluginsDir = candidate;
            } catch {
              // not this one
            }
          }
        }
      } catch {
        return { ok: false, detail: `no release tree under ${releaseRoot}` };
      }
      if (!pluginsDir)
        return {
          ok: false,
          detail: `no plugins directory under ${releaseRoot} — run without --skip-release first`,
        };
      const platformDir = join(pluginsDir, "..");
      const copied = spawnSync(
        process.platform === "win32" ? "robocopy" : "cp",
        process.platform === "win32"
          ? [platformDir, deployDir, "/MIR"]
          : ["-r", `${platformDir}/.`, deployDir],
        { encoding: "utf8" },
      );
      // robocopy reports success as 0-7; anything above is a real failure.
      const copyOk =
        process.platform === "win32"
          ? copied.status !== null && copied.status < 8
          : copied.status === 0;
      if (!copyOk)
        return {
          ok: false,
          detail: `copying ${platformDir} to ${deployDir} exited ${copied.status}`,
        };
      // THE STEP THAT WAS MISSING: the runtime loads from the store, so the
      // official plugins are installed into it by name. `reconcile` only
      // audits the lock; `reinstall` is the verb that copies.
      const exe = join(
        deployDir,
        process.platform === "win32" ? "natalia.exe" : "natalia",
      );
      const installed: string[] = [];
      for (const name of readdirSync(pluginsDir)) {
        const result = spawnSync(exe, ["plugin", "reinstall", name], {
          encoding: "utf8",
        });
        if (result.status !== 0)
          return {
            ok: false,
            detail: `plugin reinstall ${name} exited ${result.status}: ${[result.stderr, result.stdout].filter(Boolean).join(" ").slice(-300)}`,
          };
        installed.push(name);
      }
      return {
        ok: true,
        detail: `${platformDir} → ${deployDir}; ${installed.length} official plugins installed into the store`,
      };
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
  console.log(
    `ok    ${label} (${seconds}s)${outcome.detail ? ` — ${outcome.detail}` : ""}`,
  );
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
