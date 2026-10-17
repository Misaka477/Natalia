/**
 * The one image preview the app shows at a time.
 *
 * WHY IT IS NOT A CHILD OF THE THUMBNAIL. The preview used to be rendered inside
 * `AttachmentImage`, i.e. inside a `.natalia-message` row — and that row is
 * `.neu-pane .natalia-message { position: relative; z-index: 1 }`, a stacking
 * context. The overlay's own `z-index: 80` therefore only ordered it against
 * siblings INSIDE that one message: the next message (also `z-index: 1`, later in
 * the DOM) and the whole right column (`.neu-secondary-content { z-index: 2 }`)
 * painted straight over the preview. Reported as "the preview still has things on
 * top of it", and the 78% backdrop was only visible in the gaps between panes.
 *
 * A modal overlay belongs to the SHELL, not to a row: this module owns the state,
 * `ImagePreviewHost` renders it once at the app root, and a thumbnail only asks to
 * open.
 */
import { createSignal } from "solid-js";

export type ImagePreview = {
  /** The data URL to draw. */
  src: string;
  /** The attachment's name, for the caption and the alt text. */
  name: string;
};

const [current, setCurrent] = createSignal<ImagePreview | undefined>(undefined);

/** The preview on screen, or undefined when none is open. */
export function imagePreview(): ImagePreview | undefined {
  return current();
}

/** Show one image at full size. A second request replaces the first. */
export function openImagePreview(preview: ImagePreview): void {
  if (!preview.src) return;
  setCurrent(preview);
}

/** Close the preview. Idempotent: closing nothing is not an error. */
export function closeImagePreview(): void {
  setCurrent(undefined);
}
