import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The release carries the shell-integration rc scripts.
 *
 * They were verified in a pty and never staged, so the verification covered the
 * source tree and not a release: an installed pane got
 * `bash --rcfile <package>/shell-integration-bash.sh`, bash found nothing, and the
 * command-level read never came alive. Nothing failed at build time — a missing
 * text file is not a build error — so the gap survived until someone ran the
 * installed copy.
 *
 * A structural pin rather than a build-and-inspect test: this suite runs
 * everywhere, including where a release build is skipped, and the property is
 * about what the build script stages rather than about what one run produced.
 */
test("the release stages the shell-integration rc scripts", () => {
  const source = readFileSync(
    join(import.meta.dir, "..", "ts-build.ts"),
    "utf8",
  );
  for (const script of [
    "shell-integration-bash.sh",
    "shell-integration-zsh.sh",
  ]) {
    expect(source, `${script} must be staged into the release`).toContain(
      script,
    );
  }
  // zsh's rc is a generated directory, so it needs the copy too — an entry in the
  // map without the file it points at is the same gap in a different shape.
  expect(source).toContain("zsh-rc/.zshrc");
  // And the staging must not sit inside the native-skip branch: that flag stages
  // the wezterm binaries, and a pane's rc files are not binaries. Compared by
  // position rather than by slicing, because the native block follows the staging
  // in the same function and a slice would contain it either way.
  // The property that matters is not where the block sits but that it copies: a
  // line naming the script without a copy is the same gap in a different shape, and
  // it is what a slice- or position-based check cannot see.
  const staging = source.slice(source.indexOf('"shell-integration-bash.sh"'));
  expect(staging).toContain("join(packageOutdir, script)");
  // Staged for the release, not only for a dev build: `build:distribution` always
  // sets NATALIA_BUILD_SKIP_NATIVE, so if the copy sat inside that branch a release
  // would carry no integration at all.
  expect(staging.indexOf("if (skipNative)")).toBeGreaterThan(
    staging.indexOf("join(packageOutdir, script)"),
  );
});
