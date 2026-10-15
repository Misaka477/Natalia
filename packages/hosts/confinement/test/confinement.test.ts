import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalPath,
  confinementAvailable,
  confinementBinary,
  confinementSupported,
  enforceableConfinementMode,
  probeConfinement,
  writableRoots,
  wrapConfinedCommand,
} from "../src/index";

const binary = confinementBinary();
const available = binary !== undefined;

// The two directories deliberately live OUTSIDE every writable root except
// the explicit one: the package's test dir is inside the repo (not under
// /tmp), so a workspace-write grant of the workspace root is the only thing
// that lets the confined command write there — and the sibling dir stays
// denied. Proving it inside /tmp would let the always-granted temp root
// pass the test without the workspace rule.
let workspace = "";
let outside = "";

beforeAll(() => {
  const base = join(import.meta.dir, `.confinement-${process.pid}`);
  workspace = join(base, "workspace");
  outside = join(base, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterAll(() => {
  rmSync(join(import.meta.dir, `.confinement-${process.pid}`), {
    recursive: true,
    force: true,
  });
});

function run(command: string, args: string[]) {
  return spawnSync(command, args, { encoding: "utf8" });
}

test("read-only grants nothing but /dev/null", () => {
  expect(writableRoots("read-only")).toEqual(["/dev/null"]);
});

test("workspace-write is canonical, deduplicated and covers temp + workspace", () => {
  const roots = writableRoots("workspace-write", workspace);
  expect(roots).toContain(canonicalPath(workspace));
  expect(roots).toContain(canonicalPath("/tmp"));
  expect(roots).toContain("/dev/null");
  expect(new Set(roots).size).toBe(roots.length);
});

test("danger-full-access needs no backend and returns the raw command", () => {
  // The degradation path: on a platform whose rungs are not built, only
  // danger may run — and it must still be runnable.
  const wrapped = wrapConfinedCommand({
    mode: "danger-full-access",
    command: "/bin/echo",
    args: ["hi"],
    binaryPath: "/nonexistent/confinement-exec",
  });
  expect(wrapped).toEqual({ command: "/bin/echo", args: ["hi"] });
});

test("a confined mode fails closed when no backend exists", () => {
  expect(
    wrapConfinedCommand({
      mode: "workspace-write",
      workspaceRoot: workspace,
      command: "/bin/echo",
      args: ["hi"],
      binaryPath: "/nonexistent/confinement-exec",
    }),
  ).toBeUndefined();
});

test("the wrapper argv carries every writable root and rlimit", () => {
  if (!available) return;
  const wrapped = wrapConfinedCommand({
    mode: "workspace-write",
    workspaceRoot: workspace,
    rlimits: { fsize: 4096, nproc: 64 },
    command: "/bin/echo",
    args: ["hi"],
  });
  expect(wrapped?.command).toBe(binary);
  const argv = wrapped!.args;
  expect(argv.filter((a) => a === "--read-write").length).toBe(
    writableRoots("workspace-write", workspace).length,
  );
  expect(argv).toContain("fsize=4096");
  expect(argv).toContain("nproc=64");
  expect(argv.indexOf("--")).toBe(argv.length - 3);
  expect(argv.slice(-2)).toEqual(["/bin/echo", "hi"]);
});

test("probe reports a working landlock backend (gated on the binary)", () => {
  if (!available) return;
  const probe = probeConfinement();
  expect(probe).not.toBeUndefined();
  expect(probe!.landlockABI).toBeGreaterThanOrEqual(1);
  expect(probe!.functional).toBe(true);
  expect(confinementAvailable()).toBe(true);
});

test("probe returns undefined for a missing binary", () => {
  expect(probeConfinement("/nonexistent/confinement-exec")).toBeUndefined();
});

test("workspace-write allows the workspace and denies its sibling", () => {
  if (!available) return;
  const inside = join(workspace, "allowed.txt");
  const blocked = join(outside, "denied.txt");
  const granted = wrapConfinedCommand({
    mode: "workspace-write",
    workspaceRoot: workspace,
    command: "/bin/sh",
    args: ["-c", `echo ok > "${inside}" && echo bad > "${blocked}"`],
  });
  expect(granted).not.toBeUndefined();
  const result = run(granted!.command, granted!.args);
  expect(result.status).not.toBe(0);
  expect(existsSync(inside)).toBe(true);
  expect(existsSync(blocked)).toBe(false);
});

test("read-only denies writes even inside the workspace", () => {
  if (!available) return;
  const target = join(workspace, "ro-denied.txt");
  const wrapped = wrapConfinedCommand({
    mode: "read-only",
    workspaceRoot: workspace,
    command: "/bin/sh",
    args: ["-c", `echo x > "${target}"`],
  });
  expect(wrapped).not.toBeUndefined();
  const result = run(wrapped!.command, wrapped!.args);
  expect(result.status).not.toBe(0);
  expect(existsSync(target)).toBe(false);
});

test("the fsize rlimit caps the write (SIGXFSZ at the ceiling)", () => {
  if (!available) return;
  const target = join(workspace, "big.bin");
  const wrapped = wrapConfinedCommand({
    mode: "workspace-write",
    workspaceRoot: workspace,
    rlimits: { fsize: 1024 },
    command: "/bin/sh",
    args: ["-c", `head -c 8192 /dev/zero > "${target}"`],
  });
  expect(wrapped).not.toBeUndefined();
  run(wrapped!.command, wrapped!.args); // killed by SIGXFSZ or capped
  expect(existsSync(target)).toBe(true);
  expect(readFileSync(target).byteLength).toBeLessThanOrEqual(1024);
});

test("danger-full-access runs unconfined (no wrapper needed)", () => {
  const target = join(outside, "danger.txt");
  // The host's own runtime as the command, and a file write as the effect:
  // the point of this case is that the wrapper returns the command
  // UNCHANGED and it runs, so the command only has to be one the host can
  // spawn. /bin/sh is not a Windows path (the spawn failed with status
  // undefined), and cmd's redirect refuses a quoted target, so a shell
  // spelling buys a quoting problem on one host or the other. The Landlock
  // cases above stay gated on the binary; this one has no backend to gate
  // on, so it asks a question every host can answer instead of skipping.
  const command = process.execPath;
  const args = [
    "-e",
    `require("node:fs").writeFileSync(${JSON.stringify(target)}, "ok")`,
  ];
  const wrapped = wrapConfinedCommand({
    mode: "danger-full-access",
    command,
    args,
  });
  expect(wrapped).toEqual({ command, args });
  const result = run(wrapped!.command, wrapped!.args);
  expect(result.status).toBe(0);
  expect(existsSync(target)).toBe(true);
});

test("the unavailable backend is reported, not faked", () => {
  // The honest-reporting discipline: capability is a fact we measured.
  if (!available) expect(probeConfinement()).toBeUndefined();
  else expect(typeof probeConfinement()!.landlockABI).toBe("number");
});

/**
 * The platform gate: which modes a host can ENFORCE, not which it can ask for.
 *
 * The two questions have different answers, and the shipped code used to answer
 * only the first. The composition base profile ships `workspace-write` for every
 * platform, the seam fail-closed on a host with no rung, and the shell tool then
 * threw "the command could not be started" for EVERY command on Windows and macOS.
 * This is the half that was missing.
 */
test("the rung exists on Linux and nowhere else", () => {
  expect(confinementSupported("linux")).toBe(true);
  expect(confinementSupported("win32")).toBe(false);
  expect(confinementSupported("darwin")).toBe(false);
  expect(confinementSupported("freebsd")).toBe(false);
  // And the default asks about THIS host.
  expect(confinementSupported()).toBe(process.platform === "linux");
});

test("danger-full-access is enforceable everywhere, by definition", () => {
  for (const os of ["linux", "win32", "darwin"] as NodeJS.Platform[])
    expect(enforceableConfinementMode("danger-full-access", os)).toBe(
      "danger-full-access",
    );
});

test("a confined mode is enforceable where the rung exists", () => {
  expect(enforceableConfinementMode("workspace-write", "linux")).toBe(
    "workspace-write",
  );
  expect(enforceableConfinementMode("read-only", "linux")).toBe("read-only");
});

test("a confined mode degrades on a host with no rung — not fail-closed into nothing", () => {
  // THE bug this gate closes: without it, every confined exec on a rung-less host
  // reached the fail-closed branch and the shell tool reported an information-free
  // "the command could not be started" for every command, on every platform.
  for (const os of ["win32", "darwin", "freebsd"] as NodeJS.Platform[]) {
    expect(enforceableConfinementMode("workspace-write", os)).toBe(
      "danger-full-access",
    );
    expect(enforceableConfinementMode("read-only", os)).toBe(
      "danger-full-access",
    );
  }
  // And the degradation is a DEGRADATION, not a waiver: it does not invent a mode
  // nobody asked for either.
  expect(enforceableConfinementMode("workspace-write", "win32")).not.toBe(
    "read-only",
  );
});

test("the default asks about this host, so Linux keeps its sandbox", () => {
  // The gate must be invisible on the platform that has the rung, or every
  // confined run on Linux would silently lose its confinement too.
  expect(enforceableConfinementMode("workspace-write")).toBe(
    process.platform === "linux" ? "workspace-write" : "danger-full-access",
  );
});

/**
 * The ownership domain at the kernel height (洞 2's remaining gap): an
 * explicit writable set narrows the WORKSPACE grant to the named paths, so a
 * sub-agent's shell answers to the same fence its file tools answer to —
 * "a branch only changes its own domain" holds for a redirect, not just for
 * write_file.
 */
test("an explicit writable set narrows the kernel grant to those paths", async () => {
  if (!available) return;
  // NOT under /tmp: the always-granted temp root would pass this test
  // without the domain rule (the same reason the workspace/outside pair
  // lives under the test directory).
  const base = join(import.meta.dir, `.confinement-domain-${process.pid}`);
  const allowed = join(base, "packages", "foo");
  const outside = join(base, "packages", "bar");
  await mkdir(allowed, { recursive: true });
  await mkdir(outside, { recursive: true });
  try {
    const wrapped = wrapConfinedCommand({
      mode: "workspace-write",
      workspaceRoot: base,
      writablePaths: [allowed],
      command: "/bin/sh",
      // `&&`, not `;`: a refused write must break the chain, so the exit
      // code itself is evidence (a `;` chain would end on `echo done` and
      // report success either way).
      args: [
        "-c",
        `echo in > ${allowed}/in.txt && echo out > ${outside}/out.txt && echo done`,
      ],
    });
    expect(wrapped).toBeDefined();
    const confined = spawnSync(wrapped!.command, wrapped!.args, {
      encoding: "utf8",
    });
    // The in-domain write lands; the out-of-domain one is refused BY THE
    // KERNEL (landlock) — the chain broke before `echo done`, which is what
    // makes this a fence and not a convention. This is the whole point of
    // narrowing the shell's root to the sub-agent's writePaths: "a branch
    // only changes its own domain" now holds for a redirect too.
    expect(confined.status).not.toBe(0);
    expect(confined.stdout).not.toContain("done");
    expect(existsSync(join(allowed, "in.txt"))).toBe(true);
    expect(existsSync(join(outside, "out.txt"))).toBe(false);
    // The platform set is untouched by the narrowing: the command can still
    // write the platform's temp drain.
    const drain = wrapConfinedCommand({
      mode: "workspace-write",
      workspaceRoot: base,
      writablePaths: [allowed],
      command: "/bin/sh",
      args: [
        "-c",
        `echo tmp > ${tmpdir()}/natalia-domain-drain.txt && echo ok`,
      ],
    });
    const drained = run(drain!.command, drain!.args);
    expect(drained.stdout.trim()).toBe("ok");
  } finally {
    rmSync(base, { recursive: true, force: true });
    rmSync(join(tmpdir(), "natalia-domain-drain.txt"), { force: true });
  }
});

test("the argv for an explicit set carries the platform roots and the domain", () => {
  if (!available) return;
  const wrapped = wrapConfinedCommand({
    mode: "workspace-write",
    workspaceRoot: "/repo/ws",
    writablePaths: ["/repo/ws/packages/foo", "/repo/ws/packages/baz"],
    command: "/bin/echo",
    args: ["hi"],
  });
  const argv = wrapped!.args;
  expect(argv).toContain("/dev/null");
  expect(argv).toContain("/tmp");
  expect(argv).toContain(canonicalPath("/repo/ws/packages/foo"));
  expect(argv).toContain(canonicalPath("/repo/ws/packages/baz"));
  // The whole workspace root is NOT granted when a domain narrows it.
  expect(argv).not.toContain(canonicalPath("/repo/ws"));
});
