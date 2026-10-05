// prebuilt-dir.ts — where our own native bridges live, by platform.
//
// Extracted verbatim from the deleted native-terminal.ts when the WezTerm
// fork chain went away: the pty controller needs exactly these two
// helpers from that 2146-line file, and carrying the whole host to keep
// them alive was the opposite of the retirement.
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

export function platformTriple(os: NodeJS.Platform = process.platform): string {
  const arch = process.arch === "x64" ? "x64" : process.arch;
  const system = os === "win32" ? "windows" : os === "darwin" ? "darwin" : os;
  return `${system}-${arch}`;
}

/**
 * The one place a downloaded or unpacked Natalia drops our native bridges
 * into.
 *
 * TWO locations are tried, in this order, because each one alone failed in the
 * field:
 *
 *   1. The install's own `prebuilt/<triple>/`. A release stages the bridge there
 *      (scripts/build-standalone.ts stageTerminalNatives), so an INSTALLED copy
 *      always has it on a real disk path. This is the first choice precisely
 *      because it does not depend on how the running code was loaded.
 *
 *   2. The plugin-relative path, which is what a CHECKOUT resolves to and what
 *      an installed copy used to be told to use.
 *
 * The history is worth keeping. The second form was the ONLY one, and it broke in
 * an install twice, for two different reasons:
 *   - the bridge was staged to `plugins/natalia-tool-terminal/pty-bridge/`, which
 *     this never reads, so the terminal tab failed with "the ConPTY bridge is
 *     not built";
 *   - it was then staged into `plugin-store/node_modules/@natalia/prebuilt/...`,
 *     which is where this points inside a plugin store, but that directory is
 *     machine-local plugin state and the release's hygiene guard rejects it
 *     wholesale — so the release build itself failed.
 *
 * The install directory is found the same way apps/cli/src/start-app.ts finds it:
 * by checking which candidate actually CONTAINS what we need, because
 * `import.meta.dir` and `process.execPath` both resolve to Bun's embedded
 * filesystem (`B:\~BUN\`) under some launch modes.
 */
export function nativeTerminalPrebuiltDir(
  os: NodeJS.Platform = process.platform,
): string {
  const triple = platformTriple(os);
  const pluginRelative = join(import.meta.dir, "..", "prebuilt", triple);

  const installCandidates = [
    dirname(process.argv[0] ?? ""),
    dirname(process.execPath),
  ].filter((dir) => dir.length > 0);
  for (const candidate of installCandidates) {
    const installed = join(candidate, "prebuilt", triple);
    if (existsSync(installed)) return installed;
  }
  return pluginRelative;
}
