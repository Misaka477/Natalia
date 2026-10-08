/**
 * The default card a presenter-less tool earns (UI refactor R5.5, moved to
 * the leaf in R6 so a KERNEL-side consumer can use it too).
 *
 * It takes the tool's NAME as data — there is no tool name in this module —
 * which is what lets both the runtime (at publish time) and the view-store
 * (when folding an event recorded before cards existed) build the same card.
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
import type { ToolCard } from "./events";
import { toolResultBody } from "./tool-body";
import { toolResultSummary } from "./tool-summary";

export function defaultToolCard(name: string, result: string): ToolCard {
  return {
    kind: "generic",
    title: name,
    summary: toolResultSummary(result),
    body: toolResultBody(result),
  };
}
