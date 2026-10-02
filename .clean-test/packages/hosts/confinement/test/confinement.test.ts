import { afterAll, beforeAll, expect, test } from "bun:test";
import { spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  canonicalPath,
  confinementAvailable,
  confinementBinary,
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
  const wrapped = wrapConfinedCommand({
    mode: "danger-full-access",
    command: "/bin/sh",
    args: ["-c", `echo ok > "${target}"`],
  });
  expect(wrapped).not.toBeUndefined();
  const result = run(wrapped!.command, wrapped!.args);
  expect(result.status).toBe(0);
  expect(existsSync(target)).toBe(true);
});

test("the unavailable backend is reported, not faked", () => {
  // The honest-reporting discipline: capability is a fact we measured.
  if (!available) expect(probeConfinement()).toBeUndefined();
  else expect(typeof probeConfinement()!.landlockABI).toBe("number");
});
