import { expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import { createContextVault } from "../src/vault";

/**
 * Phase 6's closure (RINA's remainder): the semantic lane's state is
 * answerable from the vault, so a consumer can tell "the lane is off"
 * from "the lane found no neighbour" — a `semantic: 0` in a recall
 * breakdown means both, and reading the absent lane as an empty corpus
 * is the quiet misreading this face refuses.
 */

const dirs: string[] = [];
process.on("exit", () => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

function vaultDir(semantic?: boolean): string {
  const dir = mkdtempSync(join(tmpdir(), "vault-lane-"));
  dirs.push(dir);
  return dir;
}

const event = (type: RuntimeEvent["type"], seq: number): RuntimeEvent =>
  ({
    type,
    id: `e${seq}`,
    sessionID: "s",
    workspaceID: "w",
    seq,
    at: new Date().toISOString(),
  }) as unknown as RuntimeEvent;

test("the lane's state is the constructor's opt-in, per vault", () => {
  const dirA = vaultDir();
  mkdirSync(dirA, { recursive: true });
  const off = createContextVault({ dir: dirA, flushMs: 5 });
  const dirB = vaultDir();
  mkdirSync(dirB, { recursive: true });
  const on = createContextVault({ dir: dirB, flushMs: 5, semantic: true });
  expect(off.semanticLane()).toBe(false);
  expect(on.semanticLane()).toBe(true);
  // The default stays off (the study's 仅按需启用): a second look at a
  // fresh vault without the flag.
  const dirC = vaultDir();
  mkdirSync(dirC, { recursive: true });
  expect(createContextVault({ dir: dirC, flushMs: 5 }).semanticLane()).toBe(
    false,
  );
  off.close();
  on.close();
});

test("an unavailable vault's lane is off (no vault, no lane)", async () => {
  const { createUnavailableVault } = await import("../src/vault");
  expect(createUnavailableVault("nope").semanticLane()).toBe(false);
});

test("the recall's semantic breakdown is zero on an off lane, and the state says which", () => {
  const dir = vaultDir();
  mkdirSync(dir, { recursive: true });
  const vault = createContextVault({ dir, flushMs: 5 });
  vault.remember({
    id: "s:1",
    workspaceID: "w",
    sessionID: "s",
    recordType: "decision",
    entityKey: "alpha",
    summary: "alpha ran",
  });
  const hits = vault.recall("alpha", { sessionID: "s" });
  expect(hits[0]!.breakdown.semantic).toBe(0);
  // The consumer's answer to "is the lane contributing" comes from the
  // state, not from the zero.
  expect(vault.semanticLane()).toBe(false);
  vault.close();
});
