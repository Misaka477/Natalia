import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  captureManifestRef,
  captureRepositoryEvidenceFields,
  captureRepositoryRefFields,
  captureRepositoryRefsSync,
} from "@anthelia/substrate";
import { buildEvidenceRecorded } from "@natalia/governance-ledger";

async function makeGitRepo(): Promise<string | undefined> {
  const dir = await mkdtemp(join(tmpdir(), "natalia-refs-git-"));
  const run = (args: string[]) =>
    Bun.spawnSync(args, { cwd: dir, stdout: "pipe", stderr: "pipe" });
  if (!run(["git", "init", "-q"]).success) return undefined;
  run(["git", "config", "user.email", "test@example.com"]);
  run(["git", "config", "user.name", "test"]);
  await writeFile(join(dir, "file.txt"), "hello");
  run(["git", "add", "-A"]);
  if (!run(["git", "commit", "-q", "-m", "init"]).success) return undefined;
  return dir;
}

test("captureRepositoryRefsSync stamps a safe commit hash and injected version", async () => {
  const dir = await makeGitRepo();
  if (!dir) return; // git unavailable in this environment
  try {
    const refs = captureRepositoryRefsSync(dir!, {
      NATALIA_VERSION: "0.0.0-m13",
    });
    expect(refs.repositoryVersion).toBe("0.0.0-m13");
    expect(refs.commit).toMatch(/^[0-9a-f]{40}$/u);
  } finally {
    if (dir) await rm(dir, { recursive: true, force: true });
  }
});

test("captureRepositoryRefsSync is fail-soft outside a git repo", async () => {
  const dir = await mkdtemp(join(tmpdir(), "natalia-refs-nogit-"));
  try {
    const refs = captureRepositoryRefsSync(dir, {});
    expect(refs.commit).toBeUndefined();
    expect(refs.repositoryVersion).toBeUndefined();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("captureManifestRef hashes the public catalog and is absent otherwise", async () => {
  const dir = await mkdtemp(join(tmpdir(), "natalia-refs-manifest-"));
  try {
    expect(await captureManifestRef(dir)).toBeUndefined();
    await mkdir(join(dir, ".natalia"), { recursive: true });
    await writeFile(
      join(dir, ".natalia", "models-dev-catalog.json"),
      JSON.stringify({ models: ["a"] }),
    );
    const ref = await captureManifestRef(dir);
    expect(ref).toMatch(/^models-dev-catalog:[0-9a-f]+$/u);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("buildEvidenceRecorded carries the repository refs", () => {
  const event = buildEvidenceRecorded({
    id: "evidence:1",
    taskID: "task-1",
    objective: "ship it",
    status: "validated",
    repositoryVersion: "0.0.0-m13",
    commit: "abcdef0123456789",
    manifestRef: "models-dev-catalog:deadbeef",
  });
  expect(event).toMatchObject({
    repositoryVersion: "0.0.0-m13",
    commit: "abcdef0123456789",
    manifestRef: "models-dev-catalog:deadbeef",
  });
  // Omitting them keeps the event clean (no empty strings).
  const bare = buildEvidenceRecorded({
    id: "evidence:2",
    taskID: "task-1",
    objective: "ship it",
    status: "validated",
  });
  expect("repositoryVersion" in bare).toBe(false);
  expect("commit" in bare).toBe(false);
  expect("manifestRef" in bare).toBe(false);
});

test("captureRepositoryRefFields spreads the version and commit only when present", async () => {
  const dir = await mkdtemp(join(tmpdir(), "natalia-refs-fields-"));
  try {
    // No git repo: the fields object stays empty instead of holding blanks.
    const bare = captureRepositoryRefFields(dir);
    expect(bare).toEqual({});
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
  const repo = await makeGitRepo();
  if (!repo) return; // git unavailable in this environment
  try {
    const fields = captureRepositoryRefFields(repo);
    expect(fields.commit).toMatch(/^[0-9a-f]{40}$/u);
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("captureRepositoryEvidenceFields unions the sync refs with the manifest ref", async () => {
  const dir = await mkdtemp(join(tmpdir(), "natalia-refs-evidence-"));
  try {
    await mkdir(join(dir, ".natalia"), { recursive: true });
    await writeFile(
      join(dir, ".natalia", "models-dev-catalog.json"),
      JSON.stringify({ models: ["a"] }),
    );
    const fields = await captureRepositoryEvidenceFields(dir);
    expect(fields.manifestRef).toMatch(/^models-dev-catalog:[0-9a-f]+$/u);
    // No git repo: commit stays absent rather than an empty string.
    expect("commit" in fields).toBe(false);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
