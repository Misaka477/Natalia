/**
 * Is PowerShell actually usable on this host?
 *
 * The pwsh executor in @anthelia/shell was written without a PowerShell to run it
 * against — no pwsh on the hosts that built it, and none under wine. Its argv, its
 * encoding preamble and its environment overrides are therefore asserted as DATA
 * only. This script is what turns them into facts: run it on the Windows host and
 * it reports, per check, whether the executor will work there.
 *
 * It drives the executor through the same seam every caller uses, so a PASS here
 * means the product path works, not just that pwsh exists.
 *
 * Exit code 0 = every check passed (or was legitimately skipped on a non-Windows
 * host). Exit code 1 = at least one check failed; the output names which.
 */
import { PwshLocalExecutor } from "../packages/core/shell/src/pwsh-local";
import {
  ENCODING_PREAMBLE,
  ENV_OVERRIDES,
} from "../packages/core/shell/src/pwsh-local";

const results: Array<{ name: string; ok: boolean; detail: string }> = [];
const record = (name: string, ok: boolean, detail: string) =>
  results.push({ name, ok, detail });

const isWindows = process.platform === "win32";
console.log(`platform: ${process.platform}`);

const canExecute = isWindows;

const executor = new PwshLocalExecutor();

// --- Construction: verifiable everywhere ------------------------------------
const spec = executor.resolve({ command: "Get-Date" });
record(
  "argv shape",
  JSON.stringify(spec.args) ===
    JSON.stringify([
      "-NoLogo",
      "-NoProfile",
      "-NonInteractive",
      "-Command",
      `${ENCODING_PREAMBLE}Get-Date`,
    ]),
  JSON.stringify(spec.args),
);
record(
  "executable resolves to a name",
  spec.command.length > 0 && !spec.command.includes(" "),
  spec.command,
);
record(
  "environment overrides keep the command from blocking",
  // The EXPECTED VALUES ARE LITERAL, not re-serialised from the module under
  // test. The first version compared spec.env against {...ENV_OVERRIDES} — the
  // same constant the executor uses — so the two sides could never disagree and
  // the check could not fail: deleting PAGER from the executor left it green,
  // measured. A check that cannot fail is worse than no check.
  JSON.stringify(spec.env) ===
    JSON.stringify({ NO_COLOR: "1", PAGER: "cat", GIT_PAGER: "cat" }),
  JSON.stringify(spec.env),
);
record(
  "POSIX detached launcher refuses with a named reason",
  (() => {
    try {
      executor.detachedPosixScript({ command: "x", outputPath: "y" });
      return false;
    } catch (error) {
      return /setsid/.test((error as Error).message);
    }
  })(),
  "refusal names the missing POSIX facilities",
);

// --- Execution: Windows only -------------------------------------------------
// Guarded, not early-exited: the construction checks above still report on any
// host, and this section must not produce FAIL rows on a host that cannot
// possibly run them (which is how the first version read on Linux — five
// failures that were all "no pwsh here").
if (canExecute) {
  const pwsh = spec.command;
  void pwsh;

  /** Run one command through the executor and report its settled result. */
  async function run(command: string) {
    const request = { command };
    const resolved = executor.resolve(request);
    return await executor.run(resolved, request);
  }

  // 1. A nonzero exit resolves with that code, rather than rejecting.
  {
    const run_ = await run("exit 7");
    record(
      "nonzero exit resolves with its code",
      run_.exitCode === 7,
      JSON.stringify(run_.outcome),
    );
  }

  // 2. Non-ASCII output arrives as UTF-8 — what ENCODING_PREAMBLE buys. Without it
  //    Windows PowerShell 5.1 writes the console's OEM code page and this garbles.
  {
    const run_ = await run("Write-Output 'caf\u00e9 \u4e2d\u6587'");
    record(
      "non-ASCII output is UTF-8",
      run_.stdout.includes("caf\u00e9 \u4e2d\u6587"),
      JSON.stringify(run_.stdout.trim()),
    );
  }

  // 3. A pager never starts: ENV_OVERRIDES sets PAGER=cat, so a command that would
  //    page (git log with a pager) must return instead of blocking for a keypress.
  {
    const run_ = await run("Get-ChildItem | Out-Host");
    record(
      "no pager blocks",
      run_.outcome === "exited",
      JSON.stringify(run_.outcome),
    );
  }

  // 4. stderr is captured separately from stdout, the seam reports both.
  {
    const run_ = await run(
      "Write-Output out; [Console]::Error.WriteLine('err')",
    );
    record(
      "stdout and stderr are separate",
      run_.stdout.includes("out") && run_.stderr.includes("err"),
      `stdout=${JSON.stringify(run_.stdout.trim())} stderr=${JSON.stringify(run_.stderr.trim())}`,
    );
  }

  // 5. stdin reaches the child, for a caller that pipes into a command.
  {
    const run_ = await executor.run(
      executor.resolve({
        command: "\$input | Write-Output",
        stdin: "piped-value\n",
      }),
      { command: "\$input | Write-Output", stdin: "piped-value\n" },
    );
    record(
      "stdin reaches the child",
      run_.stdout.includes("piped-value"),
      JSON.stringify(run_.stdout.trim()),
    );
  }
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
    (process.platform === "win32"
      ? `\n\nIf all passed, the pwsh executor is safe to make the Windows default:\n` +
        `flip \`platformShell\` in packages/core/shell/src/select.ts, and the\n` +
        `matrix note in its test file can move from "not verified" to "verified".`
      : ""),
);
process.exit(failed === 0 ? 0 : 1);
