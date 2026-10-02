import type { SessionID } from "@anthelia/contracts";
import type { RuntimeTool, ToolExecutionContext, ToolRegistry } from "./index";
import { validateToolParameters } from "./validate";

export type ToolInvocation = {
  sessionID: SessionID;
  agentID: string;
  assistantMessageID: string;
  toolCallID: string;
  name: string;
  arguments: unknown;
};

export type ToolSettlement =
  | { status: "succeeded"; output: string }
  | { status: "failed"; error: string }
  | { status: "stale"; error: string }
  | { status: "unknown"; error: string };

export type ToolMaterialization = {
  definitions: Array<Pick<RuntimeTool, "name" | "description" | "parameters">>;
  resolve(
    name: string,
  ):
    | { status: "ready"; tool: RuntimeTool }
    | { status: "stale"; error: string }
    | { status: "unknown"; error: string };
  settle(
    invocation: ToolInvocation,
    context: ToolExecutionContext,
  ): Promise<ToolSettlement>;
};

/** Captures tool identities for one provider turn and rejects stale calls. */
export function materializeTools(
  registry: ToolRegistry,
  selected: ReadonlyMap<string, RuntimeTool> = registry,
): ToolMaterialization {
  const entries = new Map(selected);
  return {
    definitions: [...entries.values()].map(
      ({ name, description, parameters }) => ({
        name,
        description,
        parameters,
      }),
    ),
    resolve(name) {
      const captured = entries.get(name);
      if (!captured)
        return { status: "unknown", error: `Unknown tool: ${name}` };
      if (registry.get(name) !== captured)
        return { status: "stale", error: `Stale tool call: ${name}` };
      return { status: "ready", tool: captured };
    },
    async settle(invocation, context) {
      const resolved = this.resolve(invocation.name);
      if (resolved.status !== "ready") return resolved;
      const captured = resolved.tool;
      const errors = validateToolParameters(
        captured.parameters,
        invocation.arguments,
      );
      if (errors.length) {
        const detail = errors
          .map((error) => `${error.path || "(root)"}: ${error.message}`)
          .join("; ");
        return { status: "failed", error: `Invalid tool input: ${detail}` };
      }
      try {
        return {
          status: "succeeded",
          output: await captured.execute(invocation.arguments, context),
        };
      } catch (error) {
        return {
          status: "failed",
          error: error instanceof Error ? error.message : String(error),
        };
      }
    },
  };
}
