/**
 * UI skin and layout profile protocol.
 *
 * The final goal is: writing one new skin file should be able to restyle the
 * whole UI, and a layout profile should be able to rearrange common shell
 * regions without touching component code.
 */

export type UiRegionId =
  | "top"
  | "left"
  | "main"
  | "right"
  | "bottom"
  | "settings";

export type UiRegionLayout = {
  visible?: boolean;
  position?: "left" | "right" | "top" | "bottom";
  width?: number;
  height?: number;
  /** Optional default tab/panel ids, in display order. */
  order?: string[];
  collapsed?: boolean;
};

export type UiLayoutProfile = {
  regions?: Partial<Record<UiRegionId, UiRegionLayout>>;
  /** Panel groups that may be grouped in a menu/drawer. */
  groups?: Record<string, { order?: string[]; collapsed?: boolean }>;
};

/**
 * A skin is the single source of truth for visual tokens.
 *
 * All component CSS should reference these CSS custom properties, so changing a
 * skin only changes variable values — no component or plugin code needs editing.
 */
export type UiSkin = {
  id: string;
  name: string;
  version?: string;
  /** CSS custom property name -> value. Example: "--neu-bg": "#121418". */
  tokens: Record<string, string>;
  /** Optional layout profile. A skin can also carry structural preferences. */
  layout?: UiLayoutProfile;
};

export function defineUiSkin(skin: UiSkin): UiSkin {
  return skin;
}

/**
 * Applies a skin to a root element by setting each token as a CSS custom
 * property. Also sets `data-theme` to the skin id so any CSS rules keyed on the
 * theme id keep working.
 */
export function applyUiSkin(
  skin: UiSkin,
  root: HTMLElement | undefined = typeof document !== "undefined"
    ? document.documentElement
    : undefined,
): void {
  if (!root) return;
  root.dataset.theme = skin.id;
  for (const [name, value] of Object.entries(skin.tokens)) {
    if (!name.startsWith("--")) continue;
    root.style.setProperty(name, value);
  }
}

/** Convenience for layout-only profiles that are not tied to a visual skin. */
export function defineUiLayoutProfile(
  profile: UiLayoutProfile,
): UiLayoutProfile {
  return profile;
}

/**
 * Third-layer protocol: a completely custom shell layout can be supplied as an
 * independent plugin. This is for scenarios that cannot be expressed through
 * `UiLayoutProfile` alone (new navigation model, nested panes, custom drawers,
 * etc.). The protocol is intentionally minimal today; concrete host integration
 * will follow.
 */
export type UiShellSlotId = "top" | "left" | "main" | "right" | "bottom";

export type UiShellSlots = {
  top?: HTMLElement;
  left?: HTMLElement;
  main?: HTMLElement;
  right?: HTMLElement;
  bottom?: HTMLElement;
};

export type UiShellLayoutContext = {
  root: HTMLElement;
  runtime: unknown;
  host: unknown;
  projection: unknown;
  events: unknown;
  slots: UiShellSlots;
};

export type UiShellLayoutPlugin = {
  id: string;
  name: string;
  version: string;
  description?: string;
  /**
   * Mounts the custom shell layout. It receives the shared runtime/host ports
   * and DOM slots that the main shell normally owns. Returning a dispose is
   * required for unload.
   */
  mount(
    context: UiShellLayoutContext,
  ): { dispose(): void | Promise<void> } | void;
};

export function defineUiShellLayoutPlugin(
  plugin: UiShellLayoutPlugin,
): UiShellLayoutPlugin {
  return plugin;
}
