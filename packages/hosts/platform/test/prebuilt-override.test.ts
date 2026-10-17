/**
 * The detached-process owner is found from a BUNDLE, not only from a release.
 *
 * Measured defect this pins: `process_start` answered every call with "the
 * detached-process owner is not built for this host: expected
 * natalia-job-runner.exe in the platform package's prebuilt/windows-x64/
 * directory" while the binary sat in the checkout at exactly that path. The
 * official process plugin is a BUNDLE, so its `import.meta.dir` is its own
 * directory inside `dist/ts/plugin-store/natalia-tool-process` — the
 * "checkout tier" therefore pointed at the bundle, and under `bun test`
 * `process.execPath` is bun itself, so the install-root tier missed too. A
 * release never noticed: there tier 1 holds.
 *
 * The fix is an explicit tier, `NATALIA_PREBUILT_DIR`, checked first. It is
 * the only seam a bundled caller can name, and it changes nothing for a
 * release whose own install root already resolves.
 */
import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hostPlatformTriple, hostPrebuiltDir } from "../src/prebuilt";

const repo = join(import.meta.dir, "..", "..", "..", "..");

test("the explicit tier wins when it names an existing directory", () => {
  const triple = hostPlatformTriple();
  const dir = join(repo, "packages", "hosts", "platform", "prebuilt", triple);
  if (!existsSync(dir)) {
    // A platform whose helper is not built here has nothing to assert about
    // which tier wins; the checkout tier is covered by the release build.
    expect(hostPrebuiltDir()).toBeUndefined();
    return;
  }
  const previous = process.env.NATALIA_PREBUILT_DIR;
  process.env.NATALIA_PREBUILT_DIR = dir;
  try {
    expect(hostPrebuiltDir()).toBe(dir);
    // An override that names nothing is not trusted: the search falls through
    // to the real tiers rather than returning a path that does not exist.
    process.env.NATALIA_PREBUILT_DIR = join(repo, "no-such-prebuilt-dir");
    expect(hostPrebuiltDir() === join(repo, "no-such-prebuilt-dir")).toBe(
      false,
    );
  } finally {
    if (previous === undefined) delete process.env.NATALIA_PREBUILT_DIR;
    else process.env.NATALIA_PREBUILT_DIR = previous;
  }
});

test("the checkout tier still resolves the package's own build output", () => {
  const triple = hostPlatformTriple();
  const packageRoot = join(repo, "packages", "hosts", "platform");
  const dir = join(packageRoot, "prebuilt", triple);
  const previous = process.env.NATALIA_PREBUILT_DIR;
  delete process.env.NATALIA_PREBUILT_DIR;
  try {
    // Passed explicitly so the assertion does not depend on where this file
    // was bundled to.
    const resolved = hostPrebuiltDir(process.platform, packageRoot);
    if (existsSync(dir)) expect(resolved).toBe(dir);
    else expect(resolved).toBeUndefined();
  } finally {
    if (previous !== undefined) process.env.NATALIA_PREBUILT_DIR = previous;
  }
});
