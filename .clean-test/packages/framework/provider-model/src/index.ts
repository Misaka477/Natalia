export * from "./contracts";
export { providerModelController } from "./service-token";
export { createProviderModelController } from "./provider-model-controller";
export type { ProviderRunnerInput } from "@anthelia/runtime-services";

export {
  createProviderRunner,
  estimateProviderMessages,
} from "./provider-runner";

// Engine facade (decisions §1.1: policy talks engine API, never the host
// layer): model-capability resolution is provider machinery whose pure
// implementation lives with the config stack; the engine re-exports it so
// policy packages (@natalia/collab today) never import @anthelia/config.
export { resolveEffectiveModel } from "@anthelia/config";
