/**
 * Framework subsystem composition — initialize/framework-provider-model.ts.
 *
 * Provider/model selection and the main agent loop are framework-internal
 * subsystems, not a plugin: this module constructs the controller directly and
 * contributes it as the `provider-model.controller` service plus the
 * `/models` and `/model` commands. The controller reads live host state through
 * the runtime ports, so it needs no recreation on config reload.
 */
import {
  createProviderModelController,
  providerModelController,
} from "@anthelia/provider-model";
import type { PluginCommandInvocation } from "@anthelia/plugin";
import type { SessionID } from "@anthelia/contracts";
import type { ProviderModelController } from "@anthelia/provider-model";
import type { RuntimeContext } from "@anthelia/substrate";

export type ProviderModelHandle = { close(): void };

export function wireProviderModel(ctx: RuntimeContext): ProviderModelHandle {
  const registry = ctx.state.capabilityRegistry;
  const deps = ctx.state.initialize;
  const input = deps.providerModelPluginInput();
  const owner = registry.registerOwner({
    id: "natalia-provider-model",
    name: "Provider Model",
    version: "1.0.0",
    scope: "workspace",
    grants: ["services", "commands"],
  });
  const controller: ProviderModelController =
    createProviderModelController(input);
  // The controller binds through the service directory; the owner stays for
  // the commands contribution below.
  ctx.state.serviceDirectory.provide(providerModelController, controller);
  owner.contribute("commands", "models", {
    name: "models",
    title: "List models",
    async run() {
      const models = await input.commands.catalog();
      return models.length
        ? models
            .map(
              (model) =>
                `${model.id}: ${model.name} @ ${model.provider}${model.variants.length ? ` (${model.variants.join(", ")})` : ""}`,
            )
            .join("\n")
        : "no selectable models configured";
    },
  });
  owner.contribute("commands", "model", {
    name: "model",
    title: "Select model",
    async run(invocation: PluginCommandInvocation) {
      const [modelID, variant] = invocation?.args ?? [];
      if (!modelID) throw new Error("model ID is required");
      if (!invocation?.sessionID)
        throw new Error("model selection requires a session");
      await input.commands.select(
        invocation.sessionID as SessionID,
        modelID,
        variant,
      );
      return `selected model ${modelID}${variant ? ` (${variant})` : ""}`;
    },
  });
  return {
    close() {
      void controller.dispose();
    },
  };
}
