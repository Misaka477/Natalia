/**
 * The plugin surface: the family it ships, the tools it registers, and
 * the manifest the release build validates against.
 *
 * The native half is covered by desktop.test.ts (Windows, against the real
 * desktop) and pure.test.ts (everywhere, without one). This file is the
 * seam between them.
 */
import { afterEach, expect, test } from "bun:test";
import { createPluginRegistry } from "@anthelia/plugin";
import { createToolRegistry } from "@anthelia/tools";
import {
  COMPUTER_USE_PLUGIN_ID,
  COMPUTER_USE_PLUGIN_MANIFEST,
  computerUseToolFamily,
  computerUseTools,
  createComputerUsePlugin,
} from "../src";

afterEach(async () => {
  // Nothing to tear down: the family holds no native state until a tool
  // runs, and the tools that ran release their GDI objects themselves.
});

test("the family describes the tools it ships", () => {
  const family = computerUseToolFamily();
  expect(family.id).toBe("computer-use");
  expect(family.scope).toBe("session");
  expect(family.tools).toEqual(computerUseTools);
  expect(computerUseTools.map((tool) => tool.name)).toEqual([
    "computer_windows",
    "computer_screenshot",
    "computer_click",
    "computer_type",
    "computer_key",
    "computer_activate",
  ]);
});

test("only the read-only probe runs without approval", () => {
  // Everything else acts on the user's real desktop, so a human is asked
  // first; the enumeration is a read, and asking about it would train the
  // user to click through the dialogs that matter.
  for (const tool of computerUseTools)
    expect(tool.requiresApproval).toBe(tool.name !== "computer_windows");
});

test("every tool declares a timeout the runtime can enforce", () => {
  for (const tool of computerUseTools) {
    expect(tool.timeoutSec).toBeGreaterThan(0);
    expect(tool.timeoutSec).toBeLessThanOrEqual(60);
  }
});

test("the plugin owns its tools and unloads cleanly", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(createComputerUsePlugin());
  expect(registry.list()[0]).toMatchObject({
    id: COMPUTER_USE_PLUGIN_ID,
    scope: "session",
  });
  for (const tool of computerUseTools) expect(tools.has(tool.name)).toBe(true);
  await registry.unload(COMPUTER_USE_PLUGIN_ID);
  for (const tool of computerUseTools) expect(tools.has(tool.name)).toBe(false);
});

test("setup touches no native library", async () => {
  // The plugin loads on a platform that cannot drive a desktop: the
  // libraries open on the first tool call, so a missing one refuses there
  // instead of failing the load and taking the runtime's tool set with it.
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(createComputerUsePlugin());
  await registry.unload(COMPUTER_USE_PLUGIN_ID);
});

test("the manifest declares the skills directory it ships", () => {
  expect(COMPUTER_USE_PLUGIN_MANIFEST.skills).toEqual({ dir: "skills" });
  // The installer compares the built entry's exported manifest against the
  // package manifest byte for byte, so the two declarations cannot drift.
  expect(COMPUTER_USE_PLUGIN_MANIFEST.entry).toBe("index.js");
  expect(COMPUTER_USE_PLUGIN_MANIFEST.integrationPoints).toEqual(["tools"]);
});

test("the screenshot tool's contract teaches the client-origin rule", () => {
  // The one mistake that turns a correct click into a miss by exactly the
  // height of a title bar: the description is the contract, so the rule is
  // in the words, the way browser_scan's paging is.
  const screenshot = computerUseTools.find(
    (tool) => tool.name === "computer_screenshot",
  )!;
  expect(screenshot.description).toContain("CLIENT AREA");
  expect(screenshot.description).toContain("client origin");
  const click = computerUseTools.find(
    (tool) => tool.name === "computer_click",
  )!;
  expect(click.description).toContain("physical screen coordinates");
  expect(click.description).toContain("client origin");
});
