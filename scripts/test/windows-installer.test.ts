import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, utimes } from "node:fs/promises";
import { existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildWindowsInstallerInputs,
  newestRelease,
  renderInnoScript,
  renderWixFragment,
  scriptDeclaresEntryPoints,
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

test("the install turns on close-to-tray, and the uninstall takes it back", async () => {
  // The window host already implements it: NATALIA_MINIMISE_ON_CLOSE makes
  // the close button hide the window while the app keeps running, a tray icon
  // appears only while the window is hidden, and the tray's 退出 entry is the
  // explicit exit that overrides the policy (apps/cef-desktop/src/window-policy.ts,
  // simple_app.cc, simple_tray_win.cc). Without the value being installed the
  // whole surface exists and is unreachable — the installed app exits on close,
  // which is what the user asked to change.
  //
  // HKCU, not HKLM: it is a desktop preference, not an install fact, so one
  // account must not make the choice for every account on a shared machine.
  // `uninsdeletevalue` so uninstalling leaves no residue behind it.
  const release = await fakeWindowsRelease();
  const plan = await planWindowsInstall({
    releaseDir: release,
    icon: "icon.ico",
  });
  const script = renderInnoScript(plan);
  expect(script).toContain(
    'ValueName: "NATALIA_MINIMISE_ON_CLOSE"; ValueData: "1"',
  );
  expect(script).toContain('Subkey: "Environment"');
  expect(script).toContain("uninsdeletevalue");
  // The name the C++ side actually reads (simple_app.cc::MinimiseOnClose) and
  // the TS mirror parses (window-policy.ts::closeActionFromEnv). Spelling it
  // twice here is what keeps a rename in one of them from shipping an
  // installed app whose switch does nothing.
  expect(script).toContain("NATALIA_MINIMISE_ON_CLOSE");
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
  // A compiler NAMED through the environment counts as present: the compile
  // then really runs, which is the point of the variable.
  const named = !!process.env.NATALIA_ISCC || !!process.env.NATALIA_CANDLE;
  if (Bun.which("ISCC") === null && Bun.which("candle") === null && !named) {
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
  // The rendered line, not just the plan's own field. Asserting RELATIVITY here
  // and not merely "does not contain this run's release dir": a path baked from a
  // DIFFERENT machine — `/home/buildmachine/...` — contains no part of the local
  // release path and passes that weaker check. Measured: baking exactly that in
  // turned nothing red.
  for (const line of script.split("\n"))
    if (line.startsWith("Source:")) {
      expect(line).not.toContain(release);
      const source = /Source: "([^"]*)"/.exec(line)?.[1] ?? "";
      expect(source).not.toMatch(/^([A-Za-z]:)?[\\/]/u);
    }
  // And every file still gets a line, subdirectories included.
  expect(script).toContain('DestDir: "{app}\\libcef-bin"');
  expect(script).toContain('DestDir: "{app}\\resources\\plugins"');
});

test("the uninstaller offers to delete the data the app actually writes", async () => {
  const release = await fakeWindowsRelease();
  const result = await buildWindowsInstallerInputs({
    releaseDir: release,
    outDir: await mkdtemp(join(tmpdir(), "win-uninst-")),
    version: "9.9.9",
    icon: "icon.ico",
    format: "inno",
  });
  const script = await Bun.file(result.iss!).text();

  // THE CONTRACT, agreed with the user: data stays in the install folder, and
  // the uninstaller ASKS whether to take it, defaulting to KEEP. A plain
  // uninstall must never silently remove the user's model configuration,
  // sessions and checkpoints, and a keeping uninstall must SAY where they are.
  // The ask lives in InitializeUninstall — the uninstaller's real hook. An
  // earlier version called `InitializeWizardUninstall`, which is not an Inno
  // event at all: the page was never built, the variable stayed nil, and the
  // uninstall died on the nil object with "Could not call proc".
  expect(script).toContain("function InitializeUninstall(): Boolean;");
  // The wrong hook is not DECLARED OR CALLED. Pinning the bare string would
  // also match the comment that records why it was wrong, and that comment is
  // the reason nobody re-introduces it.
  expect(script).not.toContain("procedure InitializeWizardUninstall");
  expect(script).not.toMatch(/^\s*InitializeWizardUninstall/mu);
  // Default keep: the dialog's default button is NO, not YES.
  expect(script).toContain("MB_YESNOCANCEL or MB_DEFBUTTON2, IDNO");
  // Cancel must abort the uninstall, not fall through to keeping.
  expect(script).toContain("IDCANCEL then");
  expect(script).toContain("usPostUninstall");
  expect(script).toContain("DelTree");

  // EVERY root the product writes, because deleting one of them is what left
  // `.natalia` behind after a run of the old uninstaller:
  //   {app}\.natalia            the config home, which is CWD-relative and the
  //                             launcher starts the runtime with the install
  //                             folder as CWD, so it lands in the install.
  //   <profile>\.natalia         the per-user stores, sessions, logs and vault
  //                             (store-paths.ts walks from homedir()).
  //   {localappdata}\natalia     the state tree: the CEF profile, the
  //                             ProcessSingleton lock, terminal state.
  //   {userappdata}\natalia      the roaming config root: global config,
  //                             workspace registry, skills, UI state.
  // Verified on the user's machine: the first two exist, the third holds CEF
  // and wezterm-runtime, the fourth is where globalConfigHome() points.
  expect(script).toContain("ExpandConstant('{app}') + '\\.natalia'");
  expect(script).toContain("UserProfileDir + '\\.natalia'");
  expect(script).toContain("ExpandConstant('{localappdata}') + '\\natalia'");
  expect(script).toContain("ExpandConstant('{userappdata}') + '\\natalia'");

  // The PROMPT, which nothing asserted before: the choice is only informed if
  // the dialog says what is inside the folder. It used to say "Natalia keeps
  // its data in two places" and name `<install>\.natalia` as the
  // configuration home — which stopped being true when the config left the
  // working directory, so the reader was sent looking for data in a directory
  // the product no longer writes.
  expect(script).toContain("Natalia keeps everything in ONE folder");
  expect(script).not.toContain("keeps its data in two places");
  for (const item of [
    "your model configuration",
    "your workspaces, and the sessions in them",
    "session history and checkpoints",
    "the object store that crash recovery reads",
    "skills, installed plugins and caches",
    "the interface layout",
  ])
    expect(script).toContain(item);
  // Deleting is irreversible and the dialog says so.
  expect(script).toContain("Yes    = delete all of it (cannot be undone)");
  // And the other half of the choice: keeping is not losing. This is the
  // promise a reinstall relies on.
  expect(script).toContain("opens where you left off, settings intact");
  // The profile root is the environment variable, not a constant: the name
  // this uninstaller used first is not an Inno constant at all (the compiler
  // rejects it), and the second choice is the per-user program-files
  // directory, which is not the user's home. Neither may come back as an
  // ExpandConstant call; the comments may still name them, because that is
  // what stops the next reader re-introducing them.
  expect(script).toContain("GetEnv('USERPROFILE')");
  expect(script).not.toMatch(/ExpandConstant\('\{userprofile\}/u);
  expect(script).not.toMatch(/ExpandConstant\('\{userpf\}/u);

  // Keeping the data must tell the user where it is, or files survive and
  // nobody is told — which reads exactly like a bug.
  expect(script).toContain("Your data was left in place:");
  // A delete that reports nothing is indistinguishable from one that did nothing.
  const logs = script.match(/Log\('/gu) ?? [];
  expect(logs.length).toBeGreaterThanOrEqual(2);
  // And a lock failure must surface, not vanish.
  expect(script).toContain("SuppressibleMsgBox");
});

test("a silent uninstall removes the program and keeps the data, without asking", async () => {
  // MEASURED, not theorised: a silently installed copy, run once (so the app had
  // created `.natalia` inside the install dir), uninstalled with /VERYSILENT —
  // the uninstaller exited 1 and left all 410 files on disk.
  //
  // The cause was the ask. `InitializeUninstall` showed a message box and took
  // its return value as the answer; under /VERYSILENT a message box is not shown
  // and returns something that is not an answer, which hit the Cancel branch,
  // returned False, and aborted the uninstall.
  //
  // So the guard is on ORDER: `UninstallSilent` must be tested before the box,
  // and the silent path must not be able to reach a Cancel.
  const release = await fakeWindowsRelease();
  const result = await buildWindowsInstallerInputs({
    releaseDir: release,
    outDir: await mkdtemp(join(tmpdir(), "win-silent-uninst-")),
    version: "9.9.9",
    icon: "icon.ico",
    format: "inno",
  });
  const script = await Bun.file(result.iss!).text();
  const hook = script.slice(
    script.indexOf("function InitializeUninstall"),
    script.indexOf("procedure CurUninstallStepChanged"),
  );
  const silentAt = hook.indexOf("UninstallSilent");
  const askAt = hook.indexOf("SuppressibleMsgBox");
  expect(silentAt).toBeGreaterThan(-1);
  expect(askAt).toBeGreaterThan(-1);
  expect(
    silentAt < askAt,
    "the silent test must come before the ask: a message box under /VERYSILENT " +
      "returns a value that is not an answer, and answering it aborted the " +
      "uninstall",
  ).toBe(true);
  // The silent path may not return False: that is what cancelled it.
  const silentBlock = hook.slice(silentAt, askAt);
  expect(silentBlock).toContain("Result := True");
  expect(silentBlock).not.toContain("Result := False");
});

test("no ExpandConstant embeds a path fragment after its constant", async () => {
  // `ExpandConstant('{app}\\.natalia')` renders as `{app}\.natalia`, and Inno's
  // constant scanner reads the constant name only up to the backslash — so the
  // uninstaller died at runtime with `Unknown constant "userprofile"` and deleted
  // nothing. The user hit exactly that, right after the silent-uninstall fix
  // shipped: the fixed branch (silent = keep) had never executed the delete
  // paths in verification, so all six of them were dead code carrying this bug.
  //
  // The shape is wrong, so it is pinned: the constant and the fragment are
  // concatenated, never embedded in one literal.
  const release = await fakeWindowsRelease();
  const result = await buildWindowsInstallerInputs({
    releaseDir: release,
    outDir: await mkdtemp(join(tmpdir(), "win-expand-const-")),
    version: "9.9.9",
    icon: "icon.ico",
    format: "inno",
  });
  const script = await Bun.file(result.iss!).text();
  // Substring form rather than a regex: the pattern is the literal that must not
  // appear, and a plain includes() says so without escaping ambiguity.
  const embedded = [
    "ExpandConstant('{app}\\",
    "ExpandConstant('{userpf}\\",
  ].filter((pattern) => script.includes(pattern));
  expect(
    embedded,
    `ExpandConstant must not embed a path fragment: ${embedded.join(" ; ")}`,
  ).toEqual([]);
  // And the correct shape is present, so the check above is not passing
  // vacuously. The profile root is not a constant at all — see the next test.
  expect(script).toContain("ExpandConstant('{app}') + '\\.natalia'");
  expect(script).toContain("UserProfileDir + '\\.natalia'");
});

test("every ExpandConstant names a constant Inno Setup actually defines", async () => {
  // THE bug: `{userprofile}` is not an Inno Setup constant. The compiler
  // rejects it — ISCC says `Unknown constant "userprofile"` and the compiler
  // DLL does not carry the name — so the uninstaller died on it at runtime,
  // twice, on packages that looked correct because the string shape was right.
  //
  // The conclusion drawn from that crash was ALSO wrong: it was recorded here
  // that Inno spells the user profile directory `{userpf}`. It does not.
  // `{userpf}` is the user's Program Files (its whatsnew.htm groups it with
  // {usercf}, and Setup creates it at startup like an install location), so
  // aiming the profile-data deletion at `{userpf}\\.natalia` named a directory
  // under Program Files that never existed: DirExists was false, nothing was
  // attempted, and C:\\Users\\rapid\\.natalia survived every uninstall. The
  // profile root now comes from GetEnv('USERPROFILE'); see the next test.
  //
  // So the guard is not "the shape is right" but "every name is one Inno
  // defines". The set below is the closed list this script may use.
  const release = await fakeWindowsRelease();
  const result = await buildWindowsInstallerInputs({
    releaseDir: release,
    outDir: await mkdtemp(join(tmpdir(), "win-constants-")),
    version: "9.9.9",
    icon: "icon.ico",
    format: "inno",
  });
  const script = await Bun.file(result.iss!).text();
  const used = new Set(
    [...script.matchAll(/ExpandConstant\('\{([a-z]+)\}'/gu)].map(
      (match) => match[1]!,
    ),
  );
  // The constants Inno Setup 6/7 define that this script is allowed to name.
  // {userpf} is deliberately absent: it is a real constant, but it is the
  // user's Program Files, and naming it for the profile directory is the bug
  // this test now guards against.
  const DEFINED = new Set([
    "app", // {app}
    "commonpf", // {commonpf}
    "uninstallexe", // {uninstallexe}
    "srcexe", // {srcexe}
    "sys", // {sys}
    "win", // {win}
    "tmp", // {tmp}
    "localappdata", // {localappdata}
    "userappdata", // {userappdata} — the roaming config root
    "commonappdata", // {commonappdata}
    "group", // {group}
    "autopf", // {autopf}
    "autocf", // {autocf}
  ]);
  const unknown = [...used].filter((name) => !DEFINED.has(name));
  expect(
    unknown,
    `ExpandConstant names Inno does not define: ${unknown.join(", ")} — ` +
      `the uninstaller will die at runtime on them`,
  ).toEqual([]);
  // And the newly-added targets are in the used set, so this test cannot
  // pass by never exercising them.
  expect(used.has("localappdata")).toBe(true);
  expect(used.has("userappdata")).toBe(true);
});

test("the uninstaller aims at the real user profile, not Program Files", async () => {
  // {userprofile} is not an Inno constant (ISCC: Unknown constant; the
  // compiler DLL does not carry the name) and {userpf} is the user's Program
  // Files. Both were used here in turn, and both left C:\Users\rapid\.natalia
  // behind. The profile root now comes from the USERPROFILE environment
  // variable, which is what the runtime itself uses to place its home data.
  const release = await fakeWindowsRelease();
  const result = await buildWindowsInstallerInputs({
    releaseDir: release,
    outDir: await mkdtemp(join(tmpdir(), "win-profile-")),
    version: "9.9.9",
    icon: "icon.ico",
    format: "inno",
  });
  const script = await Bun.file(result.iss!).text();
  expect(script).toContain("GetEnv('USERPROFILE')");
  expect(script).not.toMatch(/ExpandConstant\('\{userprofile\}/u);
  expect(script).not.toMatch(/ExpandConstant\('\{userpf\}/u);
  // The state tree under LOCALAPPDATA is cleaned too: the CEF profile and
  // the ProcessSingleton lock (which outlives its process and hands the
  // next launch's window to a dead instance), plus terminal runtime state.
  expect(script).toContain("ExpandConstant('{localappdata}') + '\\natalia'");
  // And the roaming config root: global config, workspace registry, skills
  // and UI state, where globalConfigHome() points on Windows.
  expect(script).toContain("ExpandConstant('{userappdata}') + '\\natalia'");
});

test("the Pascal section's column one carries only declarations", async () => {
  // The escape-eating bug this pins: a comment line in the renderer's source
  // held `%USERPROFILE%\.config\natalia`, and in a double-quoted TS string `\.`
  // drops the backslash while `\n` becomes a real newline — so the rendered
  // .iss sprouted a bare line `atalia (both computed by` at column one of the
  // [Code] section, where Pascal expects `begin`. ISCC: "'BEGIN' expected",
  // compile aborted. Every string-containment assertion in this file passed.
  //
  // So the pin is structural, on the RENDERED text: in [Code], a token at
  // column one is a declaration and nothing else.
  const release = await fakeWindowsRelease();
  const plan = await planWindowsInstall({
    releaseDir: release,
    icon: "icon.ico",
  });
  const script = renderInnoScript(plan);
  // `function` belongs here too: it is a declaration exactly like `procedure`,
  // and the uninstall hook has to be one (`InitializeUninstall` returns the
  // Boolean that cancels the uninstall).
  const allowed = ["//", "var", "procedure", "function", "begin", "end"];
  let inCode = false;
  for (const line of script.split("\n")) {
    if (line === "[Code]") {
      inCode = true;
      continue;
    }
    if (inCode && line.startsWith("[")) break; // the next section
    if (!inCode || line.trim() === "" || line.startsWith(" ")) continue;
    expect(
      allowed.some((prefix) => line.startsWith(prefix)),
      `column one carries a stray token: ${JSON.stringify(line)}`,
    ).toBe(true);
  }
});

test("the written inputs sit beside the sources they name", async () => {
  // The Source lines are release-relative on purpose, so the script compiles
  // exactly where it is written. Writing it anywhere else — the previous
  // behaviour, a separate outDir — produced a delivered .iss that failed with
  // "Source file does not exist" on the Windows host the output told to compile
  // it. Found by actually compiling the thing under wine's ISCC.
  const release = await fakeWindowsRelease();
  const outDir = await mkdtemp(join(tmpdir(), "win-beside-"));
  const result = await buildWindowsInstallerInputs({
    releaseDir: release,
    outDir,
    version: "9.9.9",
    icon: "icon.ico",
    format: "inno",
  });
  expect(result.iss!.startsWith(release)).toBe(true);
  expect(existsSync(result.iss!)).toBe(true);
  // And the compiled installer still lands in the deliverable directory.
  if (!result.installer) expect(outDir).not.toContain(result.iss!.slice(0, -4));
});

test("a compiler, when one is named, produces a real Setup.exe", async () => {
  // The end-to-end pin the render tests cannot be: the whole script, accepted
  // by an actual Inno compiler, yielding an installer. Absent a compiler the
  // test says so and skips — CI has none, and a skip that prints its reason is
  // how the tray probe treats the same situation.
  const compiler =
    Bun.which("ISCC") ??
    (process.env.NATALIA_ISCC ? Bun.which(process.env.NATALIA_ISCC) : null);
  if (!compiler) {
    console.warn(
      "skipped: no ISCC on PATH and NATALIA_ISCC unset — the compile step " +
        "runs where a compiler is named (a Windows host, or wine's ISCC)",
    );
    return;
  }
  const release = await fakeWindowsRelease();
  const outDir = await mkdtemp(join(tmpdir(), "win-compile-"));
  const result = await buildWindowsInstallerInputs({
    releaseDir: release,
    outDir,
    version: "9.9.9",
    icon: "icon.ico",
    format: "inno",
  });
  // The function itself ran the compiler (both the script and its sources are
  // in the release tree), and it reported success.
  expect(result.compiled).toBe(true);
  expect(existsSync(result.installer!)).toBe(true);
  // A real installer is not a text file.
  expect(
    (await Bun.file(result.installer!).arrayBuffer()).byteLength,
  ).toBeGreaterThan(100_000);
});

test("the newest release is the one built last, not the one named last", async () => {
  // Measured, not speculated: `candidates.sort()` on the paths picks
  // `uninst` over `0.0.0-m13`, and a leftover scratch release under
  // dist/release hijacked a real installer build with it (it packed the wrong
  // tree and cost a compile cycle). Directory names are not versions, so
  // "newest" has to mean build time.
  const base = await mkdtemp(join(tmpdir(), "natalia-rel-newest-"));
  const tree = async (name: string) => {
    const dir = join(base, name, "windows-x64");
    await mkdir(dir, { recursive: true });
    await writeFile(join(dir, "natalia.exe"), "rt\n");
    return dir;
  };
  const old = await tree("0.0.0-m13");
  const scratch = await tree("uninst");
  // Distinct times on both sides of the comparison, because EQUAL mtimes make
  // the answer the glob's scan order and the test would be pinning nothing.
  const past = new Date(1_000_000_000);
  const future = new Date(2_000_000_000);
  // The version-shaped one is built younger: the scratch one is in the past.
  await utimes(scratch, past, past);
  await utimes(old, future, future);
  expect(await newestRelease(base, "windows-x64")).toBe(old);
  // And when the scratch one IS newer, it wins — same rule, opposite names.
  await utimes(scratch, future, future);
  await utimes(old, past, past);
  expect(await newestRelease(base, "windows-x64")).toBe(scratch);
});

test("no release tree means no answer, not a stale one", async () => {
  expect(
    await newestRelease(
      await mkdtemp(join(tmpdir(), "natalia-rel-none-")),
      "windows-x64",
    ),
  ).toBeUndefined();
});

test("the wizard offers the install directory — the page exists, not just the flag", async () => {
  // P2-1, closed by reading the generated script rather than by a Windows
  // session. Inno's modern wizard shows the directory page UNLESS the script
  // disables it, so the guard is on what the script does NOT contain: any
  // DisableDirPage (or the silent-only pragmas that skip every page) would
  // take the choice away from the user who installs by hand.
  //
  // Two wrong diagnoses are recorded here so they are not repeated:
  //   - "admin skips the directory page" — it does not. The page that went
  //     missing in m13 was a STALE BUILD being run, not this line.
  //   - "lowest fixes it" — it does, but it also drops `{autopf}` to
  //     `%LOCALAPPDATA%\Programs`, so the default silently became a
  //     per-user folder with no product name in it. Wrong trade.
  // The page is kept by `DisableDirPage=no`; the privilege level is chosen
  // for the DEFAULT PATH, which is a separate question.
  const release = await fakeWindowsRelease();
  const plan = await planWindowsInstall({
    releaseDir: release,
    icon: "icon.ico",
  });
  const script = renderInnoScript(plan);
  expect(script).toContain("WizardStyle=modern");
  // The default is this system's Program Files, named through Inno's own
  // constant plus the product's NAME — never a spelled drive or folder,
  // which the user could not change. `{autopf}\{#MyAppInstallDir}` is what
  // makes the default `C:\Program Files\Natalia` rather than the app
  // sitting loose in Program Files.
  expect(script).toContain("DefaultDirName={autopf}\\{#MyAppInstallDir}");
  expect(script).toContain('#define MyAppInstallDir "Natalia"');
  // The directory page is not merely left enabled by default; it is SAID.
  expect(script).toContain("DisableDirPage=no");
  expect(script).not.toContain("DisableDirPage=yes");
  // Per-machine, which is also what resolves `{autopf}` to the real
  // Program Files instead of the per-user one.
  expect(script).toContain("PrivilegesRequired=admin");
  // Nothing suppresses any page: the directory page, the ready page, and the
  // finished page all belong to the user installing by hand.
  expect(script).not.toContain("DisableReadyPage");
  expect(script).not.toContain("DisableFinishedPage");
  expect(script).not.toContain("DisableWelcomePage");
  // And no install path is spelled anywhere: no drive letter, no
  // %ProgramFiles% literal, no `C:\Program Files`. The NAME is allowed; a
  // PATH is not.
  expect(script).not.toMatch(/[A-Z]:\\/u);
  expect(script).not.toContain("%ProgramFiles%");
  expect(script).not.toContain("Program Files");
});
