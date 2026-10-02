import { expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  loadProjectDocumentsSync,
  projectDocumentRules,
  renderProjectDocumentsBlock,
} from "@natalia/engineering-intelligence";

async function workspaceWithConstitution(
  name: string,
  constitution: string,
  agents?: string,
): Promise<string> {
  const root = await mkdtemp(join(tmpdir(), `natalia-const-${name}-`));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "constitution.md"),
    constitution,
    "utf8",
  );
  if (agents) await writeFile(join(root, "AGENTS.md"), agents, "utf8");
  return root;
}

test("loadProjectDocumentsSync parses constitution sections into enforcement-tagged rules", async () => {
  const root = await workspaceWithConstitution(
    "parse",
    [
      "# Project constitution",
      "",
      "## Never force-push",
      "",
      "Force-pushing rewrites shared history.",
      "",
      "<!-- enforcement: deny -->",
      '<!-- appliesTo: { commandPattern: "git push --force" } -->',
      "",
      "## Review discipline",
      "",
      "Prefer small, reviewable pull requests.",
    ].join("\n"),
    "## Testing\n\nEvery change ships with a test.",
  );

  const snapshot = loadProjectDocumentsSync(root);
  expect(snapshot).toBeDefined();
  const rules = projectDocumentRules(snapshot!);
  const forcePush = rules.find((rule) => rule.section === "Never force-push");
  expect(forcePush).toMatchObject({
    source: "constitution",
    enforcement: "deny",
    annotated: true,
    appliesTo: { commandPattern: "git push --force" },
  });
  const review = rules.find((rule) => rule.section === "Review discipline");
  expect(review).toMatchObject({ enforcement: "warn", annotated: false });
  // The AGENTS.md prose rule is warn-level too.
  const testing = rules.find((rule) => rule.source === "agents");
  expect(testing).toMatchObject({
    enforcement: "warn",
    statement: "Every change ships with a test.",
  });

  // The rendered block states enforcement explicitly and keeps raw grounding.
  const block = renderProjectDocumentsBlock(snapshot!);
  expect(block).toContain("<constitution_rules>");
  expect(block).toContain("[deny] Force-pushing rewrites shared history.");
  expect(block).toContain("[warn] Prefer small, reviewable pull requests.");
  expect(block).toContain("# Project constitution");
});

test("a document edit is picked up by the hash-keyed sync cache", async () => {
  const root = await workspaceWithConstitution(
    "edit",
    "## Rule one\n\nFirst version.",
  );
  const before = loadProjectDocumentsSync(root);
  expect(projectDocumentRules(before!)).toHaveLength(1);

  await writeFile(
    join(root, ".natalia", "constitution.md"),
    [
      "## Rule one",
      "",
      "First version.",
      "",
      "## Rule two",
      "",
      "Second version.",
    ].join("\n"),
    "utf8",
  );
  const after = loadProjectDocumentsSync(root);
  expect(projectDocumentRules(after!)).toHaveLength(2);
});
