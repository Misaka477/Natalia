/**
 * Shape tokens (theme 包的非颜色部分): radius, spacing, typography, motion
 * and the elevation expressions. These are the theme's own language — a
 * different theme pack swaps these without touching any palette value.
 *
 * Elevation tokens hold complete box-shadow expressions that reference the
 * palette's shadow colors, so switching the palette re-colors every
 * elevation without rewriting the expression.
 */

export const shapeTokens = {
  // radius scale (base.ts hardcoded 3–18px across selectors)
  "--neu-radius-1": "4px",
  "--neu-radius-2": "8px",
  "--neu-radius-3": "12px",
  "--neu-radius-4": "16px",
  "--neu-radius-5": "22px",
  "--neu-radius-pill": "999px",
  // legacy names consumed across the stylesheet, mapped onto the scale
  "--neu-radius": "22px",
  "--neu-radius-sm": "12px",
  // spacing scale (shell gap/padding was a hardcoded 14px)
  "--neu-space-1": "4px",
  "--neu-space-2": "8px",
  "--neu-space-3": "14px",
  "--neu-space-4": "18px",
  // typography (base.ts hardcoded 9–16px with no scale)
  "--neu-font-mono": '"JetBrains Mono", "SF Mono", Consolas, monospace',
  "--neu-font-xs": "9px",
  "--neu-font-sm": "11px",
  "--neu-font-md": "12px",
  "--neu-font-base": "14px",
  "--neu-font-lg": "16px",
  // motion (the 0.25s ease pass at base.ts:4533-4554)
  "--neu-motion-fast": "0.12s ease",
  "--neu-motion-base": "0.25s ease",
  // elevation: outer (raised)
  "--neu-elevation-1":
    "2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light)",
  "--neu-elevation-2":
    "3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light)",
  "--neu-elevation-3":
    "3px 3px 8px var(--neu-shadow-dark), -3px -3px 8px var(--neu-shadow-light)",
  "--neu-elevation-4":
    "4px 4px 12px var(--neu-shadow-dark), -4px -4px 12px var(--neu-shadow-light)",
  "--neu-elevation-5":
    "6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light)",
  "--neu-elevation-6":
    "8px 8px 20px var(--neu-shadow-dark), -8px -8px 20px var(--neu-shadow-light)",
  "--neu-elevation-accent":
    "3px 3px 6px var(--neu-accent-shadow), -3px -3px 6px var(--neu-shadow-light)",
  // elevation: inner (inset / pressed)
  "--neu-inset-1":
    "inset 1px 1px 2px var(--neu-shadow-dark), inset -1px -1px 2px var(--neu-shadow-light)",
  "--neu-inset-2":
    "inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light)",
  "--neu-inset-3":
    "inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light)",
  "--neu-inset-accent":
    "inset 3px 3px 6px var(--neu-inset-pressed-dark), inset -3px -3px 6px var(--neu-inset-pressed-light)",
  // elevation: flat drop shadow and hairline ring (non-neumorphic surfaces)
  "--neu-elevation-flat": "0 4px 12px var(--neu-float-scrim)",
  "--neu-elevation-float": "0 18px 48px var(--neu-float-scrim)",
  "--neu-elevation-float-sm": "0 12px 32px var(--neu-float-scrim)",
  "--neu-ring": "inset 0 0 0 1px var(--neu-border)",
  // state rings (the inset 0 0 0 1px family across panels)
  "--neu-ring-raised": "inset 0 0 0 1px var(--neu-surface-raised-strong)",
  "--neu-ring-accent": "inset 0 0 0 1px var(--neu-accent-soft)",
  "--neu-ring-info": "inset 0 0 0 1px var(--neu-state-info-border)",
  "--neu-ring-warn": "inset 0 0 0 1px var(--neu-state-warn-border)",
  "--neu-ring-ok": "inset 0 0 0 1px var(--neu-state-ok-border)",
  "--neu-ring-danger": "inset 0 0 0 1px var(--neu-state-danger-border)",
} as const satisfies Record<string, string>;

export type ShapeSlot = keyof typeof shapeTokens;

/**
 * Derived color aliases kept in CSS (color-mix over palette slots), listed
 * here so the theme layer can assert they exist in the stylesheet.
 */
export const derivedColorSlots = [
  "--neu-scrollbar",
  "--neu-scrollbar-hover",
  "--neu-accent-shadow",
  "--neu-focus-ring",
  "--neu-resizer-hover",
  "--neu-hairline-accent",
  "--neu-diff-removed-bg",
  "--neu-diff-added-bg",
  "--neu-error-soft",
  "--neu-danger",
] as const;
