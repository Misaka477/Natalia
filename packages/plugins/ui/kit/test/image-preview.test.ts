/**
 * The image preview is ONE shell overlay, not a copy per thumbnail.
 *
 * Measured defect: the preview was rendered inside `AttachmentImage`, i.e. inside
 * a `.natalia-message` row, and that row is
 * `.neu-pane .natalia-message { position: relative; z-index: 1 }` — a stacking
 * context. The overlay's `z-index: 80` therefore only ordered it against siblings
 * inside that one message: the next message (also z-index 1, later in the DOM) and
 * the whole right column (`.neu-secondary-content { z-index: 2 }`) painted over
 * the preview, and its 78% backdrop showed only in the gaps between panes.
 *
 * The state is deliberately module-level and singleton: opening a second image
 * replaces the first, and every host (the main transcript, Navi's chat, the agent
 * panel) goes through the same one overlay rendered at the shell root.
 */
import { expect, test } from "bun:test";
import {
  closeImagePreview,
  imagePreview,
  openImagePreview,
} from "../src/image-preview";

test("opening an image shows it, closing it clears it", () => {
  closeImagePreview();
  expect(imagePreview()).toBeUndefined();
  openImagePreview({ src: "data:image/png;base64,AAA", name: "a.png" });
  expect(imagePreview()).toEqual({
    src: "data:image/png;base64,AAA",
    name: "a.png",
  });
  closeImagePreview();
  expect(imagePreview()).toBeUndefined();
});

test("a second request replaces the first — one overlay, one image", () => {
  closeImagePreview();
  openImagePreview({ src: "data:image/png;base64,AAA", name: "a.png" });
  openImagePreview({ src: "data:image/png;base64,BBB", name: "b.png" });
  expect(imagePreview()?.name).toBe("b.png");
  closeImagePreview();
});

test("an empty source does not open an overlay", () => {
  // A thumbnail whose load produced nothing must not dim the whole app.
  closeImagePreview();
  openImagePreview({ src: "", name: "empty.png" });
  expect(imagePreview()).toBeUndefined();
});
