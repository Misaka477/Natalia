/**
 * Command registry: the shell's commands, and a plugin's own.
 *
 * The command palette (Ctrl+K) reads this list. The shell registers its
 * own commands at mount; a UI plugin registers its own under its own
 * ids through `ctx.extra.commands`, so the palette is one surface for
 * everything without the shell knowing any plugin's command. A command
 * id has one owner (a duplicate throws), the list rides a revision so a
 * late registration appears, and each command closes over its own
 * translate function for its title.
 */

import { createSignal } from "solid-js";

export interface ShellCommand {
  /** Stable id; the shell's own are `shell.*`. */
  id: string;
  /** What the palette shows. */
  title: string;
  /** One line under the title. */
  hint?: string;
  /** Extra words the filter matches, so a synonym finds it. */
  keywords?: readonly string[];
  /** What Enter does. */
  run: () => void;
}

export class CommandRegistry {
  private readonly commands = new Map<string, ShellCommand>();
  /** The reactivity seat: read during render so a late registration
   *  appears in an open palette. */
  private readonly revisionSignal = createSignal(0);

  /** Register a command. An id has one owner: a duplicate throws. */
  register(command: ShellCommand): () => void {
    if (!command.id) throw new Error("a command needs an id");
    const existing = this.commands.get(command.id);
    if (existing)
      throw new Error(`command "${command.id}" is already registered`);
    this.commands.set(command.id, command);
    this.publish();
    return () => {
      if (this.commands.get(command.id) !== command) return;
      this.commands.delete(command.id);
      this.publish();
    };
  }

  /** Every command, in registration order. */
  list(): ShellCommand[] {
    this.revisionSignal[0]();
    return [...this.commands.values()];
  }

  /** The commands a query matches, in list order. Empty query: all. */
  search(query: string): ShellCommand[] {
    const needle = query.trim().toLowerCase();
    const all = this.list();
    if (!needle) return all;
    return all.filter((command) => {
      const haystack = [
        command.title,
        command.hint ?? "",
        ...(command.keywords ?? []),
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(needle);
    });
  }

  private publish(): void {
    this.revisionSignal[1](this.revisionSignal[0]() + 1);
  }
}
