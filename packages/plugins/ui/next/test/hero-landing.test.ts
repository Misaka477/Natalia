import { expect, test } from "bun:test";
import { readFileSync as readFs } from "node:fs";
import { join } from "node:path";

const srcRoot = join(import.meta.dir, "..", "src");

function readSrc(...parts: string[]): string {
  return readFs(join(srcRoot, ...parts), "utf8");
}

test("AgentBody centers the Hero headline, WorkspaceChip, and composer when messages are empty", () => {
  const body = readSrc("components", "AgentBody.tsx");
  expect(body).toContain("styles.composerHero");
  expect(body).toContain("styles.heroHeadline");
  expect(body).toContain("styles.heroWorkspaceRow");
  expect(body).toContain("styles.workspaceChip");
  expect(body).toContain('src="/brand.png"');
});

test("Composer places the + button, mode controls, trailing model selector, and circular send button in the bottom bar", () => {
  const composer = readSrc("components", "Composer.tsx");
  expect(composer).toContain("styles.addBtn");
  expect(composer).toContain("styles.trailing");
  expect(composer).toContain("props.trailing");
});

test("transcript and nia-panel pass model and permission controls into the composer bottom row", () => {
  const transcript = readSrc("controllers", "transcript.tsx");
  const inputArea = readSrc("controllers", "input-area.tsx");
  expect(inputArea).toContain("trailing={props.trailing}");
  expect(transcript).toContain("trailing={");
});
