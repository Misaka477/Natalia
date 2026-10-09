import { expect, test } from "bun:test";
import { createPendingUiPlugin } from "../src/ui/index";

test("the delisted pending plugin contributes no panel and no presenter", () => {
  // T4-4: the side tab is gone. Its job moved to the web plugin's composer
  // takeover, which owns the presenters now — two owners would throw in the
  // host. The entry stays so an install that still has the package loads and
  // disposes cleanly instead of failing on a missing ui entry; it just
  // contributes nothing.
  const plugin = createPendingUiPlugin();
  expect(plugin.panels ?? []).toEqual([]);
  const mounted = plugin.mount?.({} as never);
  expect(typeof mounted?.dispose).toBe("function");
  mounted?.dispose?.();
});
