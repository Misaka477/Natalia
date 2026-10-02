import { render } from "solid-js/web";
import { defineUiPlugin, type UiPlugin } from "@natalia/ui-host";
import { AppNeu } from "./app-neu";
import { EXAMPLE_WEB_UI_PANELS, EXAMPLE_WEB_UI_PLUGIN_ID } from "./identity";
import { applyNeuTheme, nataliaNeuStyles } from "./styles";

export function createNataliaNeuPlugin(): UiPlugin {
  let unmount: (() => void) | undefined;
  return defineUiPlugin({
    id: EXAMPLE_WEB_UI_PLUGIN_ID + "-neu",
    name: "Natalia Web UI (Neumorphism)",
    version: "1.0.0",
    description: "Neumorphism UI prototype for Natalia dual-agent workspace",
    events: ["runtime.*"],
    panels: EXAMPLE_WEB_UI_PANELS,
    mount(ctx) {
      ctx.root.replaceChildren();
      applyNeuTheme(ctx.preferences.get<string>("themeMode"), ctx.root);
      const style = document.createElement("style");
      style.textContent = nataliaNeuStyles;
      ctx.root.append(style);

      const shellEntry = ctx.host
        ?.loaded()
        .find((entry) => (entry as { shellLayout?: unknown }).shellLayout);
      const shellLayout = shellEntry as
        | {
            shellLayout?: {
              mount(input: {
                root: HTMLElement;
                runtime: unknown;
                host: unknown;
                projection: unknown;
                events: unknown;
                slots: Record<string, HTMLElement | undefined>;
              }): { dispose?(): unknown } | void;
            };
          }
        | undefined;
      if (shellLayout?.shellLayout) {
        const layout = shellLayout.shellLayout.mount({
          root: ctx.root,
          runtime: ctx.runtime,
          host: ctx.host,
          projection: ctx.projection,
          events: ctx.events,
          slots: {},
        });
        const disposeLayout =
          layout && typeof layout === "object" && "dispose" in layout
            ? () => void (layout as { dispose(): unknown }).dispose()
            : undefined;
        unmount = () => {
          disposeLayout?.();
          ctx.root.replaceChildren();
          unmount = undefined;
        };
        return { dispose: () => unmount?.() };
      }

      const mountPoint = document.createElement("div");
      mountPoint.style.height = "100%";
      mountPoint.style.width = "100%";
      ctx.root.append(mountPoint);
      const disposeRender = render(() => <AppNeu ctx={ctx} />, mountPoint);
      unmount = () => {
        disposeRender();
        ctx.root.replaceChildren();
        unmount = undefined;
      };
      return { dispose: () => unmount?.() };
    },
    unmount() {
      unmount?.();
    },
  });
}

export default createNataliaNeuPlugin();
