/**
 * Tool catalog publishing — runtime/tool-publish.ts.
 *
 * Publishes the capability and tool catalog facts to the event stream, and
 * hot-reloads one out-of-tree tool family through the local-tools plugin.
 * Reads host state through `RuntimeContext` at call time.
 */
import { localToolsReload } from "@anthelia/runtime-services";
import { workLedgerController as workLedgerControllerToken } from "@natalia/work-ledger";
import type { ToolFamily } from "@anthelia/tools";
import type { RuntimeContext } from "@anthelia/substrate";
import type { RealRuntimeClientOptions } from "@anthelia/substrate";
import type { WorkLedgerController } from "@natalia/work-ledger";

export function createToolPublish(
  ctx: RuntimeContext,
  options: RealRuntimeClientOptions,
) {
  /**
   * Capabilities published by the previous call, so publishing stays a sync
   * rather than an append.
   *
   * Publishing only `loaded` made the stream additive: a consumer accumulates
   * capabilities and never hears about one going away, so a reload that drops a
   * family left it on screen.
   *
   * Declared before the `return` below on purpose — a `let` placed after it
   * would never be initialised, since the function returns first, and every
   * later read would land in the temporal dead zone.
   */
  let publishedCapabilities = new Map<string, string>();

  return {
    publishRuntimeCapabilities,
    hotReloadToolFamily,
    publishRegisteredTools,
    publishToolCatalogChanges,
    publishWorkGraphToolCall,
  };

  function publishRuntimeCapabilities() {
    const { publish, getCapabilityRegistry } = ctx.ports;
    const present = new Map<string, string>();
    for (const record of getCapabilityRegistry().list()) {
      const id = `cap:${record.id}`;
      present.set(id, record.name);
      publish({
        type: "capability.loaded",
        id,
        apiVersion: 1,
        name: record.name,
        version: record.version,
        scope: record.scope,
        grants: record.grants,
      });
    }
    for (const [id, name] of publishedCapabilities)
      if (!present.has(id)) publish({ type: "capability.unloaded", id, name });
    publishedCapabilities = present;
  }

  async function hotReloadToolFamily(familyID: string) {
    const { publish, getTools, getTsRuntimeConfig, getCapabilityRegistry } =
      ctx.ports;
    const tools = getTools();
    if (options.tools || !getTsRuntimeConfig())
      throw new Error("tool family reload is not available");
    // The local-tools plugin owns the family lifecycle; the host only asks it
    // to swap the family and then reports what changed in the tool catalog.
    const reload = ctx.state.serviceDirectory.getOptional(localToolsReload);
    if (!reload)
      throw new Error(
        "local tool families are not loaded (natalia-local-tools)",
      );
    const before = new Set(tools.keys());
    await reload(familyID);
    // Publish what changed so the projected tool catalog stays honest.
    for (const name of before) {
      if (tools.has(name)) continue;
      publish({ type: "tool.unregistered", id: `tool:${name}`, name });
    }
    for (const name of [...tools.keys()]) {
      if (before.has(name)) continue;
      const owner = getCapabilityRegistry().ownerOf("tools", name);
      publish({
        type: "tool.registered",
        id: `tool:${name}`,
        name,
        owner: owner ?? "natalia-runtime",
        scope: (owner && getCapabilityRegistry().scopeOf(owner)) || "session",
        recovery: "fail_closed",
        precedence: 0,
        requiresApproval: tools.get(name)?.requiresApproval ?? false,
      });
    }
    return { reloaded: true };
  }

  function publishRegisteredTools() {
    const { publish, getTools, getCapabilityRegistry } = ctx.ports;
    for (const tool of getTools().values()) {
      const owner = getCapabilityRegistry().ownerOf("tools", tool.name);
      publish({
        type: "tool.registered",
        id: `tool:${tool.name}`,
        name: tool.name,
        owner: owner ?? "natalia-runtime",
        scope: (owner && getCapabilityRegistry().scopeOf(owner)) || "session",
        recovery: "fail_closed",
        precedence: 0,
        requiresApproval: tool.requiresApproval,
      });
    }
  }

  function publishToolCatalogChanges(before: Set<string>) {
    const { publish, getTools, getCapabilityRegistry } = ctx.ports;
    const tools = getTools();
    for (const name of before)
      if (!tools.has(name))
        publish({ type: "tool.unregistered", id: `tool:${name}`, name });
    for (const tool of tools.values()) {
      if (before.has(tool.name)) continue;
      const owner = getCapabilityRegistry().ownerOf("tools", tool.name);
      publish({
        type: "tool.registered",
        id: `tool:${tool.name}`,
        name: tool.name,
        owner: owner ?? "natalia-runtime",
        scope: (owner && getCapabilityRegistry().scopeOf(owner)) || "session",
        recovery: "fail_closed",
        precedence: 0,
        requiresApproval: tool.requiresApproval,
      });
    }
  }

  /**
   * Records a settled tool call in the Work Graph, with the edge to the turn that
   * caused it. Only settled calls: an in-flight call is not yet a fact. The tool
   * name and status are recorded, never arguments or output.
   */
  function publishWorkGraphToolCall(
    turnID: string,
    callID: string,
    toolName: string,
    status: string,
  ) {
    const { executionForTurn, publishForSession } = ctx.ports;
    const workLedgerController = ctx.state.serviceDirectory.get(
      workLedgerControllerToken,
    );
    const exec = executionForTurn(turnID);
    if (!exec) throw new Error(`no execution state for turn ${turnID}`);
    const ownerSessionID = exec.session.id;
    publishForSession(
      exec,
      workLedgerController.toolCallNode({
        turnID,
        callID,
        toolName,
        status,
        sessionID: ownerSessionID,
      }),
    );
    publishForSession(
      exec,
      workLedgerController.toolCallEdge({ turnID, callID }),
    );
  }
}
