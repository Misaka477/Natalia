/**
 * Where the host's own native helpers live, by platform.
 *
 * The terminal plugin resolves its pty bridge with the same three-tier search
 * (`nativeTerminalPrebuiltDir`): the install's own `prebuilt/<triple>/`, then a
 * tier inside the plugin package, then the plugin-relative path. A HOST-level
 * helper has no plugin to be relative to, so this resolves the tier that exists
 * in every release — the install's own directory, anchored on `process.execPath`
 * so the answer does not depend on the current directory — and a checkout's
 * build output beside the source, which is where the build script writes.
 *
 * The history behind anchoring on `execPath` is in that comment and it applies
 * here unchanged: `process.argv[0]` is the string "bun" inside a compiled
 * binary, so `dirname(argv[0])` is the CURRENT DIRECTORY — a cwd-relative hit
 * that resolves only when the app happens to have been started from its own
 * install root.
 */
import { existsSync } from "node:fs";
import { dirname, join } from "node:path";

/** The platform triple a native helper is built for. */
export function hostPlatformTriple(
  os: NodeJS.Platform = process.platform,
): string {
  const arch = process.arch === "x64" ? "x64" : process.arch;
  const system = os === "win32" ? "windows" : os === "darwin" ? "darwin" : os;
  return `${system}-${arch}`;
}

/**
 * Whether a path lives inside Bun's embedded filesystem. Under redirected stdio
 * a compiled binary's execPath points there (`B:\~BUN\...`), and that directory
 * exists in no release tree.
 */
function isBunEmbeddedPath(dir: string): boolean {
  return dir.toLowerCase().includes("\\~bun\\");
}

/**
 * The directory a host helper is loaded from, or undefined when this host has
 * none — a checkout that has not run the build, or a platform with no helper.
 *
 * @param os - the platform to resolve for (runtime check, never baked in).
 * @param packageRoot - the host package's own directory, for the checkout tier.
 */
export function hostPrebuiltDir(
  os: NodeJS.Platform = process.platform,
  packageRoot: string = dirname(import.meta.dir),
): string | undefined {
  const triple = hostPlatformTriple(os);
  const candidates = [dirname(process.execPath), dirname(process.argv[0] ?? "")]
    .filter((dir) => dir.length > 0 && !isBunEmbeddedPath(dir))
    .map((dir) => join(dir, "prebuilt", triple));
  // A checkout resolves to the package's own build output, which is where
  // `npm run platform:build-job-runner:windows` writes.
  candidates.push(join(packageRoot, "prebuilt", triple));
  for (const candidate of candidates)
    if (existsSync(candidate)) return candidate;
  return undefined;
}
