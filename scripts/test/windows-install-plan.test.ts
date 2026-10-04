import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { planWindowsInstall, planIsInstallable } from "../windows-install-plan";

/**
 * The installer's data, derived rather than declared.
 *
 * Every pin here guards a way an installer can be complete on paper and useless
 * in practice: a manifest that forgets a directory the app needs, a shortcut that
 * points at the wrong process, or an uninstall entry the shell cannot read.
 */

async function fakeWindowsRelease() {
  const root = await mkdtemp(join(tmpdir(), "natalia-win-release-"));
  await mkdir(join(root, "libcef-bin"), { recursive: true });
  await mkdir(join(root, "resources", "plugins"), { recursive: true });
  await writeFile(join(root, "natalia.exe"), "runtime\n");
  await writeFile(join(root, "natalia-cef-desktop.exe"), "cef\n");
  // The launcher EXE the Start Menu entry runs: the one parent process that
  // starts the runtime, the web server and the window host as its job-owned
  // children. A release without it has a shortcut to a process that cannot show
  // a window on its own.
  await writeFile(join(root, "natalia-launcher.exe"), "launcher\n");
  await writeFile(join(root, "libcef-bin", "libcef.dll"), "lib\n");
  await writeFile(join(root, "libcef-bin", "chrome_100_percent.pak"), "pak\n");
  await writeFile(join(root, "resources", "plugin.js"), "ui\n");
  await writeFile(join(root, "resources", "plugins", "one.js"), "p\n");
  await writeFile(join(root, "composition.base.json"), "{}\n");
  // The icon, shipped beside the binaries where the shortcut resolves it.
  await writeFile(join(root, "icon.ico"), "ico\n");
  await writeFile(join(root, "SHA256SUMS"), "abc\n");
  await writeFile(join(root, "install.ps1"), "# not installed\n");
  return root;
}

test("the plan lists the release's whole tree, and none of its bookkeeping", async () => {
  const release = await fakeWindowsRelease();
  const plan = await planWindowsInstall({ releaseDir: release });

  const targets = plan.files.map((file) => file.target);
  // Derived, not declared: a release that gains a plugin cannot produce an
  // installer that drops it.
  expect(targets).toContain("natalia.exe");
  expect(targets).toContain("libcef-bin\\libcef.dll");
  expect(targets).toContain("libcef-bin\\chrome_100_percent.pak");
  expect(targets).toContain("resources\\plugins\\one.js");
  // Backslashes, because these are Windows paths inside an install root.
  expect(targets.every((target) => !target.includes("/"))).toBe(true);
  // The release's own bookkeeping never lands on the user's disk.
  expect(targets).not.toContain("SHA256SUMS");
  expect(targets).not.toContain("install.ps1");
});

test("the shortcut runs the stack, not a process that cannot show a window alone", async () => {
  const release = await fakeWindowsRelease();
  const plan = await planWindowsInstall({ releaseDir: release });
  // The launcher, NOT the CEF host and NOT the compiled runtime.
  //
  // `natalia.exe` is a CLI: a shortcut pointed at it opens a status dump. The
  // CEF host alone is worse than useless — its only URL is the dev server at
  // 127.0.0.1:5178, which nothing in an install listens on, so it exits and the
  // user sees "it will not open". The launcher starts the runtime AND the web
  // server first and then hands the host a URL that exists, which is the only
  // shape that produces a window.
  expect(plan.shortcut.targetRelative).toBe("natalia-launcher.exe");
  expect(
    plan.files.some((f) => f.target === plan.shortcut.targetRelative),
  ).toBe(true);
});

test("the uninstall entry is something the shell can read", async () => {
  const release = await fakeWindowsRelease();
  const plan = await planWindowsInstall({
    releaseDir: release,
    version: "9.9.9",
    publisher: "Misaka477",
  });
  const { uninstall } = plan;
  // Apps & features reads these by name; a missing DisplayVersion shows as an
  // unversioned entry that cannot be upgraded.
  expect(uninstall.displayName).toBe("Natalia 9.9.9");
  expect(uninstall.displayVersion).toBe("9.9.9");
  expect(uninstall.publisher).toBe("Misaka477");
  // A real size, not 0 — the shell shows "unknown size" otherwise.
  expect(uninstall.estimatedSizeKB).toBeGreaterThan(0);
  // Both forms, so a silent uninstall is possible.
  expect(uninstall.uninstallString).toContain("uninstall.exe");
  expect(uninstall.quietUninstallString).toContain("/S");
});

test("the upgrade code is stable across versions", async () => {
  // It is the identity "this product", independent of version: a code that
  // changes per build makes every release a stranger to the last, and 1.2 ends up
  // installed beside 1.1 instead of replacing it.
  const release = await fakeWindowsRelease();
  const first = await planWindowsInstall({
    releaseDir: release,
    version: "1.0",
  });
  const second = await planWindowsInstall({
    releaseDir: release,
    version: "2.0",
  });
  expect(first.uninstall.upgradeCode).toBe(second.uninstall.upgradeCode);
  // And it looks like the GUID shape Windows wants.
  expect(first.uninstall.upgradeCode).toMatch(
    /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-a[0-9a-f]{3}-[0-9a-f]{12}$/u,
  );
});

test("a release without the runtime is refused", async () => {
  // `natalia.exe` is what the launcher starts; without it the install is an icon
  // that opens nothing.
  const root = await mkdtemp(join(tmpdir(), "natalia-win-broken-"));
  await writeFile(join(root, "natalia-cef-desktop.exe"), "cef\n");
  // No natalia.exe — that is the defect being guarded.
  let threw = "";
  try {
    await planWindowsInstall({ releaseDir: root });
  } catch (error) {
    threw = String(error);
  }
  expect(threw).toContain("has no natalia.exe");
});

test("a plan is installable only when it can actually be launched", async () => {
  const release = await fakeWindowsRelease();
  const plan = await planWindowsInstall({
    releaseDir: release,
    icon: "icon.ico",
  });
  expect(planIsInstallable(plan)).toBe(true);
  // The same plan without an icon is not: the shell shows a blank entry.
  const noIcon = await planWindowsInstall({ releaseDir: release });
  expect(planIsInstallable(noIcon)).toBe(false);
});
