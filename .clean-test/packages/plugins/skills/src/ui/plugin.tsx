import { render } from "solid-js/web";
import { defineUiPlugin, type UiPlugin } from "@natalia/ui-host";
import { SkillsSettings } from "./skills-settings";

export function createSkillsSettingsUiPlugin(): UiPlugin {
  return defineUiPlugin({
    id: "natalia.ui.skills-settings",
    name: "Skills Settings UI",
    version: "1.0.0",
    description: "Skill management for the settings panel.",
    panels: [
      {
        id: "skills-settings",
        title: "Skills",
        region: "settings",
        group: "扩展",
        mount(ctx, container) {
          container.replaceChildren();
          const dispose = render(
            () => <SkillsSettings runtime={ctx.runtime} events={ctx.events} />,
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
