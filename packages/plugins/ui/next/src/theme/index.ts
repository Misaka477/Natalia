/**
 * Theme layer: the composition point between a color palette (配色包) and
 * the shape tokens (theme 包), plus the application entry the shell calls.
 *
 * `applyTheme` writes every CSS variable in one pass and marks the document
 * with the active scheme, so switching the palette never touches shape and
 * switching the theme never touches color values.
 */

import { applyUiSkin, defineUiSkin, type UiSkin } from "@natalia/ui-kit";
import {
  PALETTES,
  PALETTE_BOOT_BG,
  PALETTE_MODES,
  type PaletteMode,
} from "./palettes";
import { shapeTokens } from "./shape";

export { PALETTES, PALETTE_BOOT_BG, PALETTE_MODES } from "./palettes";
export type { PaletteMode, PaletteSlot, PaletteTokens } from "./palettes";
export { shapeTokens, derivedColorSlots } from "./shape";
export type { ShapeSlot } from "./shape";

/** Color schemes the shell can switch between. */
export const THEME_MODES = PALETTE_MODES;

/** Resolve a stored preference to a palette mode; anything unknown is light. */
export function resolveThemeMode(
  value: string | undefined | null,
): PaletteMode {
  return value === "dark" ? "dark" : "light";
}

/** Every CSS variable one theme application writes: palette values plus shape tokens. */
export function themeCssVars(mode: PaletteMode): Record<string, string> {
  return { ...PALETTES[mode], ...shapeTokens };
}

/** The palette as a kit UiSkin, for the kit's own applyUiSkin path. */
export function themeSkin(mode: PaletteMode): UiSkin {
  return defineUiSkin({
    id: mode,
    name: mode === "dark" ? "Dark" : "Light",
    version: "1.0.0",
    tokens: { ...PALETTES[mode] },
  });
}

/**
 * CSS that colors the document canvas before first paint, so a dark-scheme
 * user never sees a white flash while the shell boots.
 */
export function bootThemeStyle(mode: PaletteMode): string {
  const scheme = mode === "dark" ? "dark" : "light";
  return `:root{color-scheme:${scheme}}body{background-color:${PALETTE_BOOT_BG[mode]}}`;
}

/**
 * Apply the theme to a document root. Body portals (context menus and
 * friends) must inherit the same theme as the shell, so the document
 * element is always themed alongside the given root.
 */
export function applyTheme(
  mode: string | undefined | null,
  root?: HTMLElement,
): PaletteMode {
  const resolved = resolveThemeMode(mode);
  const skin = themeSkin(resolved);
  const documentRoot =
    root?.ownerDocument?.documentElement ??
    (typeof document === "undefined" ? undefined : document.documentElement);
  if (documentRoot) {
    applyUiSkin(skin, documentRoot);
    for (const [name, value] of Object.entries(shapeTokens)) {
      documentRoot.style.setProperty(name, value);
    }
  }
  if (root && root !== documentRoot) {
    applyUiSkin(skin, root);
    for (const [name, value] of Object.entries(shapeTokens)) {
      root.style.setProperty(name, value);
    }
  }
  return resolved;
}
