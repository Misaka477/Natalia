/**
 * Shell slots: where a UI plugin puts its own surface.
 *
 * The shell owns its layout and declares the named slots a plugin may
 * fill — the same pattern the reference harness uses, so a plugin never
 * reaches into the shell's markup and the shell never grows a
 * plugin-specific branch. A slot is registered once under its name
 * (one owner, a duplicate throws), the entry rides a revision so a
 * bundle arriving after the shell mounted still appears, and the
 * component closes over its own translate function.
 */

import { createSignal } from "solid-js";
import type { JSX } from "solid-js";

/**
 * The shell's nine slots, in the order the information architecture
 * names them. A plugin registers into one; the shell renders whichever
 * are filled.
 */
export const SLOT_NAMES = [
  /** Left of the topbar's brand block. */
  "topbar.start",
  /** The topbar's trailing area, before the shell's own controls. */
  "topbar.end",
  /** The dock beside the composer (attachments, context, tools). */
  "input.dock",
  /** The run bar under the transcript: what the turn is doing now. */
  "runbar",
  /** The decision slot: where a pending question is answered. */
  "decision",
  /** The status area at the bottom of the shell. */
  "statusbar",
  /** Beside an empty transcript, under the shell's own empty state. */
  "transcript.empty",
  /** Inside the right rail, after the shell's own tabs. */
  "workbench.end",
  /** The settings window, after the shell's own sections. */
  "settings.end",
] as const;

export type SlotName = (typeof SLOT_NAMES)[number];

/** A slot entry: one component, with the props the shell passes it. */
export type SlotComponent = (props: {
  /** The shell's translate function, so the entry switches language. */
  t: (key: string, params?: Record<string, unknown>) => string;
}) => JSX.Element;

interface SlotEntry {
  component: SlotComponent;
}

export class SlotsRegistry {
  private readonly slots = new Map<string, SlotEntry>();
  /** The reactivity seat: read during render so a late registration
   *  re-renders the slot it fills. */
  private readonly revisionSignal = createSignal(0);

  /**
   * Fill a slot. A slot has one owner: a duplicate registration throws,
   * so two plugins cannot fight over one place.
   */
  register(name: string, component: SlotComponent): () => void {
    if (!(SLOT_NAMES as readonly string[]).includes(name)) {
      throw new Error(`slot "${name}" is not one of the shell's slots`);
    }
    const existing = this.slots.get(name);
    if (existing) throw new Error(`slot "${name}" already has an entry`);
    const entry: SlotEntry = { component };
    this.slots.set(name, entry);
    this.publish();
    return () => {
      if (this.slots.get(name) !== entry) return;
      this.slots.delete(name);
      this.publish();
    };
  }

  /** The entry registered for a slot, if any. */
  get(name: string): SlotComponent | undefined {
    this.revisionSignal[0]();
    return this.slots.get(name)?.component;
  }

  /** Every filled slot, for diagnostics. */
  filled(): string[] {
    return [...this.slots.keys()].sort();
  }

  private publish(): void {
    this.revisionSignal[1](this.revisionSignal[0]() + 1);
  }
}

/** The shell's registry, created once at mount. */
export function createSlotsRegistry(): SlotsRegistry {
  return new SlotsRegistry();
}
