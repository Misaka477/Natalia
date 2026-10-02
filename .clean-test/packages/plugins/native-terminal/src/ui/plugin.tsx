import { createSignal, onCleanup, onMount } from "solid-js";
import { render } from "solid-js/web";
import {
  defineUiPlugin,
  type UiPlugin,
  type UiPluginContext,
} from "@natalia/ui-host";
import { TerminalPane } from "./terminal-panel";

function TerminalPanelHost(props: { ctx: UiPluginContext }) {
  const [sessionID, setSessionID] = createSignal<string | undefined>(
    props.ctx.projection.getState().sessionID,
  );
  const extra = props.ctx.extra as
    | { runtimeURL?: string; token?: string }
    | undefined;

  onMount(() => {
    const update = () =>
      setSessionID(props.ctx.projection.getState().sessionID);
    const off = props.ctx.projection.subscribe(update);
    onCleanup(off);
  });

  return (
    <TerminalPane
      runtime={props.ctx.runtime}
      sessionID={sessionID()}
      runtimeURL={extra?.runtimeURL}
      token={extra?.token}
      active={true}
      events={props.ctx.events}
    />
  );
}

export function createTerminalUiPlugin(): UiPlugin {
  return defineUiPlugin({
    id: "natalia.ui.terminal",
    name: "Terminal UI",
    version: "1.0.0",
    description: "Interactive terminal panel.",
    panels: [
      {
        id: "terminal",
        title: "终端",
        region: "side",
        mount(ctx, container) {
          container.replaceChildren();
          const dispose = render(
            () => <TerminalPanelHost ctx={ctx} />,
            container,
          );
          return () => dispose();
        },
      },
    ],
    mount() {
      return undefined;
    },
  });
}
