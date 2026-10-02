import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWindowsInstallerInputs,
  renderInnoScript,
  renderWixFragment,
  scriptDeclaresEntryPoints,
  planWindowsInstall,
} from "../windows-installer";
import { planWindowsInstall } from "../windows-install-plan";

/**
 * The installer's inputs, and the two things an installer must never forget.
 *
 * An installer is a promise that the user ends up with an application: it starts,
 * it has a Start Menu entry, and it can be removed. Every pin here is one of
 * those three, plus the one that keeps a release change from silently missing
 * the install.
 */

async function fakeWindowsRelease() {
  const root = await mkdtemp(join(tmpdir(), "natalia-inst-release-"));
  await mkdir(join(root, "libcef-bin"), { recursive: true });
  await mkdir(join(root, "resources", "plugins"), { recursive: true });
  await writeFile(join(root, "natalia.exe"), "rt\n");
  await writeFile(join(root, "natalia-cef-desktop.exe"), "cef\n");
  await writeFile(join(root, "icon.ico"), "ico\n");
  await writeFile(join(root, "libcef-bin", "libcef.dll"), "lib\n");
  await writeFile(join(root, "resources", "plugins", "one.js"), "p\n");
  return root;
}

test("the rendered script carries every derived file", async () => {
  // One line per file from the plan, so a release that gains a plugin cannot
  // produce an installer that drops it.
  const release = await fakeWindowsRelease();
  const plan = await planWindowsInstall({
    releaseDir: release,
    icon: "icon.ico",
  });
  const script = renderInnoScript(plan);
  for (const file of plan.files) {
    const name = file.target.slice(file.target.lastIndexOf("\\") + 1);
    expect(script, `missing ${name}`).toContain(`DestName: "${name}"`);
  }
});

test("the script declares the entry points a normal application has", async () => {
  const release = await fakeWindowsRelease();
  const plan = await planWindowsInstall({
    releaseDir: release,
    icon: "icon.ico",
  });
  const script = renderInnoScript(plan);
  expect(scriptDeclaresEntryPoints(script)).toBe(true);
  // The Start Menu entry, and it points at the process with a window.
  expect(script).toContain("[Icons]");
  expect(script).toContain("natalia-cef-desktop.exe");
  // An uninstaller, so Apps & features has a way out.
  expect(script).toContain("Uninstallable=yes");
  expect(script).toContain("UninstallString");
  // And nothing that tells the user to run something after installing.
  expect(script).not.toContain("install.ps1");
  const runSection = script.slice(script.indexOf("[Run]"));
  expect(runSection.trim()).toBe("[Run]");
});

test("the upgrade code binds the install, so a version replaces its predecessor", async () => {
  const release = await fakeWindowsRelease();
  const plan = await planWindowsInstall({
    releaseDir: release,
    icon: "icon.ico",
  });
  const script = renderInnoScript(plan);
  // Inno: AppId. WiX: UpgradeCode. Both come from the same stable fact.
  expect(script).toContain(`AppId={{${plan.uninstall.upgradeCode}}`);
  const wxs = renderWixFragment(plan);
  expect(wxs).toContain(`UpgradeCode="{${plan.uninstall.upgradeCode}}"`);
  expect(wxs).toContain("MajorUpgrade");
});

test("a build without a compiler writes the inputs rather than failing", async () => {
  // Inno and WiX are Windows-only tools. The inputs are what a Windows build
  // needs; producing them is the deliverable everywhere else.
  const release = await fakeWindowsRelease();
  const out = await mkdtemp(join(tmpdir(), "natalia-inst-out-"));
  const result = await buildWindowsInstallerInputs({
    releaseDir: release,
    outDir: out,
    version: "9.9.9",
    icon: join(release, "icon.ico"),
  });
  expect(existsSync(result.iss!)).toBe(true);
  expect(existsSync(result.wxs!)).toBe(true);
  if (Bun.which("ISCC") === null && Bun.which("candle") === null) {
    expect(result.compiled).toBe(false);
    expect(result.installer).toBeUndefined();
  }
});

test("a release that is not one is refused before writing anything", async () => {
  const empty = await mkdtemp(join(tmpdir(), "natalia-inst-empty-"));
  const out = await mkdtemp(join(tmpdir(), "natalia-inst-out-"));
  let threw = "";
  try {
    await buildWindowsInstallerInputs({ releaseDir: empty, outDir: out });
  } catch (error) {
    threw = String(error);
  }
  expect(threw).toContain("does not look like a release directory");
});

test("the rendered script's Source paths are release-relative", async () => {
  // An absolute path bakes the build machine into the script, so the same .iss
  // cannot be compiled on the Windows host that has the tree. Found by rendering
  // from a real 91 MB release and reading the output.
  const release = await fakeWindowsRelease();
  const plan = await planWindowsInstall({
    releaseDir: release,
    icon: "icon.ico",
  });
  for (const file of plan.files)
    expect(file.source, `${file.target} must be relative`).not.toMatch(
      /^([A-Za-z]:)?[\\/]/u,
    );
  const script = renderInnoScript(plan);
  for (const line of script.split("\n"))
    if (line.startsWith("Source:")) expect(line).not.toContain(release);
  // And every file still gets a line, subdirectories included.
  expect(script).toContain('DestDir: "{app}\\libcef-bin"');
  expect(script).toContain('DestDir: "{app}\\resources\\plugins"');
});
