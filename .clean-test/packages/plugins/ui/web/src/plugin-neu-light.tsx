import { render } from "solid-js/web";
import { defineUiPlugin, type UiPlugin } from "@natalia/ui-host";
import { AppNeu } from "./app-neu";
import { EXAMPLE_WEB_UI_PANELS, EXAMPLE_WEB_UI_PLUGIN_ID } from "./identity";
import { applyNeuTheme, nataliaNeuStyles } from "./styles";

export function createNataliaNeuLightPlugin(): UiPlugin {
  let unmount: (() => void) | undefined;
  return defineUiPlugin({
    id: EXAMPLE_WEB_UI_PLUGIN_ID + "-neu-light",
    name: "Natalia Web UI (Neumorphism Light)",
    version: "1.0.0",
    description:
      "Light Neumorphism UI prototype for Natalia dual-agent workspace",
    events: ["runtime.*"],
    panels: EXAMPLE_WEB_UI_PANELS,
    mount(ctx) {
      ctx.root.replaceChildren();
      applyNeuTheme(ctx.preferences.get<string>("themeMode"), ctx.root);
      const style = document.createElement("style");
      style.textContent = nataliaNeuStyles;
      ctx.root.append(style);
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

export default createNataliaNeuLightPlugin();
