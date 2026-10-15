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
 * THREE locations are tried, in this order, because each one alone failed in
 * the field:
 *
 *   1. The install's own `prebuilt/<triple>/`. A release stages the bridge
 *      there (scripts/build-standalone.ts stageTerminalNatives), so an
 *      INSTALLED copy always has it on a real disk path. This is the first
 *      choice precisely because it does not depend on how the running code
 *      was loaded.
 *
 *   2. The plugin package's own `pty-bridge/`, which is where
 *      scripts/ts-build.ts stages the bridge for a native build
 *      (`build:windows` runs ts-build without NATALIA_BUILD_SKIP_NATIVE).
 *      That staging used to be read by NOTHING — build-standalone.ts's own
 *      comment recorded "which nothing reads" — so a distribution built by
 *      `build:windows` shipped a bridge the runtime could not find and every
 *      pane died with "the ConPTY bridge is not built" naming a path that
 *      directory never got. It is the only candidate that resolves when the
 *      plugin is loaded out of a plugin store, which is how the real-runtime
 *      suite loads it.
 *
 *   3. The plugin-relative `../prebuilt/<triple>`, which is what a CHECKOUT
 *      resolves to and what an installed copy used to be told to use.
 *
 * The history is worth keeping. The third form was the ONLY one, and it
 * broke in an install twice, for two different reasons:
 *   - the bridge was staged to `plugins/natalia-tool-terminal/pty-bridge/`,
 *     which this never read, so the terminal tab failed with "the ConPTY
 *     bridge is not built";
 *   - it was then staged into
 *     `plugin-store/node_modules/@natalia/prebuilt/...`, which is where this
 *     points inside a plugin store, but that directory is machine-local
 *     plugin state and the release's hygiene guard rejects it wholesale — so
 *     the release build itself failed.
 *
 * The install directory is found the same way apps/cli/src/start-app.ts
 * finds it: by checking which candidate actually CONTAINS what we need,
 * because `import.meta.dir` and `process.execPath` both resolve to Bun's
 * embedded filesystem (`B:\~BUN\`) under some launch modes.
 *
 * The candidates are ordered REAL-EXECUTABLE FIRST, and that order is the
 * fix. `process.argv[0]` is the string "bun" inside a compiled binary, so
 * `dirname(argv[0])` is the current directory: a cwd-relative hit that
 * resolves correctly only when the cwd happens to be the install root —
 * which is how a shortcut launch works, and how a launch from anywhere else
 * does not. Anchoring on `process.execPath` makes the answer independent of
 * the cwd. A path inside Bun's embedded filesystem is filtered out: it
 * exists in no release tree, so accepting it only produces a confident path
 * to nothing.
 */
export function nativeTerminalPrebuiltDir(
  os: NodeJS.Platform = process.platform,
  pluginDir: string = import.meta.dir,
): string {
  const triple = platformTriple(os);
  const pluginRelative = join(pluginDir, "..", "prebuilt", triple);

  const installCandidates = [
    dirname(process.execPath),
    dirname(process.argv[0] ?? ""),
  ].filter((dir) => dir.length > 0 && !isBunEmbeddedPath(dir));
  for (const candidate of installCandidates) {
    const installed = join(candidate, "prebuilt", triple);
    if (existsSync(installed)) return installed;
  }
  // The staged tier inside the plugin package itself. Checked before the
  // plugin-relative fallback because it is the one that exists when the
  // plugin is loaded out of a store, where `../prebuilt` names a directory
  // no build writes.
  const staged = join(pluginDir, "pty-bridge");
  if (existsSync(staged)) return staged;
  return pluginRelative;
}

/**
 * Whether a path lives inside Bun's embedded filesystem. Under redirected
 * stdio a compiled binary's execPath points there (`B:\~BUN\...`), and
 * that directory exists in no release tree.
 */
function isBunEmbeddedPath(dir: string): boolean {
  return dir.toLowerCase().includes("\\~bun\\");
}
