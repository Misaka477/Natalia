/** A stable, UI-facing description of what a session approval grants. */
export type PermissionFamily = {
  id: string;
  label: string;
  description: string;
  scope: string;
  sessionAction: string;
};

const FAMILIES = {
  filesystemRead: {
    id: "filesystem-read",
    label: "Filesystem reads",
    description: "Read and search files and media in the workspace.",
    scope: "All filesystem read and search tools in this session",
    sessionAction: "Allow reads for session",
  },
  filesystemWrite: {
    id: "filesystem-write",
    label: "Filesystem writes",
    description: "Create, edit, patch, move, or remove workspace files.",
    scope: "All filesystem write tools in this session",
    sessionAction: "Allow writes for session",
  },
  shell: {
    id: "shell",
    label: "Shell commands",
    description: "Run non-interactive shell commands.",
    scope: "All shell command tools in this session",
    sessionAction: "Allow shell for session",
  },
  interactiveTerminal: {
    id: "interactive-terminal",
    label: "Interactive terminal",
    description: "Open, observe, control, and stop interactive terminals.",
    scope: "All interactive terminal operations in this session",
    sessionAction: "Allow terminal for session",
  },
  managedProcess: {
    id: "managed-process",
    label: "Managed processes",
    description:
      "Start, inspect, restart, and stop managed background processes.",
    scope: "All managed process tools in this session",
    sessionAction: "Allow processes for session",
  },
  network: {
    id: "network",
    label: "Network access",
    description:
      "Access remote network resources, including web and browser tools.",
    scope: "All built-in network tools in this session",
    sessionAction: "Allow network for session",
  },
  agent: {
    id: "agent",
    label: "Agent delegation",
    description: "Start and coordinate agents or delegated work.",
    scope: "All agent delegation tools in this session",
    sessionAction: "Allow agents for session",
  },
  externalIntegration: {
    id: "external-integration",
    label: "External integrations",
    description: "Use connected MCP servers and external integrations.",
    scope: "All external integration tools in this session",
    sessionAction: "Allow integrations for session",
  },
  sandbox: {
    id: "sandbox",
    label: "Workspace sandboxes",
    description:
      "Create, modify, execute, merge, and remove isolated sandboxes.",
    scope: "All workspace sandbox tools in this session",
    sessionAction: "Allow sandboxes for session",
  },
  planning: {
    id: "planning",
    label: "Planning updates",
    description: "Create and update the durable execution plan and todo list.",
    scope: "All planning and todo update tools in this session",
    sessionAction: "Allow planning for session",
  },
  skills: {
    id: "skills",
    label: "Local skills",
    description: "Load and use discovered local skills.",
    scope: "All local skill tools in this session",
    sessionAction: "Allow skills for session",
  },
} as const satisfies Record<string, PermissionFamily>;

for (const family of Object.values(FAMILIES)) Object.freeze(family);
export const PERMISSION_FAMILIES = Object.freeze(FAMILIES);

const FILESYSTEM_READ_NAMES = new Set([
  "read_file",
  "read_media_file",
  "image_read",
  "glob",
  "grep",
  "file_read",
  "media_read",
  "read_image",
  "list_files",
  "search_files",
  "read",
  "list",
  "search",
  "list_directory",
]);
const FILESYSTEM_WRITE_NAMES = new Set([
  "write_file",
  "edit_file",
  "apply_edits",
  "file_write",
  "file_edit",
  "patch_file",
  "delete_file",
  "remove_file",
  "move_file",
  "rename_file",
  "write",
  "edit",
  "create",
  "delete",
]);

/**
 * Classifies an approval by safety boundary rather than package inventory.
 * Unknown capability and plugin owners intentionally remain exact-tool scoped.
 */
export function classifyPermissionFamily(
  toolName: string,
  capabilityOwner?: string,
): PermissionFamily {
  const name = toolName.toLowerCase();
  if (name === "terminal_observe" || name.startsWith("interactive_terminal_"))
    return copyFamily(FAMILIES.interactiveTerminal);
  if (FILESYSTEM_READ_NAMES.has(name))
    return copyFamily(FAMILIES.filesystemRead);
  if (FILESYSTEM_WRITE_NAMES.has(name))
    return copyFamily(FAMILIES.filesystemWrite);
  if (name === "run_shell" || name === "shell" || name.startsWith("shell_"))
    return copyFamily(FAMILIES.shell);
  if (
    name.startsWith("process_") ||
    name.startsWith("managed_process_") ||
    name.startsWith("background_")
  )
    return copyFamily(FAMILIES.managedProcess);
  if (
    name.startsWith("web_") ||
    name.startsWith("browser_") ||
    name === "webfetch" ||
    name === "fetch_url"
  )
    return copyFamily(FAMILIES.network);
  if (name.startsWith("agent_") || name.startsWith("team_"))
    return copyFamily(FAMILIES.agent);
  if (name.startsWith("sandbox_")) return copyFamily(FAMILIES.sandbox);
  if (name === "plan" || name.startsWith("todo_"))
    return copyFamily(FAMILIES.planning);
  if (name.startsWith("skill_")) return copyFamily(FAMILIES.skills);
  if (
    name.startsWith("mcp_") ||
    name.startsWith("external_") ||
    name.startsWith("integration_")
  )
    return copyFamily(FAMILIES.externalIntegration);

  switch (capabilityOwner) {
    case "natalia-tool-search":
      return copyFamily(FAMILIES.filesystemRead);
    case "natalia-tool-shell":
      return copyFamily(FAMILIES.shell);
    case "natalia-tool-terminal":
      return copyFamily(FAMILIES.interactiveTerminal);
    case "natalia-tool-process":
      return copyFamily(FAMILIES.managedProcess);
    case "natalia-tool-web":
      return copyFamily(FAMILIES.network);
    case "natalia-subagents":
      return copyFamily(FAMILIES.agent);
    case "natalia-sandbox":
      return copyFamily(FAMILIES.sandbox);
    case "natalia-tool-todo":
      return copyFamily(FAMILIES.planning);
  }

  return {
    id: `tool:${toolName}`,
    label: toolName,
    description: `Use the ${toolName} tool.`,
    scope: `Only ${toolName} in this session`,
    sessionAction: `Allow ${toolName} for session`,
  };
}

function copyFamily(family: PermissionFamily): PermissionFamily {
  return { ...family };
}
