import { expect, test } from "bun:test";
import { CapabilityRegistry } from "@anthelia/capability";
import { createToolRegistryFromCapabilities } from "../src/capabilities/tool-family-capabilities";

/**
 * The static assembly now contributes nothing: every built-in tool family loads
 * through the built-in plugin catalog. These tests pin that the static path is
 * empty, so a migrated tool can never be re-registered behind the plugin's back.
 */
function builtinTools() {
  return createToolRegistryFromCapabilities({
    registry: new CapabilityRegistry(),
  }).tools;
}

test("migrated plugin tools are absent from the static tool assembly", () => {
  expect(builtinTools().has("ask_user")).toBe(false);
  expect(builtinTools().has("todo_read")).toBe(false);
  expect(builtinTools().has("glob")).toBe(false);
  expect(builtinTools().has("grep")).toBe(false);
  expect(builtinTools().has("read_file")).toBe(false);
  expect(builtinTools().has("write_file")).toBe(false);
  expect(builtinTools().has("edit_file")).toBe(false);
  expect(builtinTools().has("image_read")).toBe(false);
  expect(builtinTools().has("apply_edits")).toBe(false);
  expect(builtinTools().has("web_fetch")).toBe(false);
  expect(builtinTools().has("web_search")).toBe(false);
  expect(builtinTools().has("browser_visit")).toBe(false);
  expect(builtinTools().has("browser_screenshot")).toBe(false);
  expect(builtinTools().has("run_shell")).toBe(false);
  expect(builtinTools().has("agent_spawn")).toBe(false);
  expect(builtinTools().has("interactive_terminal_start")).toBe(false);
  expect(builtinTools().has("sandbox_create")).toBe(false);
  expect(builtinTools().has("process_start")).toBe(false);
  expect(builtinTools().has("background_start")).toBe(false);
});
