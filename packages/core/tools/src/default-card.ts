/**
 * The default card a presenter-less tool earns (UI refactor R5.5).
 *
 * A tool that declares no output definition — a third-party plugin's, a
 * self-generated one, a built-in nobody has wired yet — still owes the
 * transcript a reading rather than a raw result string. The runtime
 * publishes THIS for it: the tool's own name as the title, the row-line
 * derivation as the summary, and the shared flatten as the body. A client
 * then renders a card like any other and parses nothing.
 *
 * The flatten is the contracts leaf's, so the kernel and a UI cannot drift
 * about what "readable" means. The tool-name special cases the old
 * UI-side flattener carried are NOT here: a contract must not know tool
 * names, and every built-in they covered declares its own presenter now.
 */
import { toolResultBody, toolResultSummary } from "@anthelia/contracts";
import type { ToolCard } from "./types";

export function defaultToolCard(name: string, result: string): ToolCard {
  return {
    kind: "generic",
    title: name,
    summary: toolResultSummary(result),
    body: toolResultBody(result),
  };
}
