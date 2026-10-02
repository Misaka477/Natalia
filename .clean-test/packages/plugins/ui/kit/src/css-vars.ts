/**
 * Reads a CSS custom property from the document root. This lets JS-rendered
 * surfaces (CodeMirror, xterm, canvas renderers) follow the active UiSkin
 * without hardcoding colors.
 */
export function cssVar(name: string, fallback = ""): string {
  if (typeof document === "undefined") return fallback;
  const value = getComputedStyle(document.documentElement)
    .getPropertyValue(name)
    .trim();
  return value || fallback;
}
