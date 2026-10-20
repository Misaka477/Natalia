/**
 * THE REBUILD: the TypeScript distribution chain, then the install, in one
 * command. Fail-loud, and every skip is printed.
 *
 * The five steps:
 *   1. build:distribution        the TS build + the plugin store's packages
 *   2. build:web                 the web shell
 *   3. release:build             the standalone bundles, self-verified
 *   4. windows:installer-inputs  the Inno Setup installer (Windows only; on
 *                                another platform this step says so instead of
 *                                pretending)
 *   5. install                   copy the release tree into the deployment
 *                                directory AND install the official plugins
 *                                into the runtime's plugin store
 *
 * WHY STEP 5 IS A STEP AND NOT A FOOTNOTE. The runtime does not load plugins
 * from the deployment directory: it loads them from the PLUGIN STORE
 * (`<natalia home>/plugin-store/node_modules/<package>`), and the release
 * tree's `plugins/` is only the source those are copied FROM
 * (`plugin-runtime.ts` installs by `cp`). A build that stops at step 4 has
 * therefore not reached the thing a user runs — the distribution carries the
 * fix and the screen does not. `natalia plugin reconcile` does not close that
 * gap either: it audits the lock and copies nothing. `plugin reinstall` is the
 * verb that copies, and it is run here for every official plugin by name.
 *
 * Flags:
 *   --skip-install   steps 1-4 only. The build is not deployed and the store is
 *                     not touched — the honest "rebuild only".
 *
 * Environment:
 *   NATALIA_DEPLOY_DIR   where the release tree is copied. Required for step 5
 *                        and never assumed: a hard-coded path would make this
 *                        script single-platform, and the deployment directory
 *                        is the one fact this repository cannot know.
 *   NATALIA_ISCC         Inno Setup's compiler, for step 4.
 */

import { spawnSync } from "node:child_process";
import { readdirSync, statSync } from "node:fs";
import { join } from "node:path";
import { OFFICIAL_PLUGIN_PACKAGES } from "../packages/tooling/installer/src/official";
import type { OfficialPluginID } from "../packages/tooling/installer/src/official";

type Step = {
  name: string;
  skipFlag?: string;
  run: () => { ok: boolean; detail?: string };
};

const root = process.cwd();
const npm = process.platform === "win32" ? "npm.cmd" : "npm";
const isWindows = process.platform === "win32";

function command(
  args: string[],
  options: { env?: Record<string, string> } = {},
): { ok: boolean; detail?: string } {
  const result = spawnSync(npm, args, {
    cwd: root,
    encoding: "utf8",
    // The TS build prints one line per package and per plugin; the default
    // 1 MiB buffer overflows, and an overflow surfaces as `status: null` with
    // no output at all — which reads as "the command did nothing" rather than
    // "the command said too much".
    maxBuffer: 64 * 1024 * 1024,
    // `npm` is `npm.cmd` here, and Windows will not spawn a `.cmd` without a
    // shell: the call fails instantly with `status: null` and no output, which
    // is indistinguishable from "the command printed nothing".
    ...(isWindows ? { shell: true } : {}),
    env: { ...process.env, ...options.env },
  });
  // A spawn that never ran has no status to report; without this the failure
  // reads as "exited null" and says nothing about why.
  if (result.error)
    return {
      ok: false,
      detail: `${args.join(" ")} could not be spawned: ${result.error.message}`,
    };
  if (result.status !== 0) {
    const tail = [result.stderr, result.stdout]
      .filter(Boolean)
      .join("\n")
      .split("\n")
      .filter((line) => line.trim())
      .slice(-6)
      .join(" | ");
    return {
      ok: false,
      detail: `${args.join(" ")} exited ${result.status}: ${tail}`,
    };
  }
  return { ok: true };
}

/** The plugins directory of whichever platform release exists. */
function findPluginsDir(): string | undefined {
  const releaseRoot = join(root, "dist", "release");
  let found: string | undefined;
  try {
    for (const entry of readdirSync(releaseRoot)) {
      let versions: string[];
      try {
        versions = readdirSync(join(releaseRoot, entry));
      } catch {
        continue;
      }
      for (const version of versions) {
        const candidate = join(releaseRoot, entry, version, "plugins");
        try {
          if (statSync(candidate).isDirectory()) found = candidate;
        } catch {
          // not this one
        }
      }
    }
  } catch {
    return undefined;
  }
  return found;
}

const steps: Step[] = [
  {
    name: "the TypeScript distribution",
    run: () =>
      command(["run", "build:distribution"], {
        env: { NATALIA_BUILD_SKIP_NATIVE: "1" },
      }),
  },
  { name: "the web shell", run: () => command(["run", "build:web"]) },
  {
    name: "the standalone releases",
    run: () => command(["run", "release:build"]),
  },
  {
    name: "the Windows installer",
    run: () => {
      if (!isWindows)
        return {
          ok: true,
          detail:
            "not Windows — the Inno Setup installer is a Windows artifact",
        };
      if (!process.env.NATALIA_ISCC)
        return {
          ok: true,
          detail: "NATALIA_ISCC unset — no Inno Setup compiler named",
        };
      return command(["run", "windows:installer-inputs"]);
    },
  },
  {
    name: "install into the running deployment",
    skipFlag: "--skip-install",
    run: () => {
      const deployDir = process.env.NATALIA_DEPLOY_DIR;
      if (!deployDir)
        return {
          ok: false,
          detail:
            "NATALIA_DEPLOY_DIR is unset — name the directory the release tree goes into, or pass --skip-install to build only",
        };
      const pluginsDir = findPluginsDir();
      if (!pluginsDir)
        return {
          ok: false,
          detail:
            "no plugins directory under dist/release — the release step did not produce one",
        };
      const platformDir = join(pluginsDir, "..");
      const copied = isWindows
        ? spawnSync("robocopy", [platformDir, deployDir, "/MIR"], {
            encoding: "utf8",
          })
        : spawnSync("cp", ["-r", `${platformDir}/.`, deployDir], {
            encoding: "utf8",
          });
      // robocopy reports success as any status below 8.
      const copyOk = isWindows
        ? copied.status !== null && copied.status < 8
        : copied.status === 0;
      if (!copyOk)
        return {
          ok: false,
          detail: `copying ${platformDir} into ${deployDir} exited ${String(copied.status)} — is an instance running?`,
        };
      // THE STEP THAT WAS MISSING. The runtime loads from the store, so every
      // official plugin is installed into it by id. The id comes from the
      // OFFICIAL TABLE, keyed by the distribution directory: the two are
      // different names for the same plugin (`natalia-browser` on disk is
      // `natalia-tool-browser` as an id), and a directory-derived name is
      // refused with "unknown official plugin". A directory the table does not
      // name is skipped WITH ITS REASON rather than failing the install — the
      // release tree can carry a plugin the official table does not manage.
      const byDirectory = new Map<string, OfficialPluginID>(
        OFFICIAL_PLUGIN_PACKAGES.map((entry) => [entry.directory, entry.id]),
      );
      const exe = join(deployDir, isWindows ? "natalia.exe" : "natalia");
      const names = readdirSync(pluginsDir);
      const unmanaged: string[] = [];
      for (const name of names) {
        const id = byDirectory.get(name);
        if (!id) {
          unmanaged.push(name);
          continue;
        }
        const result = spawnSync(exe, ["plugin", "reinstall", id], {
          encoding: "utf8",
          maxBuffer: 16 * 1024 * 1024,
        });
        if (result.status !== 0)
          return {
            ok: false,
            detail: `plugin reinstall ${id} exited ${result.status}: ${[
              result.stderr,
              result.stdout,
            ]
              .filter(Boolean)
              .join(" ")
              .slice(-300)}`,
          };
      }
      const skippedNote = unmanaged.length
        ? `; not in the official table, left alone: ${unmanaged.join(", ")}`
        : "";
      return {
        ok: true,
        detail: `${platformDir} → ${deployDir}; ${names.length - unmanaged.length} official plugins installed into the store${skippedNote}`,
      };
    },
  },
];

const argv = process.argv.slice(2);
const skipped = new Set(argv);
const unknown = argv.filter(
  (arg) => arg.startsWith("--") && !steps.some((step) => step.skipFlag === arg),
);
if (unknown.length > 0) {
  console.error(`unknown flag(s): ${unknown.join(", ")}`);
  process.exit(2);
}

console.log("rebuilding the TypeScript distribution\n");
const results: Array<{ name: string; state: string }> = [];
for (const [index, step] of steps.entries()) {
  const label = `[${index + 1}/${steps.length}] ${step.name}`;
  if (step.skipFlag && skipped.has(step.skipFlag)) {
    console.log(`SKIP  ${label}`);
    results.push({ name: step.name, state: "skipped" });
    continue;
  }
  const started = Date.now();
  const outcome = step.run();
  const seconds = ((Date.now() - started) / 1000).toFixed(0);
  if (!outcome.ok) {
    console.log(`FAIL  ${label} (${seconds}s)`);
    console.log(`      ${outcome.detail}`);
    results.push({ name: step.name, state: "failed" });
    break; // fail-loud: a half-installed build is worse than none
  }
  console.log(
    `ok    ${label} (${seconds}s)${outcome.detail ? ` — ${outcome.detail}` : ""}`,
  );
  results.push({ name: step.name, state: "ok" });
}

const failed = results.filter((result) => result.state === "failed");
if (failed.length > 0) {
  console.error(`\nREBUILD FAILED at: ${failed[0]!.name}`);
  process.exit(1);
}
console.log(
  skipped.has("--skip-install")
    ? "\nREBUILD OK — built, NOT installed (pass no flag to install)"
    : "\nREBUILD OK — built and installed",
);
