/**
 * What `serve` opens when the registry is empty.
 *
 * The rule this replaces: seeding `process.cwd()` as the default workspace.
 * A Start Menu launch has the install directory as its working directory, so
 * the program tree became a workspace and the user's sessions were written
 * inside the tree the uninstaller deletes. The first workspace is the OS
 * Documents one, and deleting it is remembered.
 *
 * The seams take both decisions so a test never touches this machine's real
 * Documents directory.
 */
import { expect, test } from "bun:test";
import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureFirstUseWorkspace } from "../src/first-use-workspace";

test("a fresh host gets the Documents workspace, created where it will live", async () => {
  const base = mkdtempSync(join(tmpdir(), "first-use-workspace-"));
  const path = join(base, "Natalia", "default-workspace");
  const requested: string[] = [];
  try {
    const outcome = await ensureFirstUseWorkspace(
      {
        workspaceAdd: async (input) => {
          requested.push(input.path);
          return { workspaceID: "ws_first_use" };
        },
      },
      { resolvePath: () => path },
    );
    expect(outcome).toEqual({ created: true, workspaceID: "ws_first_use" });
    expect(requested).toEqual([path]);
    // The directory exists before the manager is asked for it: the session
    // store writes into `<workspace>/.natalia` as soon as a turn runs.
    expect(existsSync(path)).toBe(true);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a refusal is kept: the workspace is not created again", async () => {
  const base = mkdtempSync(join(tmpdir(), "first-use-declined-"));
  const path = join(base, "default-workspace");
  try {
    const outcome = await ensureFirstUseWorkspace(
      {
        workspaceAdd: async () => {
          throw new Error("must not be called: the user already refused this");
        },
      },
      { resolvePath: () => path, isDeclined: () => true },
    );
    expect(outcome.created).toBe(false);
    expect(outcome.reason).toContain("deleted");
    expect(existsSync(path)).toBe(false);
  } finally {
    rmSync(base, { recursive: true, force: true });
  }
});

test("a host with no Documents directory opens nothing, and says why", async () => {
  const outcome = await ensureFirstUseWorkspace(
    {
      workspaceAdd: async () => {
        throw new Error("must not be called: there is nowhere to put it");
      },
    },
    { resolvePath: () => undefined },
  );
  expect(outcome).toEqual({
    created: false,
    reason: "this host has no documents directory",
  });
});
