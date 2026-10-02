import type { RuntimeEvent } from "@anthelia/contracts";
import { definePlugin } from "@anthelia/plugin";

export const EXAMPLE_UI_ADAPTER = "ui.example";

export function createExampleUiPlugin(
  write: (line: string) => void = (line) => process.stdout.write(`${line}\n`),
) {
  let unsubscribe: (() => void) | undefined;
  return definePlugin({
    manifest: {
      apiVersion: 2,
      id: "natalia-ui-example",
      version: "1.0.0",
      name: "Example UI",
      description: "Minimal line-oriented UI adapter example.",
      entry: "src/index.ts",
      scope: "process",
      provides: [],
      requires: [],
      optionalRequires: [],
      conflicts: [],
      dependencies: [],
      hooks: {},
      integrationPoints: ["adapters"],
    },
    setup(api) {
      api.adapters.registerUi({
        kind: EXAMPLE_UI_ADAPTER,
        async mount(input) {
          const commands = await input.commands.list();
          write(`ready commands=${commands.length}`);
          unsubscribe = input.events.subscribe((event: RuntimeEvent) =>
            write(`event ${event.type}`),
          );
        },
        dispose() {
          unsubscribe?.();
          unsubscribe = undefined;
          write("stopped");
        },
      });
    },
  });
}

export default createExampleUiPlugin();
