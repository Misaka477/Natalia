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

/**
 * Every built-in tool name a model can call: the canonical names the real
 * registry accepts, plus the aliases the registry resolves to them.
 *
 * This list used to be a hand-kept guess, and it lied in both directions: it
 * advertised `plan` (merged into the todo tools in ff6d24df) and a `background_*`
 * family, while omitting the collab, context, goal, record, constitution,
 * generation, and work-graph tools entirely. The guard in
 * `tool-catalogue-runtime.test.ts` boots a real runtime and pins this list to
 * the registry it actually assembles, so a name that does not exist fails there
 * and a name that exists and is missing fails here.
 */
export function runtimeToolNames(): string[] {
  return [
    "agent_attach",
    "agent_audit",
    "agent_cleanup",
    "agent_detach",
    "agent_list",
    "agent_message",
    "agent_output",
    "agent_resume",
    "agent_retry",
    "agent_spawn",
    "agent_status",
    "agent_stop",
    "agent_wait",
    "apply_edits",
    "apply_generation",
    "cancel_generation",
    "list_generation_candidates",
    "ask_user",
    "browser_click",
    "browser_close",
    "browser_execute_js",
    "browser_input",
    "browser_navigate",
    "browser_open",
    "browser_scan",
    "browser_screenshot",
    "browser_tabs",
    "collab_ask",
    "collab_chat",
    "collab_inbox",
    "collab_respond",
    "constitution_propose_rule",
    "constitution_rule_read",
    "constitution_rule_revoke",
    "context_history",
    "context_list",
    "context_pack",
    "context_read",
    "context_recall",
    "context_search",
    "create_goal",
    "detour_declare",
    "drift_acknowledge",
    "edit_file",
    "get_goal",
    "glob",
    "grep",
    "image_read",
    "interactive_input",
    "interactive_keys",
    "interactive_last_command",
    "interactive_list",
    "interactive_cleanup",
    "interactive_read",
    "interactive_resize",
    "interactive_search",
    "interactive_send_line",
    "interactive_snapshot",
    "interactive_start",
    "interactive_stop",
    "interactive_write",
    "interactive_terminal_cleanup",
    "interactive_terminal_input",
    "interactive_terminal_keys",
    "interactive_terminal_last_command",
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
    "mailbox_acknowledge",
    "plan_doc_list",
    "plan_doc_read",
    "plan_doc_tick",
    "plan_pause",
    "plan_propose",
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
    "process_wait",
    "propose_generation",
    "read_file",
    "read_media_file",
    "record_completion",
    "record_decision",
    "record_validation",
    "rollback_generation",
    "run_shell",
    "sandbox_create",
    "sandbox_delete",
    "sandbox_list",
    "sandbox_diff",
    "sandbox_execute",
    "sandbox_merge",
    "sandbox_resource_list",
    "sandbox_resource_output",
    "sandbox_resource_start",
    "sandbox_resource_stop",
    "sandbox_rollback",
    "sandbox_write",
    "session_history",
    "skill_load",
    "team_fanout",
    "team_review",
    "terminal_observe",
    "todo_read",
    "todo_write",
    "update_goal",
    "web_fetch",
    "web_search",
    "work_contract_read",
    "work_graph_query",
    "write_file",
  ];
}
