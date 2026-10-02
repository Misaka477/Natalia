import { expect, test } from "bun:test";
import {
  EXAMPLE_WEB_UI_PANELS,
  EXAMPLE_WEB_UI_PLUGIN_ID,
} from "../src/identity";
import { mergeDiscoveredModels } from "./model-panel-helpers";

test("the example web UI plugin contributes Main and Chat panels", () => {
  expect(EXAMPLE_WEB_UI_PLUGIN_ID).toBe("natalia.ui.web.example");
  expect(EXAMPLE_WEB_UI_PANELS.map((panel) => panel.id)).toEqual([
    "main",
    "chat",
  ]);
  expect(EXAMPLE_WEB_UI_PANELS.map((panel) => panel.title)).toEqual([
    "Main",
    "Chat",
  ]);
});

test("discovered models replace the list and preserve configured capabilities", () => {
  expect(
    mergeDiscoveredModels(
      [
        {
          id: "configured",
          name: "Configured name",
          reasoning: false,
          image: true,
        },
        {
          id: "obsolete",
          name: "Obsolete",
          reasoning: false,
          image: true,
        },
      ],
      ["zeta", "configured", "alpha", "zeta", "  alpha  "],
    ),
  ).toEqual([
    {
      id: "alpha",
      name: "alpha",
      reasoning: true,
      image: false,
    },
    {
      id: "configured",
      name: "Configured name",
      reasoning: false,
      image: true,
    },
    {
      id: "zeta",
      name: "zeta",
      reasoning: true,
      image: false,
    },
  ]);
});
