import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The system prompt's assembly, pinned across channels.
 *
 * ADR D1/D2 puts a hard line between the STATIC system prompt (persona and
 * policy, byte-stable so the provider's prefix cache survives) and the DYNAMIC
 * runtime context (workspace, skills, collaboration, plan), which must ride in
 * an appended `<runtime_context>` USER message instead. The dangerous failure
 * is the quiet one: a dynamic value leaking into the static block, which both
 * mixes authority levels and invalidates the cache on every turn.
 */

const root = join(import.meta.dir, "..", "..", "..", "..");
function source(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

test("every assembly site returns a byte-identical static prompt", async () => {
  // The test below reads the PROMPT TEXT file and asserts it holds no dynamic
  // value. That guards one file, not the property: persona is ASSEMBLED in
  // chat-prompt.ts, and appending a dynamic value there — a date, a session id —
  // leaves every source-text assertion green. Measured: `agentSystemPrompt("nia")
  // + "\nSession: " + Date.now()` turned nothing red.
  //
  // It matters because the static prompt exists to be byte-identical across
  // sessions and workspaces, so the provider's prefix cache hits. One per-session
  // byte and every turn pays full input price.
  const { createChatPrompt } = await import(
    "../../../domains/collab/src/chat-prompt"
  );
  const prompt = createChatPrompt({} as never);
  const first = prompt.niaChatPersona();
  // A second call, later, from a different context: same bytes or the property
  // is broken. Date.now() and new Date() are the two shapes that break it.
  await Bun.sleep(5);
  const second = prompt.niaChatPersona();
  expect(second).toBe(first);
  expect(first).not.toMatch(
    /\bDate\.now\(|new Date\(|sessionID|workspaceRoot/u,
  );
});

test("the static prompt carries no dynamic value", () => {
  const prompts = source("packages/framework/agent-prompts/src/index.ts");
  // No workspace path, no date, no skill enumeration, no caller-supplied state.
  expect(prompts).not.toContain("workspaceRoot");
  expect(prompts).not.toContain("process.cwd");
  expect(prompts).not.toMatch(/\bDate\.now\(\)|\bnew Date\(/u);
  expect(prompts).not.toContain("available_skills");
  expect(prompts).not.toContain("navi_collaborations");
});

test("the dynamic context is injected as a user message, never into the system prompt", () => {
  // Main.
  const runner = source(
    "packages/framework/provider-model/src/provider-runner.ts",
  );
  expect(runner).toContain(
    '{ role: "user" as const, content: blocks.join("\\n\\n") }',
  );
  // Navi/Nia: the same rule, their own injection helper.
  const navi = source("packages/domains/collab/src/chat-turn-navi.ts");
  expect(navi).toContain('role: "user" as const');
  expect(navi).toContain("<runtime_context");
  // The system message stays the persona.
  expect(navi).toContain("content: naviChatPersona()");
});

test("untrusted message data is escaped with all three XML-significant characters", () => {
  // A message containing a literal `>` could close a tag early and read as
  // structure instead of data. Both prompt builders escape the same set.
  for (const file of [
    "packages/framework/provider-model/src/provider-runner.ts",
    "packages/domains/collab/src/chat-prompt.ts",
    "packages/domains/collab/src/chat-turn-common.ts",
  ]) {
    const text = source(file);
    expect(text, `${file} escapes &`).toContain('.replaceAll("&", "&amp;")');
    expect(text, `${file} escapes <`).toContain('.replaceAll("<", "&lt;")');
    expect(text, `${file} escapes >`).toContain('.replaceAll(">", "&gt;")');
  }
});

test("a mid-context refresh appends a new snapshot rather than mutating an earlier message", () => {
  // ADR D5/D6: the revision counter rises on each injection and the insert goes
  // before the trailing request, so a collaboration that arrives mid-turn is
  // visible without rewriting history the provider already cached.
  const runner = source(
    "packages/framework/provider-model/src/provider-runner.ts",
  );
  expect(runner).toContain("runtimeContextRevision += 1");
  expect(runner).toContain("target.splice(insertAt, 0, context)");
});
