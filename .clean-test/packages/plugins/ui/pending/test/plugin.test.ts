import { expect, test } from "bun:test";
import { createPendingUiPlugin } from "../src/ui/index";

test("pending plugin contributes the side panel and registers presenters on mount", () => {
  const plugin = createPendingUiPlugin();
  const panels = plugin.panels ?? [];
  expect(panels.map((panel) => panel.id)).toEqual(["pending"]);
  expect(panels[0]?.region).toBe("side");
  expect(typeof panels[0]?.mount).toBe("function");
});
