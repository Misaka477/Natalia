import type { ProviderModelController } from "./contracts";
import { defineService } from "@anthelia/runtime-services";

/** The provider/model controller token; lives with the mechanism. */
export const providerModelController = defineService<ProviderModelController>(
  "provider-model.controller",
  { scope: "workspace", capability: "services" },
);
