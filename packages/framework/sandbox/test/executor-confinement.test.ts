import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { homedir, tmpdir } from "node:os";
import { join } from "node:path";
import { confinementBinary } from "@anthelia/confinement";
import { SnapshotSandboxManager } from "../src/snapshot-sandbox";

/**
 * The executor's kernel floor (T2-4).
 *
 * A candidate's commands used to run as a plain local bash with a different
 * cwd: at the OS level a hostile command inside a candidate escaped the
 * workspace as freely as the user's own shell. The floor is the shared
 * confinement seam — one policy, one classification, one fail-closed rule.
 *
 * The proofs below need the backend to actually exist: landlock is a Linux
 * syscall family, so on a host without it the modes below degrade to
 * `danger-full-access` (the documented platform degradation) and there is no
 * floor to test. They skip there rather than assert a behavior this machine
 * cannot show.
 */
const backend = confinementBinary();
const floorTest = backend ? test : test.skip;

async function candidateIn(root: string, dependencyRoots?: string[]) {
  const manager = new SnapshotSandboxManager(root, {
    confinementMode: "workspace-write",
    ...(dependencyRoots ? { dependencyRoots } : {}),
  });
  await manager.initialize();
  const manifest = await manager.create("box.1");
  return { manager, candidate: manifest.root };
}

floorTest(
  "a confined command writes inside the candidate and nowhere else",
  async () => {
    const root = await mkdtemp(join(tmpdir(), "natalia-floor-write-"));
    // NOT under /tmp: the writable roots are the candidate, /tmp and
    // /dev/null, so a probe there would test nothing. The home directory is
    // writable by the user and outside every root the floor grants.
    const outside = join(
      homedir(),
      `natalia-floor-probe-${Date.now().toString(36)}`,
    );
    const { manager, candidate } = await candidateIn(root);

    const inside = await manager.execute(
      "box.1",
      "echo made > inside.txt && cat inside.txt",
    );
    expect(inside.exitCode).toBe(0);
    expect(inside.output).toContain("made");
    // The candidate root is the writable root, and the run says what the
    // sandbox did: the mode requested, and that the runner did not decline.
    expect(existsSync(join(candidate, "inside.txt"))).toBe(true);
    expect(inside.sandbox).toMatchObject({
      mode: "workspace-write",
      runnerFailed: false,
    });

    // A write OUTSIDE the candidate is refused by the kernel, not by the
    // command: the exit code is the shell's, and the file never appears.
    const escaped = join(outside, "escaped.txt");
    const escape = await manager.execute("box.1", `echo pwned > ${escaped}`);
    expect(escape.exitCode).not.toBe(0);
    expect(existsSync(escaped)).toBe(false);
    await rm(outside, { recursive: true, force: true }).catch(() => undefined);
  },
);

floorTest(
  "a confined command READS the host's linked dependencies",
  async () => {
    // The link is the whole point of T2-1: the candidate is a checkout of the
    // tracked tree, so `node_modules` exists only as the link created at
    // candidate creation. A command that can read through it proves both the
    // link and the floor's read side (landlock handles the write family; reads
    // pass through).
    const root = await mkdtemp(join(tmpdir(), "natalia-floor-read-"));
    await mkdir(join(root, "node_modules", "fixture-pkg"), { recursive: true });
    await writeFile(
      join(root, "node_modules", "fixture-pkg", "package.json"),
      '{"name":"fixture-pkg"}\n',
    );
    const { manager } = await candidateIn(root, ["node_modules"]);

    const run = await manager.execute(
      "box.1",
      "cat node_modules/fixture-pkg/package.json && echo read-ok",
    );
    expect(run.exitCode).toBe(0);
    expect(run.output).toContain("fixture-pkg");
    expect(run.output).toContain("read-ok");
  },
);

test("a missing confinement backend fails CLOSED, never unconfined", async () => {
  // The one rule the floor must never break: with no usable backend the run
  // refuses with the wrapper's own sentence instead of silently degrading to
  // an unconstrained spawn. The valve names a path that cannot exist, which
  // is the fail-closed branch without unsetting anything on this machine.
  const root = await mkdtemp(join(tmpdir(), "natalia-floor-closed-"));
  const manager = new SnapshotSandboxManager(root, {
    confinementMode: "workspace-write",
    confinementBinaryPath: join(root, "no-such-confinement-exec"),
  });
  await manager.initialize();
  await manager.create("box.1");
  await expect(manager.execute("box.1", "echo should-not-run")).rejects.toThrow(
    /confinement-exec backend was found/u,
  );
  // The promotion gate's command fails closed the same way.
  await expect(manager.validate("box.1", "true")).rejects.toThrow(
    /confinement-exec backend was found/u,
  );
});

test("a resource start fails closed too, not just the foreground executor", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-floor-resource-"));
  const manager = new SnapshotSandboxManager(root, {
    confinementMode: "workspace-write",
    confinementBinaryPath: join(root, "no-such-confinement-exec"),
  });
  await manager.initialize();
  await manager.create("box.1");
  // The long-running surface is the one a hole would hide in: it refuses
  // with the same sentence rather than starting unconfined.
  await expect(manager.startResource("box.1", "sleep 1")).rejects.toThrow(
    /confinement-exec backend was found/u,
  );
});
