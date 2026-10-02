export type ToolPolicy = {
  allow?: string[];
  exclude?: string[];
};

export type ToolHookEvent = {
  turnID: string;
  toolName: string;
  toolCallID: string;
  arguments: string;
};

export type ToolHookResult = {
  allowed: boolean;
  diagnostics: string[];
  clearTerminal?: boolean;
};

export type ToolHooks = {
  preExecute?: (
    event: ToolHookEvent,
  ) => ToolHookResult | Promise<ToolHookResult>;
  postExecute?: (
    event: ToolHookEvent & { result?: string; error?: string },
  ) => void | Promise<void>;
};

export type ToolPolicyHookLayer = {
  isToolAllowed(toolName: string): boolean;
  filterTools<T extends { name: string }>(tools: T[]): T[];
  preExecute(event: ToolHookEvent): Promise<ToolHookResult>;
  postExecute(
    event: ToolHookEvent & { result?: string; error?: string },
  ): Promise<void>;
};

export function createToolPolicyHookLayer(
  policy?: ToolPolicy,
  hooks?: ToolHooks,
): ToolPolicyHookLayer {
  const allowPatterns = compilePatterns(policy?.allow);
  const excludePatterns = compilePatterns(policy?.exclude);

  function isToolAllowed(toolName: string): boolean {
    if (
      allowPatterns.length > 0 &&
      !allowPatterns.some((pattern) => pattern.test(toolName))
    )
      return false;
    return !excludePatterns.some((pattern) => pattern.test(toolName));
  }

  return {
    isToolAllowed,
    filterTools: (tools) => tools.filter((tool) => isToolAllowed(tool.name)),
    async preExecute(event) {
      const diagnostics: string[] = [];
      if (!isToolAllowed(event.toolName)) {
        diagnostics.push(`blocked by policy: ${event.toolName}`);
        return { allowed: false, diagnostics };
      }
      const result = await hooks?.preExecute?.(event);
      if (result) {
        diagnostics.push(...result.diagnostics);
        if (!result.allowed)
          return {
            allowed: false,
            diagnostics,
            clearTerminal: result.clearTerminal,
          };
      }
      return { allowed: true, diagnostics };
    },
    async postExecute(event) {
      await hooks?.postExecute?.(event);
    },
  };
}

function compilePatterns(patterns?: string[]): RegExp[] {
  if (!patterns?.length) return [];
  return patterns.map((pattern) => {
    const escaped = pattern
      .replace(/[.*+?^${}()|[\]\\]/gu, "\\$&")
      .replace(/\\\*/gu, ".*");
    return new RegExp(`^${escaped}$`, "u");
  });
}
