/**
 * Capturing the screen.
 *
 * A screenshot is evidence, so it is captured the way the click is verified:
 * the same physical pixel grid, from the screen device context, through a
 * compatible bitmap, into a PNG the model can look at. Nothing is
 * synthesized and nothing is scaled — a 4K screen at 150% reports its real
 * size because the process is DPI aware, and the image is that size.
 *
 * The region math is pure (coords.ts); this module is the native half.
 */
import { bgraToRgb, encodePng } from "../png";
import { clipToBounds, type Rect } from "../coords";
import { desktopLibraries } from "./ffi";
import { virtualScreen } from "./screen";

/** SRCCOPY: the source rectangle copied verbatim. */
const SRCCOPY = 0x00cc0020;
/** DIB_RGB_COLORS: the color table is literal RGB, not a palette. */
const DIB_RGB_COLORS = 0;
/** BI_RGB: uncompressed. */
const BI_RGB = 0;
/** 32 bits per pixel, BGRA order, as a screen bitmap delivers. */
const BITS_PER_PIXEL = 32;

export type CapturedFrame = {
  /** The region really captured (the request, clipped to the screen). */
  rect: Rect;
  width: number;
  height: number;
  rgb: Uint8Array;
  png: Uint8Array;
};

/** A 40-byte BITMAPINFOHEADER for a top-down 32bpp read. */
function bitmapInfoHeader(width: number, height: number): Buffer {
  const header = Buffer.alloc(40);
  header.writeUInt32LE(40, 0); // biSize
  header.writeInt32LE(width, 4); // biWidth
  // A negative height asks for a top-down image, which is the row order a
  // screenshot reader expects; a positive one returns bottom-up.
  header.writeInt32LE(-height, 8); // biHeight
  header.writeUInt16LE(1, 12); // biPlanes
  header.writeUInt16LE(BITS_PER_PIXEL, 14); // biBitCount
  header.writeUInt32LE(BI_RGB, 16); // biCompression
  header.writeUInt32LE(0, 20); // biSizeImage
  header.writeInt32LE(0, 24); // biXPelsPerMeter
  header.writeInt32LE(0, 28); // biYPelsPerMeter
  header.writeUInt32LE(0, 32); // biClrUsed
  header.writeUInt32LE(0, 36); // biClrImportant
  return header;
}

/**
 * Capture a region of the screen.
 *
 * The request is clipped to the virtual screen first: a window dragged
 * half off-screen asks for pixels that do not exist, and the answer names
 * the region it really got rather than padding the frame with a guess.
 */
export function captureRegion(region: Rect): CapturedFrame {
  const bounds = virtualScreen();
  const rect = clipToBounds(region, bounds);
  if (!rect || rect.w <= 0 || rect.h <= 0)
    throw new Error(
      `computer_screenshot: region ${JSON.stringify(region)} is outside the ` +
        `screen ${JSON.stringify(bounds)}`,
    );
  const libs = desktopLibraries();
  const screenDC = libs.user32.GetDC(null);
  if (!screenDC)
    throw new Error("computer_screenshot: the screen device context refused");
  const memoryDC = libs.gdi32.CreateCompatibleDC(screenDC);
  const bitmap = libs.gdi32.CreateCompatibleBitmap(screenDC, rect.w, rect.h);
  try {
    if (!memoryDC || !bitmap)
      throw new Error("computer_screenshot: the capture bitmap refused");
    libs.gdi32.SelectObject(memoryDC, bitmap);
    // The screen DC's origin is the virtual screen's top-left, so a region
    // on a second monitor is addressed by subtracting it.
    const blitted = libs.gdi32.BitBlt(
      memoryDC,
      0,
      0,
      rect.w,
      rect.h,
      screenDC,
      rect.x - bounds.x,
      rect.y - bounds.y,
      SRCCOPY,
    );
    if (!blitted)
      throw new Error(
        "computer_screenshot: BitBlt failed (the region may be covered by a " +
          "protected surface)",
      );
    const info = bitmapInfoHeader(rect.w, rect.h);
    const pixels = Buffer.alloc(rect.w * rect.h * 4);
    const lines = libs.gdi32.GetDIBits(
      memoryDC,
      bitmap,
      0,
      rect.h,
      pixels,
      info,
      DIB_RGB_COLORS,
    );
    if (lines !== rect.h)
      throw new Error(
        `computer_screenshot: read ${lines} of ${rect.h} scanlines`,
      );
    const rgb = bgraToRgb(pixels, rect.w * rect.h);
    return {
      rect,
      width: rect.w,
      height: rect.h,
      rgb,
      png: encodePng(rect.w, rect.h, rgb),
    };
  } finally {
    // The DCs and the bitmap are GDI objects; leaking one per capture
    // eventually refuses the next one, which reads as "screenshots stopped
    // working" with nothing in between to explain it.
    if (bitmap) libs.gdi32.DeleteObject(bitmap);
    if (memoryDC) libs.gdi32.DeleteDC(memoryDC);
    libs.user32.ReleaseDC(null, screenDC);
  }
}

/** Capture the whole virtual screen. */
export function captureScreen(): CapturedFrame {
  return captureRegion(virtualScreen());
}

/**
 * Capture one window's client area.
 *
 * The window's handle named the geometry; the capture itself is a screen
 * region, and the client origin and size are that region — which is also
 * why the answer carries them: they are the translation a click needs.
 */
export function captureWindowClient(
  origin: { x: number; y: number },
  size: { w: number; h: number },
): CapturedFrame {
  return captureRegion({ x: origin.x, y: origin.y, w: size.w, h: size.h });
}
