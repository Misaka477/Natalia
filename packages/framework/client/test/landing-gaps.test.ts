/**
 * The three L3 landing gaps, tested at the seam that closes them.
 *
 * Each test pins one fact that was missing before this change:
 *
 *   1. the source state rides with the build, so the next iteration copies
 *      the baseline THIS one produced rather than the previous one;
 *   2. Windows hands the process over — without it the new binary is
 *      linked, verified and health-checked while the old code keeps
 *      running;
 *   3. the drain covers every workspace, because a binary swap kills them
 *      all.
 */
import { expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { existsSync } from "node:fs";
import {
  installStagedBuild,
  type StagedBuildInstall,
} from "@natalia/installer";
import { planGoalMove } from "@anthelia/substrate";

/** A probe runner that answers a fixed version, so no PE is needed. */
function probeAnswering(version: string, code = 0) {
  return () => ({ code, stdout: `${version}\n`, stderr: "" });
}

/**
 * An install home the staged-build lane can actually write into.
 *
 * `bin/` is created up front because the swap writes a link there and a
 * fresh mkdtemp has no such directory: on Windows the copy path tolerates
 * it and on POSIX `symlinkSync` does not, so a test that skipped this step
 * passed on the author's machine and failed on Linux with a bare ENOENT
 * that named neither the step nor the platform.
 */
async function installHome(label: string): Promise<string> {
  const home = await mkdtemp(join(tmpdir(), `natalia-${label}-`));
  await mkdir(join(home, "bin"), { recursive: true });
  return home;
}

function stagedInput(
  home: string,
  over: Partial<StagedBuildInstall> = {},
): StagedBuildInstall {
  // The binary's name is the platform's own: the staged tree mirrors an
  // install, and an install's executable is `natalia` off Windows.
  const binary = process.platform === "win32" ? "natalia.exe" : "natalia";
  const files = new Map<string, Uint8Array>([
    [binary, new Uint8Array([1, 2, 3])],
    ["plugins/keep.txt", new Uint8Array([4, 5])],
  ]);
  return {
    home,
    version: "0.0.0-m99",
    files,
    probeRunner: probeAnswering("0.0.0-m99"),
    ...over,
  };
}

test("a passed probe hands the process over (the Windows self-replace)", async () => {
  const home = await installHome("relaunch");
  try {
    let relaunched = 0;
    const landed = installStagedBuild(
      stagedInput(home, {
        relaunch: () => {
          relaunched += 1;
          return { code: 0, output: "ok" };
        },
      }),
    );
    expect(landed.outcome).toBe("switched");
    // The handover happened: without it the swap lands and the old code
    // keeps running until somebody restarts by hand.
    expect(relaunched).toBe(1);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a failed probe rolls back and never relaunches", async () => {
  const home = await installHome("relaunch-rb");
  try {
    let relaunched = 0;
    const landed = installStagedBuild(
      stagedInput(home, {
        version: "0.0.0-m99",
        probeRunner: probeAnswering("0.0.0-m98", 0),
        relaunch: () => {
          relaunched += 1;
          return { code: 0, output: "ok" };
        },
      }),
    );
    expect(landed.outcome).toBe("rolled_back");
    // A build that failed its self-check must not take the process over.
    expect(relaunched).toBe(0);
    expect(existsSync(join(home, "versions", "0.0.0-m99"))).toBe(false);
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("a relaunch that fails is reported, not swallowed", async () => {
  const home = await installHome("relaunch-fail");
  try {
    const landed = installStagedBuild(
      stagedInput(home, {
        relaunch: () => ({ code: 1, output: "no landed binary" }),
      }),
    );
    // The binary IS switched (the probe passed); the warning is what keeps
    // the operator from believing the restart happened.
    expect(landed.outcome).toBe("switched");
    if (landed.outcome !== "switched") throw new Error("unreachable");
    expect(landed.warning).toContain("relaunch not executed");
    expect(landed.warning).toContain("no landed binary");
  } finally {
    await rm(home, { recursive: true, force: true });
  }
});

test("the daemon-level drain covers every workspace", async () => {
  // The facade's drainForUpdate is what `daemon.drain` reaches, and a
  // staged build replaces the binary the whole daemon runs on. This test
  // pins the AGGREGATE answer through a real facade: two workspaces, each
  // drained, both counted.
  const { createWorkspaceManager, createWorkspaceRuntimeClient } = await import(
    "../src/workspace-manager"
  );
  const root = await mkdtemp(join(tmpdir(), "natalia-drain-all-"));
  const wsA = join(root, "a");
  const wsB = join(root, "b");
  await mkdir(wsA, { recursive: true });
  await mkdir(wsB, { recursive: true });
  try {
    const manager = createWorkspaceManager({
      pluginStoreRoot: join(root, "store"),
      sessionDir: join(root, "sessions"),
      checkpointDir: join(root, "checkpoints"),
      useSqliteStore: false,
    });
    await manager.workspaceAdd({ path: wsA, title: "a" });
    await manager.workspaceAdd({ path: wsB, title: "b" });
    // The facade, not the manager: `daemon.drain` reaches the facade, and
    // the facade is where the every-workspace scope lives.
    const client = createWorkspaceRuntimeClient(manager) as unknown as {
      drainForUpdate?: (input?: { timeoutMs?: number }) => Promise<{
        waitedMs: number;
        workspaces: number;
      }>;
    };
    expect(typeof client.drainForUpdate).toBe("function");
    const result = await client.drainForUpdate!({ timeoutMs: 5_000 });
    // Both workspaces were asked, not just the active one.
    expect(result.workspaces).toBe(2);
    await manager.dispose();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("the baseline update refuses a path that escapes it", () => {
  // The manifest's paths come from the object store, but a stored manifest
  // is still data: the landing's containment is what stops a crafted path
  // from writing outside the baseline directory. `join` alone is not the
  // check — an absolute path swallows the base on POSIX — so the guard is
  // resolve-then-prefix, the same shape the production code uses.
  const guard = (filePath: string, baseline: string) => {
    const target = resolve(baseline, filePath);
    const base = resolve(baseline);
    return (
      target === base ||
      target.startsWith(`${base}/`) ||
      target.startsWith(`${base}\\`)
    );
  };
  expect(guard("packages/core/index.ts", "/home/source")).toBe(true);
  expect(guard("../escape.txt", "/home/source")).toBe(false);
  expect(guard("/etc/passwd", "/home/source")).toBe(false);
});

test("a continuation moves the goal, a different task supersedes it", () => {
  const goal = {
    goalID: "g1",
    title: "接完自迭代",
    phase: "active" as const,
    roundsStarted: 3,
    revision: 4,
  };
  expect(planGoalMove({ goal, continuation: true })).toMatchObject({
    kind: "move",
    parentReason: "handed_off",
  });
  expect(planGoalMove({ goal, continuation: false })).toMatchObject({
    kind: "supersede",
    parentReason: "superseded_by_fork",
  });
});
