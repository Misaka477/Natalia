import { expect, test } from "bun:test";
import { removableSource, sourceLabel } from "../src/ui/skills-settings";

/**
 * The panel's delete affordance: the workspace owns project and user
 * skills; a plugin's skill ships with the plugin and a remote one is
 * pulled into a cache. Offering a delete for those is offering a refusal —
 * a button that can only ever fail trains people to click through
 * refusals, and the official skills are exactly the ones a stray click
 * must not cost.
 */

test("only workspace-owned sources are removable", () => {
  expect(removableSource("project")).toBe(true);
  expect(removableSource("user")).toBe(true);
  expect(removableSource("plugin")).toBe(false);
  expect(removableSource("remote")).toBe(false);
});

test("the badge names the source in the user's words", () => {
  expect(sourceLabel("plugin")).toBe("插件内置");
  expect(sourceLabel("remote")).toBe("远程索引");
  // An unknown source passes through rather than inventing a label.
  expect(sourceLabel("something-new")).toBe("something-new");
});
