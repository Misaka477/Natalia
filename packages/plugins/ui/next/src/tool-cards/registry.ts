/**
 * Tool card registry: how a tool (or its plugin) brings its own card.
 *
 * Every tool renders as a card in the transcript. The kit ships the
 * shared renderers (read / diff / terminal / search / web / generic);
 * a tool that needs its own presentation registers a component under its
 * tool name here, and the transcript prefers it over the shared ones.
 * A tool with no registered card still gets a card — the structured
 * `card` slot picks a shared renderer, and the generic card is the floor.
 *
 * The registry rides `ctx.extra.toolCards`, so a UI plugin bundle
 * arriving after the shell mounted registers its cards and the
 * transcript picks them up on the next revision.
 */

import { createSignal } from "solid-js";
import type { ToolCardComponent, ToolCardRegistryLike } from "@natalia/ui-kit";

/** Options a registration may carry. */
export interface ToolCardRegistration {
  /**
   * The locale namespace the card's copy lives in. The component closes
   * over its own translate function; this records the binding for
   * diagnostics.
   */
  localeNS?: string;
}

export class ToolCardRegistry implements ToolCardRegistryLike {
  private readonly cards = new Map<
    string,
    { component: ToolCardComponent; localeNS?: string }
  >();
  /** The reactivity seat: read during render so a late registration
   *  re-renders mounted rows. */
  private readonly revisionSignal = createSignal(0);

  /**
   * Register a tool's own card. A tool name has one owner: a duplicate
   * registration throws, so two plugins cannot fight over one row.
   */
  register(
    toolName: string,
    component: ToolCardComponent,
    options?: ToolCardRegistration,
  ): () => void {
    if (!toolName) throw new Error("tool card registration needs a tool name");
    const existing = this.cards.get(toolName);
    if (existing) {
      throw new Error(`tool "${toolName}" already has a registered card`);
    }
    const entry = { component, localeNS: options?.localeNS };
    this.cards.set(toolName, entry);
    this.publish();
    return () => {
      if (this.cards.get(toolName) !== entry) return;
      this.cards.delete(toolName);
      this.publish();
    };
  }

  /** The card registered for a tool name, if any. */
  get(toolName: string): ToolCardComponent | undefined {
    return this.cards.get(toolName)?.component;
  }

  /** The locale namespace a tool's card registered under, if any. */
  localeNSFor(toolName: string): string | undefined {
    return this.cards.get(toolName)?.localeNS;
  }

  /** Read during render so a late registration re-renders mounted rows. */
  revision(): number {
    return this.revisionSignal[0]();
  }

  /** Every registered tool name, for diagnostics and the guard test. */
  toolNames(): string[] {
    return [...this.cards.keys()].sort();
  }

  private publish(): void {
    this.revisionSignal[1](this.revisionSignal[0]() + 1);
  }
}

/** The built-in card kinds the shared renderers cover. */
export const SHARED_CARD_KINDS = [
  "read",
  "diff",
  "terminal",
  "search",
  "web",
  "generic",
] as const;

export type SharedCardKind = (typeof SHARED_CARD_KINDS)[number];

/**
 * Which presentation a tool call gets, as a pure decision:
 *
 *   1. the tool's own registered card (the tool author wrote it);
 *   2. a shared renderer picked by the structured `card` slot;
 *   3. the generic card — every tool gets one.
 */
export function resolveToolCard(input: {
  toolName: string;
  cardKind?: string | undefined;
  registry?: ToolCardRegistryLike | undefined;
}):
  | { tier: "registered" }
  | { tier: "shared"; kind: SharedCardKind }
  | { tier: "generic" } {
  if (input.registry?.get(input.toolName)) return { tier: "registered" };
  const kind = input.cardKind;
  if (kind && (SHARED_CARD_KINDS as readonly string[]).includes(kind)) {
    return { tier: "shared", kind: kind as SharedCardKind };
  }
  return { tier: "generic" };
}
