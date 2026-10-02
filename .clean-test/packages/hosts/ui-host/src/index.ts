/**
 * Thin UI plugin host.
 *
 * Owns mount points, event fan-out, view-store projection, transport, and
 * plugin lifecycle. It does not render business panels — those live in a UI
 * plugin package. Runtime creation stays with the shell that calls this host.
 */
export { createUiEventBus, eventMatches } from "./events";
export { createUiPluginHost } from "./host";
export type { LoadedUiPlugin, UiPluginHost, UiPluginHostOptions } from "./host";
export { createConsoleLogger, createSilentLogger } from "./logger";
export { createMemoryPreferenceStore } from "./preferences";
export { defineUiPlugin } from "./protocol";
export type {
  Logger,
  PreferenceStore,
  TerminalHandle,
  TerminalOptions,
  UiCommandDefinition,
  UiEventBus,
  UiEventPattern,
  UiPanelDefinition,
  UiPlugin,
  UiPluginContext,
  UiPluginLifecycle,
  UiProjection,
  UiResources,
  UiTransport,
} from "./protocol";
export { createMemoryTransport, createWebTransport } from "./transport";
