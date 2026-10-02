import { expect, test } from "bun:test";
import { CapabilityRegistry } from "@anthelia/capability";
import {
  runtimeToolNames,
  createToolRegistryFromCapabilities,
} from "../src/capabilities/tool-family-capabilities";

/** The catalogue the host actually assembles, through the kernel. */
function builtinRegistry() {
  return createToolRegistryFromCapabilities({
    registry: new CapabilityRegistry(),
  }).tools;
}

/**
 * The public built-in tool catalogue, pinned.
 *
 * It lives with the host because the host composes it: the families come from
 * `@anthelia/tools`, separately packaged families and built-in plugins, and only
 * the assembled result is the surface a model sees.
 *
 * This is a policy surface, not an inventory: a tool that quietly disappears
 * changes what the model can do, a name that changes breaks every transcript and
 * permission rule that referenced it, and an approval flag that flips changes what
 * runs without asking a human first. All three are easy to do by accident while
 * moving code between files, and none of them fail any behavioural test — the
 * remaining tests here exercise tools they name explicitly, so a dropped tool is
 * invisible to them.
 *
 * Adding a tool is expected to fail this test. Update the list deliberately, and
 * state the approval boundary you chose.
 */
const catalogue: Array<
  [name: string, requiresApproval: boolean, timeoutSec?: number]
> = [
  ["agent_attach", false],
  ["agent_audit", false],
  ["agent_cleanup", true],
  ["agent_detach", false],
  ["agent_list", false],
  ["agent_output", false],
  ["agent_resume", false],
  ["agent_retry", true],
  ["agent_spawn", true],
  ["agent_status", false],
  ["agent_stop", true],
  ["agent_wait", false],
  ["apply_edits", true],
  ["background_audit", false],
  ["background_cleanup", true],
  ["background_list", false],
  ["background_output", false],
  ["background_restart", true],
  ["background_start", true],
  ["background_stop", true],
  ["browser_screenshot", true, 60],
  ["browser_tabs", false, 10],
  ["browser_scan", false, 20],
  ["browser_open", true, 20],
  ["browser_close", true, 20],
  ["browser_execute_js", true, 30],
  ["browser_navigate", true, 20],
  ["browser_click", true, 20],
  ["browser_input", true, 20],
  ["ask_user", false],
  ["edit_file", true],
  ["glob", false],
  ["grep", false],
  ["interactive_terminal_input", true],
  ["interactive_terminal_keys", true],
  ["interactive_terminal_list", false],
  ["interactive_terminal_read", false],
  ["interactive_terminal_request_human", false],
  ["interactive_terminal_resize", false],
  ["interactive_terminal_search", false],
  ["interactive_terminal_send_line", true],
  ["interactive_terminal_snapshot", false],
  ["interactive_terminal_start", true],
  ["interactive_terminal_stop", true],
  ["interactive_terminal_write", true],
  ["plan", false],
  ["process_attach", false],
  ["process_audit", false],
  ["process_cleanup", true],
  ["process_detach", false],
  ["process_list", false],
  ["process_output", false],
  ["process_ready", false],
  ["process_restart", true],
  ["process_start", true],
  ["process_status", false],
  ["process_stop", true],
  ["read_file", false],
  ["read_media_file", false],
  ["image_read", false],
  ["run_shell", true, 120],
  ["sandbox_create", true],
  ["sandbox_delete", true],
  ["sandbox_diff", false],
  ["sandbox_execute", true],
  ["sandbox_merge", true],
  ["sandbox_resource_list", false],
  ["sandbox_resource_output", false],
  ["sandbox_resource_start", true],
  ["sandbox_resource_stop", true],
  ["sandbox_write", true],
  ["terminal_observe", false, 35],
  ["todo_read", false],
  ["todo_write", false],
  ["web_fetch", false, 30],
  ["web_search", false, 30],
  ["write_file", true],
];

const migratedPluginTools = new Set([
  "agent_attach",
  "agent_audit",
  "agent_cleanup",
  "agent_detach",
  "agent_list",
  "agent_output",
  "agent_resume",
  "agent_retry",
  "agent_spawn",
  "agent_status",
  "agent_stop",
  "agent_wait",
  "apply_edits",
  "ask_user",
  "background_audit",
  "background_cleanup",
  "background_list",
  "background_output",
  "background_restart",
  "background_start",
  "background_stop",
  "browser_screenshot",
  "browser_tabs",
  "browser_scan",
  "browser_open",
  "browser_close",
  "browser_execute_js",
  "browser_navigate",
  "browser_click",
  "browser_input",
  "edit_file",
  "glob",
  "grep",
  "image_read",
  "interactive_input",
  "interactive_keys",
  "interactive_list",
  "interactive_read",
  "interactive_resize",
  "interactive_search",
  "interactive_send_line",
  "interactive_snapshot",
  "interactive_start",
  "interactive_stop",
  "interactive_terminal_input",
  "interactive_terminal_keys",
  "interactive_terminal_list",
  "interactive_terminal_read",
  "interactive_terminal_request_human",
  "interactive_terminal_resize",
  "interactive_terminal_search",
  "interactive_terminal_send_line",
  "interactive_terminal_snapshot",
  "interactive_terminal_start",
  "interactive_terminal_stop",
  "interactive_terminal_write",
  "interactive_write",
  "plan",
  "process_attach",
  "process_audit",
  "process_cleanup",
  "process_detach",
  "process_list",
  "process_output",
  "process_ready",
  "process_restart",
  "process_start",
  "process_status",
  "process_stop",
  "read_file",
  "read_media_file",
  "run_shell",
  "sandbox_create",
  "sandbox_delete",
  "sandbox_diff",
  "sandbox_execute",
  "sandbox_merge",
  "sandbox_resource_list",
  "sandbox_resource_output",
  "sandbox_resource_start",
  "sandbox_resource_stop",
  "sandbox_write",
  "terminal_observe",
  "todo_read",
  "todo_write",
  "web_fetch",
  "web_search",
  "write_file",
]);

test("the public tool catalogue retains migrated plugin tool names", () => {
  for (const name of migratedPluginTools)
    expect(runtimeToolNames()).toContain(name);
});

test("the static tool catalogue contains only unmigrated tools", () => {
  const registry = builtinRegistry();
  const actual = [...registry.entries()]
    .map(
      ([name, tool]) =>
        [name, tool.requiresApproval, tool.timeoutSec] as [
          string,
          boolean,
          number | undefined,
        ],
    )
    .sort((left, right) => left[0].localeCompare(right[0]));
  const expected = catalogue
    .filter(([name]) => !migratedPluginTools.has(name))
    .map(
      ([name, requiresApproval, timeoutSec]) =>
        [name, requiresApproval, timeoutSec] as [
          string,
          boolean,
          number | undefined,
        ],
    )
    .sort((left, right) => left[0].localeCompare(right[0]));
  expect(actual).toEqual(expected);
});
