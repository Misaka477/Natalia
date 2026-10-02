import type { RuntimeEvent } from "@anthelia/contracts";
import type {
  ProviderMessage,
  ProviderStreamRequest,
  StreamingProvider,
} from "@anthelia/runtime";
import { applyEvent, initialState, type AppState } from "@natalia/view-store";

export type E2EAgent = "main" | "navi" | "nia";

export type ScriptedToolResult = {
  toolCallID?: string;
  toolName?: string;
  content: string;
};

export type ScriptContext = {
  agent: E2EAgent;
  call: number;
  request: ProviderStreamRequest;
  toolResults: ScriptedToolResult[];
  latestToolResult?: ScriptedToolResult;
};

export type ScriptedToolCall = {
  id?: string;
  name: string;
  arguments: Record<string, unknown> | string;
};

export type ScriptStep = {
  /** Optional guard; the step is selected only when it returns true. */
  when?: (context: ScriptContext) => boolean;
  tool?:
    | ScriptedToolCall
    | ((context: ScriptContext) => ScriptedToolCall | undefined);
  text?: string | ((context: ScriptContext) => string);
};

export type Script = ScriptStep[];
export type Scripts = Partial<Record<E2EAgent, Script>>;

function toolNames(request: ProviderStreamRequest): Set<string> {
  return new Set((request.tools ?? []).map((tool) => tool.name));
}

/**
 * Routes a provider call to the agent that owns the visible tool surface. The
 * runtime uses one provider object for all channels; a deterministic E2E script
 * must not let a Nia wake consume the Main Agent's next step.
 */
export function detectAgent(request: ProviderStreamRequest): E2EAgent {
  const names = toolNames(request);
  if (
    names.has("record_decision") ||
    names.has("record_validation") ||
    names.has("record_completion")
  )
    return "main";
  if (names.has("audit_report")) return "nia";
  if (names.has("plan_propose")) return "navi";
  const system = request.messages
    .filter((message) => message.role === "system")
    .map((message) => message.content)
    .join("\n");
  if (system.includes("<nia_chat_persona>")) return "nia";
  if (system.includes("<navi_chat_persona>")) return "navi";
  return "main";
}

function readToolResults(request: ProviderStreamRequest): ScriptedToolResult[] {
  return request.messages
    .filter(
      (message): message is ProviderMessage & { role: "tool" } =>
        message.role === "tool",
    )
    .map((message) => ({
      ...(message.toolCallID ? { toolCallID: message.toolCallID } : {}),
      ...(message.toolName ? { toolName: message.toolName } : {}),
      content: String(message.content ?? ""),
    }));
}

/**
 * A scripted provider for deterministic end-to-end tests.
 *
 * Each agent has its own cursor, so a Nia audit wake cannot advance the Main
 * Agent's script and vice versa. Steps are selected in order; an optional
 * `when` guard may inspect the request/tool results when a step depends on a
 * prior RPC result.
 */
export function createScriptedProvider(scripts: Scripts): StreamingProvider {
  const cursors: Record<E2EAgent, number> = { main: 0, navi: 0, nia: 0 };
  const calls: Record<E2EAgent, number> = { main: 0, navi: 0, nia: 0 };

  return {
    provider: "e2e-scripted",
    model: "e2e-scripted-model",
    async *stream(request: ProviderStreamRequest) {
      const agent = detectAgent(request);
      const script = scripts[agent] ?? [];
      const toolResults = readToolResults(request);
      const latestToolResult = toolResults.at(-1);
      let stepIndex = cursors[agent] ?? 0;
      let step: ScriptStep | undefined;
      while (stepIndex < script.length) {
        const candidate = script[stepIndex]!;
        stepIndex += 1;
        if (!candidate.when) {
          step = candidate;
          break;
        }
        const context: ScriptContext = {
          agent,
          call: calls[agent] ?? 0,
          request,
          toolResults,
          ...(latestToolResult ? { latestToolResult } : {}),
        };
        if (candidate.when(context)) {
          step = candidate;
          break;
        }
      }
      cursors[agent] = stepIndex;
      calls[agent] = (calls[agent] ?? 0) + 1;

      if (!step) {
        yield { type: "content", text: `${agent} script complete` };
        yield { type: "done" };
        return;
      }

      const context: ScriptContext = {
        agent,
        call: calls[agent] ?? 0,
        request,
        toolResults,
        ...(latestToolResult ? { latestToolResult } : {}),
      };
      const tool =
        typeof step.tool === "function" ? step.tool(context) : step.tool;
      if (tool) {
        const id =
          tool.id ??
          `${agent}:call:${calls[agent] ?? 0}:${stepIndex.toString(36)}`;
        yield {
          type: "tool_call",
          calls: [
            {
              id,
              name: tool.name,
              arguments:
                typeof tool.arguments === "string"
                  ? tool.arguments
                  : JSON.stringify(tool.arguments),
            },
          ],
        };
        yield { type: "done" };
        return;
      }

      const text =
        typeof step.text === "function"
          ? step.text(context)
          : (step.text ?? `${agent} step complete`);
      yield { type: "content", text };
      yield { type: "done" };
    },
  };
}

/** Fold a runtime event stream through the same host projection third-party UI uses. */
export function reduceRuntimeEvents(events: RuntimeEvent[]): AppState {
  const state = initialState();
  for (const event of events) applyEvent(state, event);
  return state;
}

/** Poll an assertion condition without depending on wall-clock sleeps in tests. */
export async function waitFor(
  condition: () => boolean,
  input: { timeoutMs?: number; intervalMs?: number } = {},
): Promise<void> {
  // Cross-process durable conditions: 5s was a load lottery under the
  // concurrent suite (the 60s per-test cap is the real bound).
  const timeoutMs = input.timeoutMs ?? 20_000;
  const intervalMs = input.intervalMs ?? 10;
  const started = Date.now();
  while (!condition()) {
    if (Date.now() - started > timeoutMs)
      throw new Error("timed out waiting for E2E condition");
    await new Promise((resolve) => setTimeout(resolve, intervalMs));
  }
}

/** Small helper for tests that need the latest event of one type. */
export function lastEvent<T extends RuntimeEvent["type"]>(
  events: RuntimeEvent[],
  type: T,
): Extract<RuntimeEvent, { type: T }> | undefined {
  return events
    .filter(
      (event): event is Extract<RuntimeEvent, { type: T }> =>
        event.type === type,
    )
    .at(-1);
}
