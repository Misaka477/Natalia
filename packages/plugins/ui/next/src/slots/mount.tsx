/**
 * Renders one shell slot's entry, if a plugin filled it. A slot reads
 * the registry's revision during render, so a late registration appears
 * without the region remounting.
 */

import { Show } from "solid-js";
import type { SlotsRegistry, SlotName } from "./registry";

export function SlotMount(props: {
  slots: SlotsRegistry;
  name: SlotName;
  t: (key: string, params?: Record<string, unknown>) => string;
}) {
  // Called directly rather than rendered as JSX: a slot entry is a
  // plain component function, and calling it keeps the type surface out
  // of the JSX namespace.
  return (
    <Show when={props.slots.get(props.name)}>
      {(entry) => entry()({ t: props.t })}
    </Show>
  );
}
