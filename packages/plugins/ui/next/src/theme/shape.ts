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
  //
  // The neumorphic language was a DUAL shadow — dark from one corner,
  // light from the opposite — which is what made every surface read as
  // pressed rubber. The theme's language now takes its depth from
  // surface color and hairlines, so a raised surface carries ONE very
  // soft shadow and nothing else: the ramp below still orders six
  // levels, but no level plays a light-direction trick.
  "--neu-elevation-1": "0 1px 1px var(--neu-float-scrim)",
  "--neu-elevation-2": "0 1px 2px var(--neu-float-scrim)",
  "--neu-elevation-3": "0 2px 4px var(--neu-float-scrim)",
  "--neu-elevation-4": "0 2px 6px var(--neu-float-scrim)",
  "--neu-elevation-5": "0 4px 10px var(--neu-float-scrim)",
  "--neu-elevation-6": "0 6px 16px var(--neu-float-scrim)",
  "--neu-elevation-accent": "0 1px 2px var(--neu-float-scrim)",
  // elevation: inner (inset / pressed)
  //
  // A pressed field reads as a hairline, not as a dent carved by two
  // opposing lights.
  "--neu-inset-1": "inset 0 0 0 1px var(--neu-border)",
  "--neu-inset-2": "inset 0 0 0 1px var(--neu-border)",
  "--neu-inset-3": "inset 0 0 0 1px var(--neu-border)",
  "--neu-inset-accent": "inset 0 0 0 1px var(--neu-border)",
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
