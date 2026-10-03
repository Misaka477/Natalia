/**
 * Build the POSIX PTY bridge and drop it where the plugin looks first.
 *
 * The bridge is packages/plugins/native-terminal/native/pty-bridge — the repo's
 * own byte path for every pane, replacing the Python bridge as the default
 * (with Python kept as the fallback). The binary lands in
 * prebuilt/linux-x64/, the same drop the ConPTY helper uses on Windows, so a
 * downloaded Natalia has it beside the other natives and the release staging
 * finds it there.
 *
 * CARGO_HOME is passed through untouched: a host whose ~/.cargo is read-only
 * (measured: this one) exports its own writable CARGO_HOME, and the build
 * inherits it.
 */
import { mkdir, cp } from "node:fs/promises";
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";

const root = resolve(import.meta.dir, "..");
const crate = join(
  root,
  "packages",
  "plugins",
  "native-terminal",
  "native",
  "pty-bridge",
);
const built = join(crate, "target", "release", "natalia-pty-bridge");
const drop = join(
  root,
  "packages",
  "plugins",
  "native-terminal",
  "prebuilt",
  "linux-x64",
);

const build = Bun.spawnSync(
  ["cargo", "build", "--release", "--manifest-path", join(crate, "Cargo.toml")],
  {
    cwd: root,
    stdout: "inherit",
    stderr: "inherit",
  },
);
if (build.exitCode !== 0) {
  console.error("[pty-bridge] cargo build failed");
  process.exit(1);
}
if (!existsSync(built)) {
  console.error(
    `[pty-bridge] the build reported success but ${built} is absent`,
  );
  process.exit(1);
}
await mkdir(drop, { recursive: true });
await cp(built, join(drop, "natalia-pty-bridge"));
console.log(`[pty-bridge] ${join(drop, "natalia-pty-bridge")}`);
