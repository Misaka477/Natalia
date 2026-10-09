import { expect, test } from "bun:test";
import { sandboxTools } from "../src";

/**
 * The sandbox family's cards (UI refactor R5).
 *
 * The family that had almost none: ten of the eleven tools declared no
 * output definition, so every sandbox row fell to the generic path and read
 * as a raw sentence. Now each declares the projection, ONE decode feeds both
 * the event's meta slot and the card, and the structured fields land where
 * the union puts them — a command's exit and output on a terminal card, a
 * change set's REAL hunks on a diff card (the sandbox is the family whose
 * changes carry `structured`, which is why R2's deferred hunk upgrade lands
 * here rather than in fs-write).
 */

const tools = new Map(sandboxTools().map((tool) => [tool.name, tool]));

function outputOf(name: string) {
  const output = tools.get(name)?.output;
  if (!output?.presentCall || !output.presentResult || !output.presentationMeta)
    throw new Error(`${name} must declare the full projection`);
  return output;
}

test("every sandbox tool declares the projection (R5)", () => {
  // P2-18: sandbox_list joined the family, so the model can see what exists.
  expect(tools.size).toBe(12);
  for (const [name, tool] of tools) {
    expect(
      typeof tool.output?.presentationMeta,
      `${name} needs presentationMeta`,
    ).toBe("function");
  }
});

test("an execute's exit, command and output are the terminal card's fields", () => {
  const value = ["exit=3", "boom\nstack"].join("\n");
  const meta = outputOf("sandbox_execute").presentationMeta!(
    { id: "sbx", command: "bun test" },
    value,
  );
  const card = outputOf("sandbox_execute").presentResult!(
    { id: "sbx", command: "bun test" },
    value,
    meta,
  );
  expect(card).toMatchObject({
    kind: "terminal",
    title: "bun test",
    summary: "exit 3",
    command: "bun test",
    exitCode: 3,
    output: "boom\nstack",
    meta: [["exit", "3"]],
  });
  // The exit is also what makes the row read as failed (the kit reads the
  // structured field, not the pill).
  expect(card && card.kind === "terminal" && card.exitCode).toBe(3);
});

test("a retained resource dump is the terminal card's output", () => {
  const card = outputOf("sandbox_resource_output").presentResult!(
    { id: "sbx", resourceID: "res_1" },
    "line one\nline two",
  );
  expect(card).toMatchObject({
    kind: "terminal",
    title: "sbx",
    summary: "read",
    output: "line one\nline two",
  });
});

test("a diff carries the change set's real hunks", () => {
  const value = JSON.stringify(
    [
      {
        kind: "modify",
        path: "a.ts",
        additions: 2,
        deletions: 1,
        structured: {
          hunks: [
            {
              oldStart: 1,
              oldCount: 1,
              newStart: 1,
              newCount: 2,
              lines: [
                {
                  type: "delete",
                  text: "old",
                  oldLineNumber: 1,
                  newLineNumber: null,
                },
                {
                  type: "insert",
                  text: "new",
                  oldLineNumber: null,
                  newLineNumber: 1,
                },
              ],
            },
          ],
          additions: 2,
          deletions: 1,
        },
      },
    ],
    null,
    2,
  );
  const meta = outputOf("sandbox_diff").presentationMeta!({ id: "sbx" }, value);
  const card = outputOf("sandbox_diff").presentResult!(
    { id: "sbx" },
    value,
    meta,
  );
  expect(card).toMatchObject({
    kind: "diff",
    title: "sbx",
    summary: "1 change",
    hunks: [
      {
        oldStart: 1,
        newStart: 1,
        lines: [
          { type: "delete", text: "old" },
          { type: "insert", text: "new" },
        ],
      },
    ],
    meta: [
      ["files", "1"],
      ["added", "2"],
      ["removed", "1"],
    ],
  });
});

test("the card is composed from the FACTS, not a second parse (poison)", () => {
  const meta = outputOf("sandbox_execute").presentationMeta!(
    { id: "sbx", command: "bun test" },
    ["exit=7", "bad"].join("\n"),
  );
  expect(
    outputOf("sandbox_execute").presentResult!(
      { id: "sbx", command: "bun test" },
      "POISON",
      meta,
    ),
  ).toMatchObject({ kind: "terminal", exitCode: 7, command: "bun test" });
  const createMeta = outputOf("sandbox_create").presentationMeta!(
    { id: "sbx" },
    JSON.stringify({ id: "sbx", backend: "worktree" }),
  );
  expect(
    outputOf("sandbox_create").presentResult!(
      { id: "sbx" },
      "POISON",
      createMeta,
    ),
  ).toMatchObject({ summary: "created · worktree backend" });
});

test("a result that is not the envelope degrades the card", () => {
  // A prose answer (a refusal, a missing sandbox) leaves no facts.
  expect(
    outputOf("sandbox_delete").presentResult!(
      { id: "sbx" },
      "sandbox not found",
    ),
  ).toMatchObject({ kind: "generic", title: "sbx", summary: "deleted" });
});
