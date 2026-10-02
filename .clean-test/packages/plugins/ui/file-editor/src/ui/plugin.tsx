import { render } from "solid-js/web";
import { defineUiPlugin, type UiPlugin } from "@natalia/ui-host";
import { FileEditor } from "../file-editor";
import { fileEditorStyles } from "../styles";

export function createFileEditorPlugin(): UiPlugin {
  return defineUiPlugin({
    id: "natalia.ui.file-editor",
    name: "File Editor",
    version: "1.0.0",
    description: "Optional file tree and CodeMirror editor panel.",
    panels: [
      {
        id: "files",
        title: "文件",
        region: "side",
        requiresCapabilities: [
          "workspace.list",
          "workspace.read",
          "workspace.write",
        ],
        mount(ctx, container) {
          if (!document.querySelector("style[data-natalia-file-editor]")) {
            const style = document.createElement("style");
            style.setAttribute("data-natalia-file-editor", "true");
            style.textContent = fileEditorStyles;
            document.head.append(style);
          }
          container.replaceChildren();
          const disposeRender = render(
            () => (
              <FileEditor
                transport={ctx.transport}
                runtime={ctx.runtime}
                projection={ctx.projection}
              />
            ),
            container,
          );
          return () => disposeRender();
        },
      },
    ],
    mount() {
      return undefined;
    },
  });
}
