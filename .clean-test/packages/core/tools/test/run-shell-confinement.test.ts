import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { confinementAvailable } from "@anthelia/confinement";
import { runShell } from "../src/run-shell";

/**
 * runShell's confinement seam (sandbox study §6: the exec primitive becomes
 * confinement-aware; the policy rides the call). The real-confinement cases
 * are gated on the built backend — same discipline as the object-store's
 * native index: an environment without cargo has no binary, and the
 * fail-closed refusal is covered at the wrap layer's own tests.
 *
 * Both directories live inside the package (outside every temp root), so
 * `workspace-write` may write the workspace and must deny its sibling: the
 * always-granted `/tmp` can never make the assertion pass on its own.
 */

const available = confinementAvailable();
let workspace = "";
let outside = "";

beforeAll(() => {
  const base = join(import.meta.dir, `.run-shell-confinement-${process.pid}`);
  workspace = join(base, "workspace");
  outside = join(base, "outside");
  mkdirSync(workspace, { recursive: true });
  mkdirSync(outside, { recursive: true });
});

afterAll(() => {
  rmSync(join(import.meta.dir, `.run-shell-confinement-${process.pid}`), {
    recursive: true,
    force: true,
  });
});

function context(confinement?: "read-only" | "workspace-write") {
  return { workspaceRoot: workspace, ...(confinement ? { confinement } : {}) };
}

test("without a policy the command runs unconfined (today's behavior)", async () => {
  const target = join(outside, "raw.txt");
  const output = await runShell(`echo ok > "${target}"`, context(), 30);
  expect(output).toContain("exit=0");
});

test("explicit danger-full-access also runs unconfined", async () => {
  const target = join(outside, "danger.txt");
  const output = await runShell(
    `echo ok > "${target}"`,
    {
      workspaceRoot: workspace,
      confinement: "danger-full-access",
    } as never,
    30,
  );
  expect(output).toContain("exit=0");
});

test("workspace-write allows the workspace and denies the sibling", async () => {
  if (!available) return;
  const inside = join(workspace, "allowed.txt");
  const blocked = join(outside, "denied.txt");
  // The command fails at the second write, so runShell rejects with the
  // captured output as its message — the denial rides in there.
  const output = await runShell(
    `echo ok > "${inside}" && echo bad > "${blocked}"`,
    context("workspace-write"),
    30,
  ).catch((error: Error) => error.message);
  expect(output).toContain("exit=");
  // The first write landed, the second was refused by the kernel.
  expect(await Bun.file(inside).exists()).toBe(true);
  expect(await Bun.file(blocked).exists()).toBe(false);
});

test("read-only denies writes even inside the workspace", async () => {
  if (!available) return;
  const target = join(workspace, "ro-denied.txt");
  const output = await runShell(
    `echo x > "${target}"`,
    context("read-only"),
    30,
  ).catch((error: Error) => error.message);
  expect(output).not.toContain("exit=0");
  expect(await Bun.file(target).exists()).toBe(false);
});

test("a confined command's own failure still reports its output", async () => {
  if (!available) return;
  // The confinement path must not swallow ordinary command output: a failed
  // command under workspace-write reports its exit and streams like it does
  // unconfined (only the wrapper's own refusal gets reclassified, and that
  // signature is unreachable while the backend is healthy).
  const output = await runShell(
    `echo to-stderr >&2; exit 3`,
    context("workspace-write"),
    30,
  ).catch((error: Error) => error.message);
  expect(output).toContain("exit=3");
  expect(output).toContain("to-stderr");
});
