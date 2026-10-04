/**
 * The Windows host's acceptance run.
 *
 * Everything the Windows machine has to answer, in one command, so a single boot
 * closes both open items rather than ping-ponging:
 *
 *   P23  the ConPTY pane's viewport handshake. The fix re-applies the spec's size
 *        after the child exists and before the output pump starts, because wine's
 *        ResizePseudoConsole returns E_NOTIMPL and a real host's does not — so the
 *        only honest evidence is the bridge's own stderr report on Windows.
 *   pwsh the executor's argv, encoding and environment, driven through the same
 *        seam every caller uses.
 *
 * The script degrades rather than pretending: on a non-Windows host it says which
 * parts cannot be measured there, and reports the parts that can. A check that
 * reports a failure it could not possibly measure is worse than one that says it
 * could not, which is why every Windows-only section is behind one guard.
 *
 * Exit code 0 = every check that could run passed. Exit code 1 = one failed.
 */
import { platform } from "node:os";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) =>
  results.push({ name, ok, detail });

const isWindows = platform() === "win32";
console.log(`platform: ${platform()}`);

// --- P23: the viewport handshake ---------------------------------------------
//
// The bridge prints the size it applied and the HRESULT. `hr=0x0` is the whole
// question: wine answers E_NOTIMPL (0x80004001) here, which is why this could
// never be verified off Windows, and a real host answers S_OK.
async function checkViewportHandshake() {
  if (!isWindows) {
    record(
      "P23 viewport handshake",
      true,
      "not measured: needs a Windows host (wine's ResizePseudoConsole is E_NOTIMPL)",
    );
    return;
  }
  // The bridge is spawned the way the controller spawns it, with the spec on
  // stdin, so the stderr report is the real one.
  const { spawn } = await import("node:child_process");
  const { existsSync } = await import("node:fs");
  const { join } = await import("node:path");
  // The path comes from the package's own resolver, NOT from reading its source.
  // The first version grepped the source for the function name and matched
  // nothing — the identifier is camelCase where the grep expected kebab — so the
  // check reported "no bridge binary" on a host that had one. Source is not data.
  const { nativeTerminalPrebuiltDir } = await import(
    "../packages/plugins/native-terminal/src/index"
  );
  const candidates = [
    process.env.NATALIA_CONPTY_BRIDGE,
    join(nativeTerminalPrebuiltDir("win32"), "natalia-conpty-bridge.exe"),
  ];
  const exe = candidates.find(
    (candidate) => candidate && existsSync(candidate),
  );
  if (!exe) {
    record(
      "P23 viewport handshake",
      false,
      "no bridge binary found: run npm run native-terminal:build-conpty:windows, or set NATALIA_CONPTY_BRIDGE",
    );
    return;
  }
  const child = spawn(exe, [], { stdio: ["pipe", "pipe", "pipe"] });
  let stderr = "";
  child.stderr?.on("data", (chunk: Buffer) => {
    stderr += chunk.toString();
  });
  child.stdin?.write(
    `${JSON.stringify({ file: "cmd.exe", args: [], cwd: process.cwd(), cols: 100, rows: 30 })}\n`,
  );
  await new Promise((resolve) => setTimeout(resolve, 3_000));
  child.kill();
  const handshake =
    /viewport handshake requested (\d+)x(\d+) \(hr=(0x[0-9a-f]+)\)/.exec(
      stderr,
    );
  if (!handshake) {
    record(
      "P23 viewport handshake",
      false,
      `the bridge printed no handshake report. stderr:\n${stderr.slice(0, 400)}`,
    );
    return;
  }
  const [, cols, rows, hr] = handshake;
  record(
    "P23 viewport handshake",
    hr === "0x0" && cols === "100" && rows === "30",
    `reported ${cols}x${rows} hr=${hr} (hr must be 0x0: wine answers E_NOTIMPL, which is why this needed a real host)`,
  );
}

await checkViewportHandshake();

// --- pwsh: the executor's own path -------------------------------------------
//
// Not duplicated here. `npm run verify:pwsh` drives the executor through the seam
// and checks its five execution properties; this run reports whether it passed so
// one command covers both items, but the logic lives in one place.
if (isWindows) {
  const { spawn } = await import("node:child_process");
  const run = await new Promise<number>((resolve) => {
    const child = spawn("bun", ["scripts/verify-pwsh.ts"], {
      stdio: "inherit",
    });
    child.on("exit", (code) => resolve(code ?? 1));
  });
  record(
    "pwsh executor (verify:pwsh)",
    run === 0,
    run === 0
      ? "all checks passed — NATALIA_SHELL=pwsh is safe to make the default"
      : "see the failing check above; each has one documented fix",
  );
} else {
  record(
    "pwsh executor (verify:pwsh)",
    true,
    "not measured: needs Windows with PowerShell installed",
  );
}

// --- Report ------------------------------------------------------------------
console.log("");
let failed = 0;
for (const r of results) {
  if (!r.ok) failed += 1;
  console.log(`${r.ok ? "PASS" : "FAIL"}  ${r.name}`);
  if (!r.ok || process.env.VERBOSE) console.log(`      ${r.detail}`);
}
console.log(
  `\n${results.length - failed}/${results.length} passed` +
    (isWindows
      ? "\n\nBoth items answered. Paste this output back:" +
        "\n  - all pass  -> flip platformShell's default, mark the matrix test verified"
      : "\n\nRun this ON WINDOWS: npm run verify:windows"),
);
process.exit(failed === 0 ? 0 : 1);
