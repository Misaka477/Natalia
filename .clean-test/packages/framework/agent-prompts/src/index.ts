/**
 * Unified agent system prompts — @natalia/agent-prompts.
 *
 * One place for the core agents' static personas, composed from a shared
 * preamble (universal discipline) plus the agent's own persona. Prompts live as
 * `.txt` files (raw strings, inlined at build) so they are editable data, not
 * scattered inline strings. A standalone leaf package so both the client and
 * provider-model (a lower layer) can share one assembly point.
 *
 * Static vs dynamic: this builds only the STATIC system prompt. Per-turn dynamic
 * context (plan / drift / goal / collaboration) is appended separately as
 * `<runtime_context>` — never inlined here (ADR D1/D2, prompt-cache friendly).
 *
 * The subagent prompt is context-variant (sandboxed vs plain) and the team
 * prompts live in the team plugin — both stay where they are.
 */
import PREAMBLE from "./preamble.txt";
import NATALIA from "./natalia.txt";
import NAVI from "./navi.txt";
import NIA from "./nia.txt";

export type AgentID = "natalia" | "navi" | "nia";

/** Each core agent's persona / static block (its own `.txt`). */
const PERSONAS: Record<AgentID, string> = {
  natalia: NATALIA,
  navi: NAVI,
  nia: NIA,
};

/** The shared universal discipline every agent reads first. */
export function agentPromptPreamble(): string {
  return PREAMBLE;
}

/**
 * Assemble an agent's static system prompt: the shared preamble, then the
 * agent's persona, then any rare agent-specific static addition. Dynamic
 * per-turn context is appended by the caller as `<runtime_context>`.
 */
export function agentSystemPrompt(agent: AgentID, extra?: string): string {
  return [PREAMBLE, PERSONAS[agent], extra].filter(Boolean).join("\n\n");
}

/**
 * The composed static system prompt (ADR D1): the persona
 * (`agentSystemPrompt`), the per-agent instruction overlay and the goal
 * policy — POLICY content, composed HERE so the engine can render and
 * forward it without carrying a brand, a persona, or a goal rule
 * (§1.1: the engine knows no product). Byte-identical for the same
 * agent role across sessions and workspaces; per-turn dynamic state
 * never enters this block (provider prefix caches key off it).
 */
export function staticSystemPrompt(agentPrompt?: string): string {
  const lines = agentSystemPrompt("natalia").split("\n");
  if (agentPrompt?.trim()) {
    lines.push(
      "<agent_instructions>",
      agentPrompt.trim(),
      "</agent_instructions>",
    );
  }
  lines.push(
    "<goal_policy>",
    "Use the goal tools for one long-running completion objective in the current session.",
    "Propose a goal when a direct human request is a multi-step objective, but never for routine single-turn work; confirm with the user through ask_user before calling create_goal.",
    "Call get_goal before update_goal and copy its exact goal_id and revision.",
    "After session resume or fork an active goal is disarmed: when a human asks to continue in any wording, use update_goal action resume to re-arm it.",
    "Mark complete only when the objective is actually achieved. Mark blocked only after the same blocking condition persists across at least 3 consecutive goal rounds, and report that concrete condition in blocked_reason; difficulty, uncertainty, or useful remaining work is not blocked. When you must stop for a human decision, use ask_user.",
    "</goal_policy>",
  );
  return lines.join("\n");
}
