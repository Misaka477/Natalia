import { expect, test } from "bun:test";
import { agentPromptPreamble, agentSystemPrompt } from "../src/index";

test("agentSystemPrompt prepends the shared preamble then the persona", () => {
  const navi = agentSystemPrompt("navi");
  // Preamble first (shared discipline), then the persona tag.
  expect(navi.startsWith(agentPromptPreamble())).toBe(true);
  expect(navi).toContain("<navi_chat_persona>");
  expect(navi).toContain("</navi_chat_persona>");
  // The persona follows the preamble.
  expect(navi.indexOf("<navi_chat_persona>")).toBeGreaterThan(
    navi.indexOf(agentPromptPreamble()),
  );
});

test("each agent gets its own persona under the same preamble", () => {
  for (const [agent, tag] of [
    ["natalia", "<natalia_cli_persona>"],
    ["navi", "<navi_chat_persona>"],
    ["nia", "<nia_chat_persona>"],
  ] as const) {
    const prompt = agentSystemPrompt(agent);
    expect(prompt.startsWith(agentPromptPreamble())).toBe(true);
    expect(prompt).toContain(tag);
  }
});

test("extra static text is appended after the persona", () => {
  const prompt = agentSystemPrompt("nia", "Use the tools for filesystem work.");
  expect(prompt.endsWith("Use the tools for filesystem work.")).toBe(true);
});

test("Navi and Nia are wired to the read-only context tools (Phase2b-2)", () => {
  // The RINA study's prompt wiring: both sisters search the structured
  // memory first and page the transcript only for exact wording. The five
  // tool names are the contract between the prompt and the registry.
  for (const agent of ["navi", "nia"] as const) {
    const prompt = agentSystemPrompt(agent);
    for (const tool of [
      "context_search",
      "context_list",
      "context_read",
      "context_history",
      "context_pack",
    ])
      expect(prompt).toContain(tool);
    // Retrieval-first: the context tools precede the transcript fallback.
    expect(prompt).toContain("context tools first");
    // The honest degradation: no vault -> page the log instead.
    expect(prompt).toContain("vault_unavailable");
    expect(prompt).toContain("session_history");
    // The isolation rule the tools enforce is stated to the model too.
    expect(prompt).toContain("another session is refused");
  }
});

test("all three agents carry a Chinese name — the family is not two-thirds named", () => {
  // Nia was the only sister without one, so a Chinese-speaking user could
  // be greeted by a name Natalia and Navi both had and Nia did not. Each
  // persona names itself in Chinese, and Navi knows her other sister's.
  expect(agentSystemPrompt("natalia")).toContain("娜塔莉娅");
  expect(agentSystemPrompt("navi")).toContain("娜薇");
  expect(agentSystemPrompt("nia")).toContain("妮娅");
  // The family knowledge runs both ways: Navi addresses Nia by name.
  expect(agentSystemPrompt("navi")).toContain("妮娅");
  // And each name appears exactly once (a duplicated self-introduction is
  // the drift this catches).
  for (const [agent, name] of [
    ["natalia", "娜塔莉娅"],
    ["navi", "娜薇"],
    ["nia", "妮娅"],
  ] as const) {
    const prompt = agentSystemPrompt(agent);
    expect(prompt.split(name).length - 1).toBeGreaterThanOrEqual(1);
  }
});
