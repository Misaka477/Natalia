/**
 * The versions the UI declares are the package's real version.
 *
 * The UI plugin and its two skins each declare `version: "1.0.0"` in
 * source. The package's version is 1.0.0 today, so the values are right —
 * and a version bump that updates package.json and not these three is a
 * silent drift: the plugin manager would keep reporting the old one, and
 * nothing would fail. The repo does not import package.json from browser
 * code (no resolveJsonModule anywhere), so the pin is mechanical instead:
 * the declared value must equal the manifest's, checked here.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..", "..", "..");

function source(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

const pkg = JSON.parse(
  readFileSync(
    join(root, "packages", "plugins", "ui", "next", "package.json"),
    "utf8",
  ),
) as { version: string };

test("the UI plugin and both skins declare the package's real version", () => {
  const declared = `version: "${pkg.version}"`;
  for (const file of [
    "packages/plugins/ui/next/src/plugin-neu.tsx",
    "packages/plugins/ui/next/src/plugin-neu-light.tsx",
  ]) {
    expect(source(file), `${file} must declare ${declared}`).toContain(
      declared,
    );
  }
  // The skins: one entry each, so count them rather than matching once.
  const skins = source("packages/plugins/ui/next/src/skins.ts");
  const occurrences = skins.split(declared).length - 1;
  expect(occurrences).toBe(2);
});

test("the shortcuts the help panel advertises all have handlers", () => {
  // A row for a shortcut nothing handles is a feature that exists only in
  // the documentation. Ctrl+K (command palette) and Ctrl+/ (settings) were
  // exactly that: advertised, and dead when pressed.
  const help = source("packages/plugins/ui/next/src/help-panel.tsx");
  const app = source("packages/plugins/ui/next/src/app-neu.tsx");
  const advertised = [...help.matchAll(/keys: \[([^\]]+)\]/gu)].map((match) =>
    match[1]!
      .split(",")
      .map((key) => key.trim().replace(/["']/gu, ""))
      .join("+")
      .toLowerCase(),
  );
  // The handlers, as the same normalized spelling: the shell listens for
  // ctrl/meta + b, + j, and ctrl/meta + shift + p.
  const handled = ["ctrl+b", "ctrl+j", "ctrl+shift+p"];
  for (const keys of advertised) {
    expect(
      handled.includes(keys),
      `help panel advertises ${keys}, which the shell does not handle`,
    ).toBe(true);
  }
  // And the app really does handle them, so the list above is not stale.
  expect(app).toContain('event.key.toLowerCase() === "b"');
  expect(app).toContain('event.key.toLowerCase() === "j"');
  expect(app).toContain('event.key.toLowerCase() === "p"');
});
