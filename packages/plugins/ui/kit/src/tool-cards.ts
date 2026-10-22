/**
 * Tool card contract: how a tool (or its plugin) brings its own card.
 *
 * Every tool renders as a card in the transcript. The kit ships the
 * shared renderers (read / diff / terminal / search / web / generic);
 * a tool that needs its own presentation registers a component under its
 * tool name through the shell's registry, and the transcript prefers it
 * over the shared ones. A tool with no registered card and no structured
 * `card` slot still gets the generic card — there is no tool without a
 * card.
 *
 * The component closes over its own translate function (its plugin's
 * locale namespace), so the card's copy switches with the shell.
 */

import type { JSX } from "solid-js";
import type { ToolCall } from "./message";

/** A tool's own card: everything the card shows, derived from the call. */
export type ToolCardComponent = (props: { view: ToolCall }) => JSX.Element;

/**
 * The structural registry face the transcript consults. Implemented by
 * the shell's registry; absent means "shared renderers only".
 */
export interface ToolCardRegistryLike {
  /** The card registered for a tool name, if any. */
  get(toolName: string): ToolCardComponent | undefined;
  /** Read during render so a late registration re-renders mounted rows. */
  revision?: () => number;
}
