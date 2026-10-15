import { createSignal, For, Show, onCleanup, onMount } from "solid-js";

export type NeuSelectOption = {
  value: string;
  label: string;
};

export function NeuSelect(props: {
  value: string;
  options: NeuSelectOption[];
  /** Required only when the control actually has options to choose from. */
  onChange?: (value: string) => void;
  disabled?: boolean;
  placeholder?: string;
  class?: string;
  menuPosition?: "top" | "bottom";
  /**
   * What the trigger does INSTEAD of opening the menu.
   *
   * For a control that has nothing to choose yet: it keeps this component's
   * exact appearance — the same box, the same value line, the same chevron the
   * user already recognises in that position — and sends the click somewhere
   * useful. The alternative, opening a menu with no options in it, is a
   * control advertising choices that do not exist; substituting a different
   * widget in its place changes a toolbar the user has learned to read. Both
   * were tried on the model pickers and both were wrong.
   */
  onActivate?: () => void;
}) {
  const [open, setOpen] = createSignal(false);
  let rootEl: HTMLDivElement | undefined;

  onMount(() => {
    const handlePointerDown = (event: PointerEvent) => {
      if (rootEl && !rootEl.contains(event.target as Node)) setOpen(false);
    };
    document.addEventListener("pointerdown", handlePointerDown);
    onCleanup(() =>
      document.removeEventListener("pointerdown", handlePointerDown),
    );
  });

  const selected = () =>
    props.options.find((option) => option.value === props.value);

  return (
    <div ref={rootEl} class={`neu-select ${props.class ?? ""}`.trim()}>
      <button
        type="button"
        class="neu-select-trigger"
        disabled={props.disabled}
        onClick={() => {
          if (props.onActivate) {
            props.onActivate();
            return;
          }
          setOpen((value) => !value);
        }}
      >
        <span class="neu-select-value">
          {selected()?.label ?? props.placeholder ?? props.value}
        </span>
        <svg
          class="neu-select-chevron"
          data-open={open()}
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          stroke-width="2"
          stroke-linecap="round"
          stroke-linejoin="round"
        >
          <path d="m6 9 6 6 6-6" />
        </svg>
      </button>
      <Show when={open()}>
        <div
          class={`neu-select-menu${props.menuPosition === "top" ? " neu-select-menu-top" : ""}`}
        >
          <For each={props.options}>
            {(option) => (
              <button
                type="button"
                class="neu-select-option"
                data-active={option.value === props.value}
                onClick={() => {
                  props.onChange?.(option.value);
                  setOpen(false);
                }}
              >
                {option.label}
              </button>
            )}
          </For>
        </div>
      </Show>
    </div>
  );
}
