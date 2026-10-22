import { applyUiSkin, defineUiSkin, type UiSkin } from "@natalia/ui-kit";
import {
  commandPaletteCss,
  confirmDialogCss,
  nataliaNeuBaseStyles,
} from "./base";
import {
  PALETTES,
  PALETTE_MODES,
  applyTheme,
  resolveThemeMode,
  themeSkin,
  type PaletteMode,
} from "../theme";
import { shapeTokens } from "../theme";

export {
  nataliaNeuBaseStyles,
  confirmDialogCss,
  commandPaletteCss,
} from "./base";
export {
  PALETTES,
  PALETTE_MODES,
  applyTheme,
  bootThemeStyle,
  resolveThemeMode,
  themeCssVars,
  themeSkin,
} from "../theme";
export type { PaletteMode, PaletteSlot, ShapeSlot } from "../theme";

export const THEME_MODES = PALETTE_MODES;
export type ThemeMode = PaletteMode;

/**
 * Static stylesheet defaults, generated from the palette data so the
 * hand-written CSS strings can never drift from the tokens again. Light is
 * the document default; dark applies under its attribute.
 */
function paletteCss(mode: PaletteMode): string {
  const selector =
    mode === "light" ? ':root,\n[data-theme="light"]' : '[data-theme="dark"]';
  const body = Object.entries(PALETTES[mode])
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  return `${selector} {\n  color-scheme: ${mode};\n${body}\n}\n`;
}

function shapeCss(): string {
  const body = Object.entries(shapeTokens)
    .map(([name, value]) => `  ${name}: ${value};`)
    .join("\n");
  return `:root {\n${body}\n}\n`;
}

export const nataliaNeuThemeLight = paletteCss("light");
export const nataliaNeuThemeDark = paletteCss("dark");
export const nataliaNeuShapeStyles = shapeCss();

export const nataliaNeuThemeStyles =
  nataliaNeuThemeLight + nataliaNeuThemeDark + nataliaNeuShapeStyles;

export const nataliaNeuStyles =
  nataliaNeuThemeStyles +
  nataliaNeuBaseStyles +
  confirmDialogCss +
  commandPaletteCss;

/** Skins per mode, kept for the shell's existing skin lookups. */
export const NATALIA_SKINS: Record<string, UiSkin> = {
  light: themeSkin("light"),
  dark: themeSkin("dark"),
};

export const NEU_THEME_MODES = PALETTE_MODES;
export type NeuThemeMode = PaletteMode;

/** Resolve a stored preference to a theme mode; anything unknown is light. */
export function resolveNeuThemeMode(
  value: string | undefined | null,
): NeuThemeMode {
  return resolveThemeMode(value);
}

/** Apply the active palette and shape tokens to the shell root. */
export function applyNeuTheme(
  mode: string | undefined | null,
  root?: HTMLElement,
) {
  return applyTheme(mode, root);
}

/** Re-exported so callers keep one import site for the kit's skin API. */
export { applyUiSkin, defineUiSkin };
