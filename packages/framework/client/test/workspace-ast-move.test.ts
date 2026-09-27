import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeContext } from "@anthelia/substrate";
import { createWorkspaceRuntime } from "../src/runtime/workspace-runtime";

/**
 * Phase C's workspace face (the study's second face): the real files —
 * the working tree against HEAD — through the same index, answered as
 * the detected moves. A real git repository is the fixture: what the
 * face detects is what a user actually did to their tree.
 */

const roots: string[] = [];
afterAll(() => {
  for (const root of roots) rm(root, { recursive: true, force: true });
});

async function git(root: string, args: string[]) {
  const proc = Bun.spawn(["git", ...args], {
    cwd: root,
    stdin: "ignore",
    stdout: "pipe",
    stderr: "pipe",
  });
  const [code] = [await proc.exited, await new Response(proc.stdout).text()];
  if (code !== 0) throw new Error(`git ${args.join(" ")} failed`);
}

function runtimeFor(root: string) {
  const ctx = {
    ports: {
      getReady: () => Promise.resolve(),
      getWorkspaceRoot: () => root,
    },
    state: {},
  } as unknown as RuntimeContext;
  return createWorkspaceRuntime(ctx);
}

test("the workspace face walks the whole tree when no paths are named", async () => {
  // The plan's workspace face: the caller names NOTHING and the whole
  // workspace is the move surface, the move in the ninetieth file — past
  // every cap the older faces had.
  const root = await mkdtemp(join(tmpdir(), "ws-ast-walk-"));
  roots.push(root);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "test@invalid"]);
  await git(root, ["config", "user.name", "test"]);
  await mkdir(join(root, "src"), { recursive: true });
  const name = (index: number) => `handler_${(index * 7919) % 100000}`;
  const source = (index: number, renamed: boolean) =>
    `export function ${name(index)}${renamed ? "V2" : ""}(value: string) { return value; }\n`;
  // 90 source files, plus the noise the ignore rules must keep out.
  for (let index = 0; index < 90; index += 1)
    await writeFile(join(root, "src", `mod-${index}.ts`), source(index, false));
  await mkdir(join(root, "node_modules", "left-pad"), { recursive: true });
  await writeFile(
    join(root, "node_modules", "left-pad", "index.ts"),
    "export function pad(value: string) { return value; }\n",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "initial"]);
  // The ninetieth file's symbol is renamed in the worktree.
  await writeFile(join(root, "src", "mod-89.ts"), source(89, true));

  const answer = await runtimeFor(root).workspaceAstMove!({});
  const moves = answer.moves as Array<{
    from: string;
    to: string;
    states: { renamed: boolean };
  }>;
  expect(
    moves.some(
      (move) =>
        move.from.includes(name(89)) &&
        move.to.includes("V2") &&
        move.states.renamed,
    ),
  ).toBe(true);
  // The noise stayed out: no node_modules symbol ever entered the sets.
  expect(moves.some((move) => move.from.includes("pad"))).toBe(false);
}, 60_000);

test("the workspace face detects a rename+move+modify the tree actually made", async () => {
  const root = await mkdtemp(join(tmpdir(), "ws-ast-move-"));
  roots.push(root);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "test@invalid"]);
  await git(root, ["config", "user.name", "test"]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "parser.ts"),
    "export function parseConfigV2(value: string) { return value; }\n",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "initial"]);

  // What the user actually does: move the file, rename the symbol, tweak
  // the body — then let the face see it against HEAD.
  await mkdir(join(root, "lib"), { recursive: true });
  await writeFile(
    join(root, "lib", "parser.ts"),
    "export function parseConfigV3(value: string) { return value.trim(); }\n",
  );
  await git(root, ["rm", "-q", "src/parser.ts"]);

  const answer = await runtimeFor(root).workspaceAstMove!({
    paths: ["lib/parser.ts"],
  });
  const move = answer.moves.find((entry) => entry.from === "parseConfigV2");
  expect(move).toBeDefined();
  expect(move).toMatchObject({
    to: "parseConfigV3",
    fromFile: "src/parser.ts",
    toFile: "lib/parser.ts",
    states: { renamed: true, moved: true, modified: true },
  });
  expect(answer.from).toBe("HEAD");
  expect(answer.scanned).toBe(1);

  // The path's before came from the ref: the deleted src/parser.ts was
  // NOT in the paths, yet its symbol answered — the ref side is scanned
  // through the same index, not re-read per file.
  expect(answer.skipped).toBeUndefined();
}, 30_000);

test("an unsupported extension is skipped by name, a new file answers without a before", async () => {
  const root = await mkdtemp(join(tmpdir(), "ws-ast-skip-"));
  roots.push(root);
  await git(root, ["init", "-q"]);
  await git(root, ["config", "user.email", "test@invalid"]);
  await git(root, ["config", "user.name", "test"]);
  await mkdir(join(root, "src"), { recursive: true });
  await writeFile(
    join(root, "src", "parser.ts"),
    "export function stayHere() { return 1; }\n",
  );
  await git(root, ["add", "."]);
  await git(root, ["commit", "-qm", "initial"]);
  await writeFile(join(root, "README.md"), "# hello\n");
  const answer = await runtimeFor(root).workspaceAstMove!({
    paths: ["README.md", "src/parser.ts"],
  });
  expect(answer.skipped).toEqual([
    { path: "README.md", reason: "no_ast_language" },
  ]);
  // The unchanged file answers no moves.
  expect(answer.moves).toEqual([]);
}, 30_000);
