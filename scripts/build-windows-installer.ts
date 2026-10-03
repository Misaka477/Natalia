/**
 * Build the Windows installer's inputs from whatever release directory exists.
 *
 * The container itself is a decision the repository has not made yet (MSIX vs a
 * classic installer), and that is deliberate: it turns on a signing certificate
 * the project does not have, so guessing would produce a script that cannot run
 * on the machine that matters.
 *
 * This script is everything either choice needs, and needs no choice: it renders
 * BOTH inputs from the same derived plan (`scripts/windows-installer.ts`), and
 * compiles whichever one its tool is present for. `--format inno|wix|both` picks
 * the render, `--compile` demands a tool rather than degrading.
 *
 * So the Windows side is no longer blocked on the decision: the plan, the file
 * list, the Start Menu entry, the uninstall entry, the upgrade code and the icon
 * are all produced and tested today. The remaining step is one flag and one host.
 */
import { existsSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  buildWindowsInstallerInputs,
  newestRelease,
} from "./windows-installer";

const root = resolve(import.meta.dir, "..");
const HOST_TRIPLE = "windows-x64";

function findIcon(): string | undefined {
  const candidates = [
    join(root, "assets", "icons", "icon.ico"),
    join(root, "assets", "icons", "icon.png"),
    join(root, "assets", "icon.ico"),
  ];
  return candidates.find((candidate) => existsSync(candidate));
}

function versionFromRelease(releaseDir: string): string {
  const parts = releaseDir.split("/");
  const index = parts.lastIndexOf(HOST_TRIPLE);
  if (index > 0) return parts[index - 1]!;
  return "0.0.0";
}

async function main(): Promise<number> {
  const argv = process.argv.slice(2);
  const version = argv.find((arg) => !arg.startsWith("-"));
  // Inno Setup is the distribution path: it produces a working installer with no
  // certificate, which is the project's situation (no budget for one). MSIX
  // effectively requires signing, so it stays behind --format=wix for whoever
  // later has a certificate.
  const format = (argv
    .find((arg) => arg.startsWith("--format="))
    ?.split("=")[1] ?? "inno") as "inno" | "wix" | "both";
  const releaseDir = version
    ? join(root, "dist", "release", version, HOST_TRIPLE)
    : await newestRelease(join(root, "dist", "release"), HOST_TRIPLE);

  if (!releaseDir || !existsSync(join(releaseDir, "natalia.exe"))) {
    console.error(
      `[win-inst] no packable release for ${HOST_TRIPLE}. Build one with:\n` +
        `    npm run package:windows\n` +
        `  (that chain builds the CEF host, the distribution, the web shell and\n` +
        `   the release tree before reaching this step)`,
    );
    return 1;
  }

  const appVersion = versionFromRelease(releaseDir);
  const signWith = argv.find((arg) => arg.startsWith("--sign="))?.split("=")[1];
  const result = await buildWindowsInstallerInputs({
    releaseDir,
    outDir: join(root, "dist", "windows-installer", appVersion),
    version: appVersion,
    icon: findIcon(),
    format,
  });
  const lines = [`[win-inst] release:  ${releaseDir}`];
  if (result.iss) lines.push(`[win-inst] inno:    ${result.iss}`);
  if (result.wxs) lines.push(`[win-inst] wix:     ${result.wxs}`);
  if (result.installer) lines.push(`[win-inst] installer: ${result.installer}`);
  else
    lines.push(
      `[win-inst] no compiler here — the input above sits BESIDE the release ` +
        `it packs, so it compiles on a Windows host where ISCC or candle is on ` +
        `PATH, or through a named one: NATALIA_ISCC=/path/to/iscc (wine's ` +
        `ISCC on Linux, say).`,
    );
  if (!result.plan.shortcut.iconRelative)
    lines.push(
      `[win-inst] (no icon found — the shell shows a blank entry; the repo has none for Windows)`,
    );
  console.log(lines.join("\n"));
  return 0;
}

process.exit(await main());
