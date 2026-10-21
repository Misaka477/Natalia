/**
 * The ONE button that opens the runtime's platform chooser.
 *
 * Every path a human would otherwise type uses this component, so there is one
 * call site for the chooser and one shape for the button. Before it existed each
 * panel wrote its own: the settings panel called `props.runtime.pickDirectory`
 * directly and worked; the workspace panel routed through an `onBrowse` prop and
 * did not, because `<Show when={props.onBrowse}>` calls a function `when` and so
 * ran the chooser on every render. Two spellings of one thing is how that
 * happened.
 *
 * The dialog is the RUNTIME's, on the user's machine — a page has no host
 * channel, so this is the only way a path stops being typed. On Windows that is
 * the shell's own folder browser; on macOS AppleScript's `choose folder`; on
 * Linux zenity or kdialog.
 */
import type { RuntimeClient } from "@anthelia/contracts";

/** What the chooser selects. A directory, or one file. */
export type BrowseKind = "directory" | "file";

export function PathBrowseButton(props: {
  /** The runtime whose chooser opens. Absent renders nothing. */
  runtime?: RuntimeClient;
  /** A directory or a file. Defaults to a directory. */
  kind?: BrowseKind;
  /** Disabled while the surrounding form is busy. */
  disabled?: boolean;
  /**
   * Extra classes, for a surface whose inputs are not `neu-form-input` — the
   * governance rows style theirs as `constitution-input`, and the button has to
   * match the row it sits in.
   */
  class?: string;
  /**
   * What to do with the answer. The default fills a field; a LIST row appends
   * instead, so browsing for a second path cannot drop the first.
   */
  onPick: (path: string) => void;
}) {
  const kind = props.kind ?? "directory";
  return (
    <button
      type="button"
      class={props.class ? `neu-form-btn ${props.class}` : "neu-form-btn"}
      disabled={props.disabled || !props.runtime}
      onClick={() => {
        if (props.disabled || !props.runtime) return;
        void (async () => {
          const chosen =
            kind === "directory"
              ? await props.runtime?.pickDirectory?.()
              : await props.runtime?.pickFile?.();
          // A dismissal (`null`) leaves the field exactly as it was — the human
          // closed the dialog, which is an answer rather than a failure.
          if (typeof chosen === "string" && chosen) props.onPick(chosen);
        })();
      }}
    >
      浏览…
    </button>
  );
}
