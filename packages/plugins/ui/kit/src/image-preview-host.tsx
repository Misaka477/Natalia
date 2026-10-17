import { Show, onCleanup, onMount } from "solid-js";
import { closeImagePreview, imagePreview } from "./image-preview";

/**
 * The image preview overlay, rendered ONCE at the app shell.
 *
 * It sits at the shell root so it is a sibling of the panes rather than a
 * descendant of a message row: the row is a stacking context
 * (`.neu-pane .natalia-message { position: relative; z-index: 1 }`), so an overlay
 * inside it cannot paint above the following messages or the right column however
 * large its own `z-index` is. `z-index: 900` puts it above the panes, the topbar
 * dropdowns (100) and the right rail; the confirm dialog's backdrop stays above it
 * at 999, because a question about an action outranks looking at a picture.
 *
 * The image is sized against the OVERLAY, not the viewport: a preview that used
 * `92vw` while living in a 300px column is the other half of the same report.
 */
export function ImagePreviewHost() {
  const onKeyDown = (event: KeyboardEvent) => {
    if (event.key === "Escape") closeImagePreview();
  };
  onMount(() => document.addEventListener("keydown", onKeyDown));
  onCleanup(() => document.removeEventListener("keydown", onKeyDown));

  return (
    <Show when={imagePreview()}>
      {(preview) => (
        <div
          class="natalia-image-preview"
          role="dialog"
          aria-modal="true"
          aria-label={preview().name}
          style={{
            position: "fixed",
            inset: "0",
            "z-index": "900",
            display: "flex",
            "align-items": "center",
            "justify-content": "center",
            padding: "24px",
            background: "rgba(0,0,0,0.78)",
            cursor: "zoom-out",
          }}
          onClick={() => closeImagePreview()}
        >
          <img
            src={preview().src}
            alt={preview().name}
            style={{
              "max-width": "100%",
              "max-height": "100%",
              "object-fit": "contain",
            }}
          />
          <div
            style={{
              position: "absolute",
              left: "50%",
              bottom: "16px",
              transform: "translateX(-50%)",
              "max-width": "82%",
              padding: "4px 10px",
              "border-radius": "8px",
              background: "rgba(0,0,0,0.55)",
              color: "#e5e5e5",
              "font-size": "12px",
              "white-space": "nowrap",
              overflow: "hidden",
              "text-overflow": "ellipsis",
              "pointer-events": "none",
            }}
          >
            {preview().name}
          </div>
        </div>
      )}
    </Show>
  );
}
