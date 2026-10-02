import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  defaultCheckpointStoreDir,
  ensureStoreDir,
  migrateLegacyWorkspaceStore,
  resolveWorkspaceJsonSessionsDir,
  resolveWorkspaceJournalDatabasePath,
  resolveWorkspaceCheckpointSessionsRoot,
  resolveWorkspaceChunksRoot,
  resolveWorkspaceObjectsRoot,
  workspaceCheckpointSessionsRoot,
  workspaceChunksRoot,
  workspaceObjectsRoot,
  workspaceStoreID,
  workspaceStoreRoot,
} from "../src/store-paths";

/**
 * §1.6's path layer: the rescue ring lives outside the drowning pool, its id
 * reconnects by canonical path, and the legacy move never destroys content.
 *
 * Every test owns its workspace and fake home under a fresh temp base —
 * order-independent, and the developer's real store is never touched.
 */

let base = "";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "store-paths-"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function sandbox(): { home: string; workspace: string } {
  const id = mkdtempSync(join(base, "case-"));
  const home = join(id, "home");
  const workspace = join(id, "workspace");
  mkdirSync(home, { recursive: true });
  mkdirSync(workspace, { recursive: true });
  return { home, workspace };
}

function plantLegacy(workspace: string): void {
  mkdirSync(join(workspace, ".natalia", "checkpoints", "ses_a"), {
    recursive: true,
  });
  mkdirSync(join(workspace, ".natalia", "checkpoints", "ses_b"), {
    recursive: true,
  });
  mkdirSync(join(workspace, ".natalia", "objects"), { recursive: true });
  mkdirSync(join(workspace, ".natalia", "chunks"), { recursive: true });
  writeFileSync(
    join(workspace, ".natalia", "checkpoints", "ses_a", "journal.jsonl"),
    "a",
  );
  writeFileSync(
    join(workspace, ".natalia", "checkpoints", "ses_b", "journal.jsonl"),
    "b",
  );
  writeFileSync(join(workspace, ".natalia", "objects", "obj1"), "o");
  writeFileSync(join(workspace, ".natalia", "chunks", "ch1"), "c");
}

function legacy(workspace: string, ...segments: string[]): string {
  return join(workspace, ".natalia", ...segments);
}

test("the store id is stable and reconnects by canonical path", () => {
  const { workspace } = sandbox();
  const id = workspaceStoreID(workspace);
  expect(id).toMatch(/^[0-9a-f]{64}$/u);
  expect(workspaceStoreID(workspace)).toBe(id);
  expect(workspaceStoreID(join(base, "other"))).not.toBe(id);
  // The reconnection property: a symlink spelling of the same directory
  // resolves to the same id — restore the workspace to the same path and
  // the store finds it without anyone remembering an id.
  const link = join(workspace, "..", "link");
  symlinkSync(workspace, link);
  expect(workspaceStoreID(link)).toBe(id);
});

test("the store root lives under the injected home, not the workspace", () => {
  const { home, workspace } = sandbox();
  const id = workspaceStoreID(workspace);
  const root = workspaceStoreRoot(workspace, home);
  expect(root).toBe(join(home, ".natalia", "stores", id));
  expect(root.startsWith(workspace)).toBe(false);
  expect(workspaceObjectsRoot(workspace, home)).toBe(join(root, "objects"));
  expect(workspaceCheckpointSessionsRoot(workspace, home)).toBe(
    join(root, "sessions"),
  );
  expect(workspaceChunksRoot(workspace, home)).toBe(join(root, "chunks"));
  expect(defaultCheckpointStoreDir(workspace, "ses_a", home)).toBe(
    join(root, "sessions", "ses_a"),
  );
});

test("store directories are created 0700", async () => {
  const { home } = sandbox();
  const dir = join(home, ".natalia", "stores", "perm-probe");
  await ensureStoreDir(dir);
  expect(statSync(dir).mode & 0o777).toBe(0o700);
});

test("the legacy move relocates checkpoints, objects and chunks", async () => {
  const { home, workspace } = sandbox();
  plantLegacy(workspace);
  const moved = await migrateLegacyWorkspaceStore(workspace, home);
  const root = workspaceStoreRoot(workspace, home);
  // Counting the moves is implementation-shaped (a whole-directory rename is
  // one move, entry-by-entry is many); the outcome is the contract.
  expect(moved).toBeGreaterThan(0);
  expect(existsSync(join(root, "sessions", "ses_a", "journal.jsonl"))).toBe(
    true,
  );
  expect(existsSync(join(root, "sessions", "ses_b", "journal.jsonl"))).toBe(
    true,
  );
  expect(existsSync(join(root, "objects", "obj1"))).toBe(true);
  expect(existsSync(join(root, "chunks", "ch1"))).toBe(true);
  expect(existsSync(legacy(workspace, "checkpoints"))).toBe(false);
  expect(existsSync(legacy(workspace, "objects"))).toBe(false);
  expect(existsSync(legacy(workspace, "chunks"))).toBe(false);
});

test("the move is idempotent", async () => {
  const { home, workspace } = sandbox();
  plantLegacy(workspace);
  await migrateLegacyWorkspaceStore(workspace, home);
  expect(await migrateLegacyWorkspaceStore(workspace, home)).toBe(0);
});

test("an existing store entry is never overwritten by legacy data", async () => {
  const { home, workspace } = sandbox();
  plantLegacy(workspace);
  const root = workspaceStoreRoot(workspace, home);
  // The external objects store already has a NEWER obj1; the legacy copy of
  // the same name must stay in place (visible for a human), not clobber it —
  // rename would silently replace a file, which is the loss this rules out.
  mkdirSync(join(root, "objects"), { recursive: true });
  writeFileSync(join(root, "objects", "obj1"), "newer");
  await migrateLegacyWorkspaceStore(workspace, home);
  expect(readFileSync(join(root, "objects", "obj1"), "utf8")).toBe("newer");
  expect(existsSync(legacy(workspace, "objects", "obj1"))).toBe(true);
  expect(existsSync(legacy(workspace, "objects"))).toBe(true);
});

test("resolution reads legacy before migration and external after", async () => {
  const { home, workspace } = sandbox();
  // Pre-migration: legacy exists, external does not -> read the legacy dir.
  mkdirSync(legacy(workspace, "objects"), { recursive: true });
  expect(resolveWorkspaceObjectsRoot(workspace, home)).toBe(
    legacy(workspace, "objects"),
  );
  // Post-migration: external exists -> external wins even if a conflict kept
  // a fragment of the legacy dir around.
  mkdirSync(workspaceObjectsRoot(workspace, home), { recursive: true });
  expect(resolveWorkspaceObjectsRoot(workspace, home)).toBe(
    workspaceObjectsRoot(workspace, home),
  );
  // A fresh workspace (no legacy) resolves external without any migration.
  const fresh = sandbox();
  expect(resolveWorkspaceChunksRoot(fresh.workspace, fresh.home)).toBe(
    workspaceChunksRoot(fresh.workspace, fresh.home),
  );
  expect(
    resolveWorkspaceCheckpointSessionsRoot(fresh.workspace, fresh.home),
  ).toBe(workspaceCheckpointSessionsRoot(fresh.workspace, fresh.home));
});

test("the journal db reads legacy before migration and external after", () => {
  const { home, workspace } = sandbox();
  // Pre-migration: the workspace-local sqlite is read in place (the startup
  // migration has not run yet — never look at an empty external path).
  mkdirSync(join(workspace, ".natalia"), { recursive: true });
  writeFileSync(join(workspace, ".natalia", "sessions.db"), "journal");
  expect(resolveWorkspaceJournalDatabasePath(workspace, home)).toBe(
    join(workspace, ".natalia", "sessions.db"),
  );
  // Post-migration: the external db exists -> external wins.
  mkdirSync(workspaceStoreRoot(workspace, home), { recursive: true });
  writeFileSync(
    join(workspaceStoreRoot(workspace, home), "sessions.db"),
    "moved",
  );
  expect(resolveWorkspaceJournalDatabasePath(workspace, home)).toBe(
    join(workspaceStoreRoot(workspace, home), "sessions.db"),
  );
  // A fresh workspace claims the external location.
  const fresh = sandbox();
  expect(resolveWorkspaceJournalDatabasePath(fresh.workspace, fresh.home)).toBe(
    join(workspaceStoreRoot(fresh.workspace, fresh.home), "sessions.db"),
  );
});

test("the json journal directory follows the same read rule", () => {
  const { home, workspace } = sandbox();
  mkdirSync(join(workspace, ".natalia", "sessions"), { recursive: true });
  expect(resolveWorkspaceJsonSessionsDir(workspace, home)).toBe(
    join(workspace, ".natalia", "sessions"),
  );
  const external = join(workspaceStoreRoot(workspace, home), "json-sessions");
  mkdirSync(external, { recursive: true });
  expect(resolveWorkspaceJsonSessionsDir(workspace, home)).toBe(external);
});

test("the journal migration moves the db and the json dir", async () => {
  const { home, workspace } = sandbox();
  mkdirSync(join(workspace, ".natalia"), { recursive: true });
  writeFileSync(join(workspace, ".natalia", "sessions.db"), "journal");
  mkdirSync(join(workspace, ".natalia", "sessions"), { recursive: true });
  writeFileSync(join(workspace, ".natalia", "sessions", "a.json"), "{}");
  const moved = await migrateLegacyWorkspaceStore(workspace, home);
  expect(moved).toBe(2);
  const root = workspaceStoreRoot(workspace, home);
  expect(readFileSync(join(root, "sessions.db"), "utf8")).toBe("journal");
  expect(readFileSync(join(root, "json-sessions", "a.json"), "utf8")).toBe(
    "{}",
  );
  expect(existsSync(join(workspace, ".natalia", "sessions.db"))).toBe(false);
  expect(existsSync(join(workspace, ".natalia", "sessions"))).toBe(false);
});

test("the json journal never splits across two roots", async () => {
  const { home, workspace } = sandbox();
  mkdirSync(join(workspace, ".natalia", "sessions"), { recursive: true });
  writeFileSync(join(workspace, ".natalia", "sessions", "a.json"), "legacy");
  const root = workspaceStoreRoot(workspace, home);
  // The external dir already exists with a CONFLICTING session file: a
  // merge would leave sessions readable in only one of the two roots, so
  // the legacy journal stays whole where it is.
  mkdirSync(join(root, "json-sessions"), { recursive: true });
  writeFileSync(join(root, "json-sessions", "a.json"), "external");
  await migrateLegacyWorkspaceStore(workspace, home);
  expect(
    readFileSync(join(workspace, ".natalia", "sessions", "a.json"), "utf8"),
  ).toBe("legacy");
  expect(readFileSync(join(root, "json-sessions", "a.json"), "utf8")).toBe(
    "external",
  );
  // The all-or-nothing move means no split can come from migration; when
  // BOTH roots exist the external one wins, because the resurrected legacy
  // dir is by definition the STALE copy (a workspace restored from backup
  // must not shadow the journal that kept being written).
  expect(resolveWorkspaceJsonSessionsDir(workspace, home)).toBe(
    join(root, "json-sessions"),
  );
});

test("an unwritable home degrades the journal to workspace-local", () => {
  const { home, workspace } = sandbox();
  // A home that refuses writes (read-only mounts, restricted containers —
  // and this harness's own /home): the journal must fall back, not vanish.
  chmodSync(home, 0o555);
  try {
    const fresh = sandbox(); // creates dirs — use the chmod'd home directly
    void fresh;
    expect(resolveWorkspaceJournalDatabasePath(workspace, home)).toBe(
      join(workspace, ".natalia", "sessions.db"),
    );
    expect(resolveWorkspaceJsonSessionsDir(workspace, home)).toBe(
      join(workspace, ".natalia", "sessions"),
    );
  } finally {
    chmodSync(home, 0o755);
  }
});
