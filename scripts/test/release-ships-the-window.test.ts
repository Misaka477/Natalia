import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The release carries the window.
 *
 * `release:build` compiles the CLI bundle and the plugins. The desktop WINDOW is
 * a separate build, and for a long time nothing copied it into a release tree — so
 * a release could not be turned into an installable application, and the packaging
 * step refused it for a binary that was never there. That gap was found by running
 * the packaging against a REAL release instead of a hand-written fixture, which is
 * why this pin lives at the build script rather than in the packager.
 *
 * A hand-written fixture could not have caught it: the fixtures always contained
 * `natalia-cef-desktop`, because that is the file the packager was written to
 * require.
 */
const root = join(import.meta.dir, "..", "..");
const script = () =>
  readFileSync(join(root, "scripts", "build-standalone.ts"), "utf8");

test("the release tree assembles the desktop host", () => {
  const source = script();
  // The step exists and is called from the same loop that stages the terminal
  // natives — the one place every platform's tree is completed.
  expect(source).toContain("async function stageDesktopHost(");
  expect(source).toContain("await stageDesktopHost(outDir, platformDir);");
});

test("a missing host fails the build rather than shipping an empty app", () => {
  // The same rule the terminal natives follow: the binary either ships or the
  // build says so. A release that silently omits its window installs and then
  // does nothing.
  const source = script();
  expect(source).toContain("the desktop host is not built");
  // And it points at the command that produces it.
  expect(source).toContain("desktop:cef:build");
});

test("the CEF runtime travels with the binary", () => {
  // libcef without its .pak files and locales starts and immediately dies on a
  // missing resource, so the host build's own output is what gets copied.
  const source = script();
  for (const required of [
    "libcef.so",
    "libcef.dll",
    "libcef.dylib",
    "icudtl.dat",
    "locales",
  ])
    expect(source, `missing ${required}`).toContain(required);
});
