/**
 * The built-in tool families, as capabilities.
 *
 * Before this, the framework's 39 tools were a static array pushed straight into
 * the `ToolRegistry`: the kernel did not own them, `tool.registered` reported
 * every one of them as owned by `natalia-runtime`, and nothing could remove a
 * family because nothing had ever contributed it. Here each family from
 * the runtime default catalog is loaded as capabilities that contribute their
 * tools, so the built-ins are on exactly the same footing as an external plugin:
 *
 *   - the kernel refuses a contribution outside the `tools` grant;
 *   - `ownerOf("tools", name)` names the family that provides a tool;
 *   - unloading a family releases its tools, because the kernel owns them.
 *
 * The runtime still never names a tool: it asks for the families and moves what
 * the kernel accepted into the registry the executor reads.
 */
export {
  createToolRegistryFromCapabilities,
  registerToolFamilyCapabilities,
  toolFamilyCapabilityID,
  toolFamilyRegistration,
  type ToolFamilyLoadOutcome,
} from "./tool-family-registry";

/** Every built-in tool name, including the aliases a model may use. */
export function runtimeToolNames(): string[] {
  return [
    "ask_user",
    "plan",
    "todo_read",
    "todo_write",
    "glob",
    "grep",
    "read_file",
    "read_media_file",
    "image_read",
    "write_file",
    "edit_file",
    "apply_edits",
    "web_fetch",
    "web_search",
    "browser_screenshot",
    "browser_tabs",
    "browser_scan",
    "browser_open",
    "browser_close",
    "browser_execute_js",
    "browser_navigate",
    "browser_click",
    "browser_input",
    "run_shell",
    "agent_spawn",
    "agent_list",
    "agent_status",
    "agent_output",
    "agent_wait",
    "agent_stop",
    "agent_resume",
    "agent_retry",
    "agent_attach",
    "agent_detach",
    "agent_cleanup",
    "agent_audit",
    "interactive_terminal_start",
    "interactive_terminal_read",
    "interactive_terminal_search",
    "interactive_terminal_write",
    "interactive_terminal_send_line",
    "interactive_terminal_keys",
    "interactive_terminal_input",
    "interactive_terminal_snapshot",
    "interactive_terminal_resize",
    "interactive_terminal_request_human",
    "interactive_terminal_stop",
    "interactive_terminal_list",
    "terminal_observe",
    "interactive_start",
    "interactive_read",
    "interactive_search",
    "interactive_write",
    "interactive_send_line",
    "interactive_keys",
    "interactive_input",
    "interactive_snapshot",
    "interactive_resize",
    "interactive_stop",
    "interactive_list",
    "sandbox_create",
    "sandbox_execute",
    "sandbox_write",
    "sandbox_diff",
    "sandbox_merge",
    "sandbox_delete",
    "sandbox_resource_start",
    "sandbox_resource_list",
    "sandbox_resource_output",
    "sandbox_resource_stop",
    "process_start",
    "process_list",
    "process_status",
    "process_output",
    "process_ready",
    "process_stop",
    "process_restart",
    "process_attach",
    "process_detach",
    "process_cleanup",
    "process_audit",
    "background_start",
    "background_list",
    "background_output",
    "background_stop",
    "background_restart",
    "background_cleanup",
    "background_audit",
  ];
}
