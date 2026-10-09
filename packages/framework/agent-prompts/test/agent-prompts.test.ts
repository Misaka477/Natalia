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

test("each agent's prompt names only the tools its surface holds (2026-10-10)", () => {
  // The 2026-10-10 sweep's finding: Nia's prompt named five cold-vault
  // context tools her surface never received, and the main agent's
  // `plan_propose` told it to hand off with `mailbox_send` — a tool only
  // Navi holds. An agent sees its own surface and nothing else: a prompt
  // naming a tool the registry does not hand that agent is a lie the model
  // pays for.
  const held = {
    navi: [
      "read_file",
      "glob",
      "grep",
      "web_fetch",
      "web_search",
      "session_history",
      "work_contract_read",
      "work_graph_query",
      "plan_propose",
      "run_shell",
      "session_snapshot",
      "mailbox_status",
      "collab_chat",
      "mailbox_send",
      "mailbox_cancel",
      "collab_suggest",
      "collab_answer",
      "plan_doc_read",
      "plan_doc_list",
      "plan_doc_write",
    ],
    nia: [
      "read_file",
      "glob",
      "grep",
      "web_fetch",
      "web_search",
      "session_history",
      "work_contract_read",
      "work_graph_query",
      "run_shell",
      "session_snapshot",
      "mailbox_status",
      "collab_chat",
      "audit_report",
      "diff_workspace",
      "plan_doc_read",
      "plan_doc_list",
      "plan_doc_write",
    ],
    main: [
      "read_file",
      "glob",
      "grep",
      "web_fetch",
      "web_search",
      "session_history",
      "work_contract_read",
      "work_graph_query",
      "plan_propose",
      "plan_doc_read",
      "plan_doc_tick",
      "plan_pause",
      "record_validation",
      "record_completion",
      "todo_read",
      "todo_write",
      "ask_user",
    ],
  } as const;
  // The cold-vault tools are the main agent's alone.
  const mainOnly = [
    "context_search",
    "context_list",
    "context_read",
    "context_history",
    "context_pack",
  ];
  for (const agent of ["navi", "nia"] as const) {
    const prompt = agentSystemPrompt(agent);
    for (const tool of held[agent])
      expect(prompt, `${agent} must be told about ${tool}`).toContain(tool);
    for (const tool of mainOnly)
      expect(prompt, `${agent} must NOT be told about ${tool}`).not.toContain(
        tool,
      );
    // And the surface is stated as its own, not as someone else's.
    expect(prompt).toContain("YOUR tools");
  }
  // The main agent's prompt is persona-level and does not enumerate its
  // catalogue (the catalogue itself is the surface it sees); what matters is
  // that it never names another agent's tool.
  const main = agentSystemPrompt("natalia");
  for (const tool of ["mailbox_send", "mailbox_cancel", "collab_suggest"])
    expect(main, `main must NOT be told about ${tool}`).not.toContain(tool);
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
