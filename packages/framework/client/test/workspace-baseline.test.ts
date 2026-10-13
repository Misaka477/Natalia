import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  dropWorkspaceBaseline,
  workspaceBaselineStore,
} from "../src/runtime/workspace-baseline";

/**
 * The workspace baseline — "what changed since THEN" with no git anywhere.
 * The before side used to come from `git show <ref>:<path>`, so a workspace
 * that is not a repository could not answer "what moved" at all. The
 * machinery to answer it honestly already existed (the sandbox's
 * content-addressed SnapshotStore); this points it at the workspace.
 */

async function harness() {
  const root = await mkdtemp(join(tmpdir(), "natalia-baseline-"));
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(join(root, "src", "a.ts"), "export const a = 1;\n");
  await writeFile(join(root, "src", "gone.ts"), "export const gone = 1;\n");
  const baselines = workspaceBaselineStore({
    workspaceRoot: root,
    dir: join(root, ".natalia", "baselines"),
  });
  return { root, baselines };
}

test("a baseline records the tree and reads its content back", async () => {
  const { root, baselines } = await harness();
  try {
    const baseline = await baselines.capture();
    expect(baseline.files).toBe(2);
    // The content at the baseline — the git-show primitive's shape, from our
    // own store.
    const content = await baselines.show(baseline.id, "src/a.ts");
    expect(content?.toString("utf8")).toBe("export const a = 1;\n");
    // An unknown path is undefined, not an error (a new file has no before).
    expect(await baselines.show(baseline.id, "src/new.ts")).toBeUndefined();
    // And an unknown baseline id likewise.
    expect(await baselines.show("baseline-nope", "src/a.ts")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a moved file and a deleted file are both visible against the baseline", async () => {
  const { root, baselines } = await harness();
  try {
    const baseline = await baselines.capture();
    // The workspace moves on: a file moves, a file is deleted, one is new.
    await rm(join(root, "src", "gone.ts"));
    await writeFile(join(root, "src", "moved.ts"), "export const a = 1;\n");
    await writeFile(join(root, "src", "new.ts"), "export const n = 2;\n");
    // The deleted set is the mirror of the move: the path that LEFT, which
    // the move detection needs as its before side.
    expect(await baselines.deletedFiles(baseline.id)).toEqual(["src/gone.ts"]);
    // The moved file's before content is the baseline's, not the tree's.
    expect((await baselines.show(baseline.id, "src/gone.ts"))?.toString()).toBe(
      "export const gone = 1;\n",
    );
    expect(await baselines.show(baseline.id, "src/new.ts")).toBeUndefined();
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});

test("a second capture is a second record, and dropping one keeps the others", async () => {
  const { root, baselines } = await harness();
  try {
    const first = await baselines.capture();
    await writeFile(join(root, "src", "a.ts"), "export const a = 2;\n");
    const second = await baselines.capture();
    expect(second.id).not.toBe(first.id);
    // Each baseline answers with its OWN content: the first still holds the
    // original bytes, the second the edited ones. That is what makes "since
    // THEN" answerable at all.
    expect((await baselines.show(first.id, "src/a.ts"))?.toString()).toBe(
      "export const a = 1;\n",
    );
    expect((await baselines.show(second.id, "src/a.ts"))?.toString()).toBe(
      "export const a = 2;\n",
    );
    expect((await baselines.list()).map((entry) => entry.id).sort()).toEqual(
      [first.id, second.id].sort(),
    );
    await dropWorkspaceBaseline(
      { dir: join(root, ".natalia", "baselines") },
      first.id,
    );
    expect((await baselines.list()).map((entry) => entry.id)).toEqual([
      second.id,
    ]);
    expect(await baselines.show(first.id, "src/a.ts")).toBeUndefined();
    // The second is untouched by the drop.
    expect(
      existsSync(
        join(root, ".natalia", "baselines", "records", `${second.id}.json`),
      ),
    ).toBe(true);
  } finally {
    await rm(root, { recursive: true, force: true });
  }
});
