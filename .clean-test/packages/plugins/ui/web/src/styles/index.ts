import { applyUiSkin } from "@natalia/ui-kit";
import { confirmDialogCss, nataliaNeuBaseStyles } from "./base";
import { nataliaNeuThemeLight } from "./theme-light";
import { nataliaNeuThemeDark } from "./theme-dark";
import { NATALIA_SKINS, type NeuThemeMode } from "../skins";

export { nataliaNeuBaseStyles } from "./base";
export { nataliaNeuThemeLight } from "./theme-light";
export { nataliaNeuThemeDark } from "./theme-dark";

export { NATALIA_SKINS, NEU_THEME_MODES } from "../skins";

export const nataliaNeuThemeStyles = nataliaNeuThemeLight + nataliaNeuThemeDark;

export const nataliaNeuStyles =
  nataliaNeuThemeStyles + nataliaNeuBaseStyles + confirmDialogCss;

export function resolveNeuThemeMode(
  value: string | undefined | null,
): NeuThemeMode {
  return value === "dark" ? "dark" : "light";
}

export function applyNeuTheme(
  mode: string | undefined | null,
  root?: HTMLElement,
) {
  const resolved = resolveNeuThemeMode(mode);
  const skin = NATALIA_SKINS[resolved];
  // Body portals (including context menus) must inherit the same theme as the shell.
  const documentRoot =
    root?.ownerDocument.documentElement ?? document.documentElement;
  applyUiSkin(skin, documentRoot);
  if (root && root !== documentRoot) applyUiSkin(skin, root);
  return resolved;
}
