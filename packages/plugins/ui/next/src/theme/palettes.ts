/**
 * Color palettes (配色包) — the single source of truth for every color value
 * the shell renders. One palette per color scheme (light / dark); a theme
 * pack references a palette, and switching the palette never touches the
 * theme's shape tokens.
 *
 * The light palette defines the semantic slot set: every other palette is
 * checked complete against it, so a missing or extra slot is a compile
 * error (the same discipline the reference harness uses for its locale
 * dictionaries).
 */

export const PALETTE_MODES = ["light", "dark"] as const;
export type PaletteMode = (typeof PALETTE_MODES)[number];

/** One color scheme: semantic slot name to CSS color value. */
export const lightPalette = {
  // surfaces
  "--neu-bg": "#e8e9e1",
  "--neu-bg-light": "#f2f3ed",
  "--neu-bg-dark": "#1b1e24",
  "--neu-assistant-bubble": "#f2f3ed",
  "--neu-user-bubble": "#b9d5cf",
  "--neu-user-bubble-border": "#b9d5cf",
  "--neu-user-bubble-text": "#16201d",
  // text
  "--neu-text": "#30302e",
  "--neu-text-dim": "#5c625f",
  "--neu-muted": "#7d8885",
  // accent and semantic states
  "--neu-accent": "#8fb7b0",
  "--neu-accent-soft": "rgba(143, 183, 176, 0.2)",
  // The accent's own shadow color: the neumorphic pair for an
  // accent-raised control, mixed from the accent so a palette swap
  // re-colors it. The shipped sheet defines it beside the accent.
  "--neu-accent-shadow":
    "color-mix(in srgb, var(--neu-accent) 35%, transparent)",
  "--neu-success": "#6ba89f",
  "--neu-error": "#c9776b",
  "--neu-warning": "#b79549",
  "--neu-thinking": "#8fb7b0",
  // lines and overlays
  "--neu-border": "rgba(48, 48, 46, 0.12)",
  "--neu-hairline": "rgba(0, 0, 0, 0.06)",
  "--neu-divider": "rgba(48, 48, 46, 0.12)",
  "--neu-overlay": "rgba(0, 0, 0, 0.25)",
  "--neu-overlay-scrim": "rgba(20, 22, 20, 0.35)",
  "--neu-hover-overlay": "rgba(48, 48, 46, 0.06)",
  // elevation pair (neumorphic light and shadow colors)
  "--neu-shadow-dark": "rgba(48, 48, 46, 0.18)",
  "--neu-shadow-light": "rgba(255, 255, 255, 0.7)",
  // code surfaces and syntax
  "--neu-code-bg": "#eef0ea",
  "--neu-code-border": "rgba(48, 48, 46, 0.14)",
  "--neu-code-text": "#2a7ab0",
  "--neu-code-keyword": "#b85e9c",
  "--neu-code-string": "#2e8b57",
  "--neu-code-number": "#b06e2c",
  "--neu-code-function": "#2a7ab0",
  "--neu-code-class": "#7a4bb5",
  "--neu-code-property": "#2a7ab0",
  // on-colors and inset effects
  "--neu-on-accent": "#1c211f",
  "--neu-on-error": "#ffffff",
  "--neu-thumb": "#ffffff",
  "--neu-thumb-shadow": "0 1px 3px rgba(0, 0, 0, 0.25)",
  "--neu-badge-inset": "inset 1px 1px 2px rgba(0, 0, 0, 0.1)",
  "--neu-inset-pressed-dark": "rgba(0, 0, 0, 0.18)",
  "--neu-inset-pressed-light": "rgba(255, 255, 255, 0.35)",
  // raised / sunken surfaces (panels that hardcoded translucent fills)
  "--neu-surface-raised": "rgba(48, 48, 46, 0.04)",
  "--neu-surface-raised-strong": "rgba(48, 48, 46, 0.08)",
  "--neu-surface-sunken": "rgba(48, 48, 46, 0.03)",
  "--neu-border-strong": "rgba(48, 48, 46, 0.18)",
  // state surfaces: information (accent-tinted)
  "--neu-state-info-bg": "rgba(120, 160, 255, 0.12)",
  "--neu-state-info-border": "rgba(120, 160, 255, 0.3)",
  "--neu-state-info-text": "#2f5fb0",
  // state surfaces: warning (amber)
  "--neu-state-warn-bg": "rgba(230, 180, 90, 0.16)",
  "--neu-state-warn-border": "rgba(230, 180, 90, 0.32)",
  "--neu-state-warn-text": "#8a6410",
  // state surfaces: danger (red)
  "--neu-state-danger-bg": "rgba(220, 90, 90, 0.14)",
  "--neu-state-danger-border": "rgba(220, 90, 90, 0.3)",
  "--neu-state-danger-text": "#a33a3a",
  // state surfaces: ok (green)
  "--neu-state-ok-bg": "rgba(46, 160, 67, 0.14)",
  "--neu-state-ok-border": "rgba(46, 160, 67, 0.4)",
  "--neu-state-ok-text": "#1f6b2e",
  // floating editor surface (goal editor and friends)
  "--neu-float-surface": "#f2f3ed",
  "--neu-float-scrim": "rgba(20, 22, 20, 0.35)",
} as const satisfies Record<string, string>;

export type PaletteSlot = keyof typeof lightPalette;
export type PaletteTokens = Record<PaletteSlot, string>;

export const darkPalette = {
  "--neu-bg": "#1e1e20",
  "--neu-bg-light": "#28282b",
  "--neu-bg-dark": "#151517",
  "--neu-assistant-bubble": "#2c2c30",
  "--neu-user-bubble": "#3b6ea5",
  "--neu-user-bubble-border": "#5b8fc0",
  "--neu-user-bubble-text": "#e1e1e6",
  "--neu-text": "#e1e1e6",
  "--neu-text-dim": "#a6a6b0",
  "--neu-muted": "#8c8c96",
  "--neu-accent": "#6cb6ff",
  "--neu-accent-soft": "rgba(108, 182, 255, 0.16)",
  // The accent's own shadow color, mixed from the accent so a palette
  // swap re-colors it. Present in both palettes: the shape tokens
  // reference it from the neumorphic pair.
  "--neu-accent-shadow":
    "color-mix(in srgb, var(--neu-accent) 35%, transparent)",
  "--neu-success": "#7ee787",
  "--neu-error": "#e06c75",
  "--neu-warning": "#d2a8ff",
  "--neu-thinking": "#d2a8ff",
  "--neu-border": "#3a3a3e",
  "--neu-hairline": "rgba(225, 225, 230, 0.08)",
  "--neu-divider": "rgba(225, 225, 230, 0.1)",
  "--neu-overlay": "rgba(0, 0, 0, 0.5)",
  "--neu-overlay-scrim": "rgba(0, 0, 0, 0.55)",
  "--neu-hover-overlay": "rgba(255, 255, 255, 0.04)",
  "--neu-shadow-dark": "rgba(0, 0, 0, 0.5)",
  "--neu-shadow-light": "rgba(255, 255, 255, 0.05)",
  "--neu-code-bg": "#34343c",
  "--neu-code-border": "#4a4a54",
  "--neu-code-text": "#6cb6ff",
  "--neu-code-keyword": "#d2a8ff",
  "--neu-code-string": "#7ee787",
  "--neu-code-number": "#d2a8ff",
  "--neu-code-function": "#6cb6ff",
  "--neu-code-class": "#f778ba",
  "--neu-code-property": "#6cb6ff",
  "--neu-on-accent": "#10141c",
  "--neu-on-error": "#ffffff",
  "--neu-thumb": "#ffffff",
  "--neu-thumb-shadow": "0 1px 3px rgba(0, 0, 0, 0.45)",
  "--neu-badge-inset": "inset 1px 1px 2px rgba(0, 0, 0, 0.25)",
  "--neu-inset-pressed-dark": "rgba(0, 0, 0, 0.35)",
  "--neu-inset-pressed-light": "rgba(255, 255, 255, 0.12)",
  "--neu-surface-raised": "rgba(255, 255, 255, 0.04)",
  "--neu-surface-raised-strong": "rgba(255, 255, 255, 0.08)",
  "--neu-surface-sunken": "rgba(255, 255, 255, 0.03)",
  "--neu-border-strong": "rgba(255, 255, 255, 0.14)",
  "--neu-state-info-bg": "rgba(120, 160, 255, 0.12)",
  "--neu-state-info-border": "rgba(120, 160, 255, 0.3)",
  "--neu-state-info-text": "#a9c2ff",
  "--neu-state-warn-bg": "rgba(230, 180, 90, 0.16)",
  "--neu-state-warn-border": "rgba(230, 180, 90, 0.32)",
  "--neu-state-warn-text": "#e6b45a",
  "--neu-state-danger-bg": "rgba(220, 90, 90, 0.14)",
  "--neu-state-danger-border": "rgba(220, 90, 90, 0.3)",
  "--neu-state-danger-text": "#e6a0a0",
  "--neu-state-ok-bg": "rgba(46, 160, 67, 0.16)",
  "--neu-state-ok-border": "rgba(46, 160, 67, 0.45)",
  "--neu-state-ok-text": "#3fb950",
  "--neu-float-surface": "#0b0d12",
  "--neu-float-scrim": "rgba(0, 0, 0, 0.45)",
} as const satisfies PaletteTokens;

/** Every color scheme the shell can switch between. */
export const PALETTES: Record<PaletteMode, PaletteTokens> = {
  light: lightPalette,
  dark: darkPalette,
};

/** Document background painted before first script run, per color scheme. */
export const PALETTE_BOOT_BG: Record<PaletteMode, string> = {
  light: lightPalette["--neu-bg"],
  dark: darkPalette["--neu-bg"],
};
