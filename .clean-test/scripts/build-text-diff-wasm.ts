/**
 * The text-diff wasm pack: cargo build, then land the artifact where the
 * package imports it from.
 *
 * This used to be a shell pipeline inside the npm script
 * (`cargo … && cp … && bun scripts/build-ast-packs.ts`). Two POSIX-only
 * assumptions lived in that one line:
 *
 *   1. `cp` — npm runs scripts through the host shell, which is `cmd.exe` on
 *      Windows and has no `cp`;
 *   2. the `CARGO_HOME=${CARGO_HOME:-${TMPDIR:-/tmp}/…}` prefix — a bash
 *      parameter expansion cmd.exe cannot evaluate.
 *
 * Both move in here, where they are plain Node calls. The build itself is
 * unchanged: the same target, the same manifest, the same destination.
 */
import { copyFileSync, mkdirSync } from "node:fs";
import { join, resolve } from "node:path";
import { tmpdir } from "node:os";

const root = resolve(import.meta.dir, "..");
const manifest = join(
  root,
  "packages",
  "framework",
  "diff-wasm",
  "text-build",
  "Cargo.toml",
);
const artifact = join(
  root,
  "packages",
  "framework",
  "diff-wasm",
  "text-build",
  "target",
  "wasm32-unknown-unknown",
  "release",
  "natalia_diff_wasm.wasm",
);
const destination = join(
  root,
  "packages",
  "framework",
  "diff-wasm",
  "src",
  "natalia_diff_wasm.wasm",
);

// A cargo home the unprivileged user can write — in the OS temp dir, so the
// build leaves nothing inside the checkout (a repo-local `.cargo-home` is
// megabytes of registry that no .gitignore rule should have to know about).
const cargoHome =
  process.env.CARGO_HOME ?? join(tmpdir(), "natalia-cargo-home");
mkdirSync(cargoHome, { recursive: true });

const proc = Bun.spawnSync(
  [
    "cargo",
    "build",
    "--release",
    "--target",
    "wasm32-unknown-unknown",
    "--manifest-path",
    manifest,
  ],
  {
    cwd: root,
    env: { ...process.env, CARGO_HOME: cargoHome },
    stdout: "inherit",
    stderr: "inherit",
  },
);
if (proc.exitCode !== 0)
  throw new Error(`cargo build failed for ${manifest} (exit ${proc.exitCode})`);

mkdirSync(join(root, "packages", "framework", "diff-wasm", "src"), {
  recursive: true,
});
copyFileSync(artifact, destination);
console.log(`[diff-wasm] landed ${destination}`);
