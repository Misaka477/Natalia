import type { ToolPolicyService } from "@anthelia/runtime-services";
import { defineService } from "@anthelia/runtime-services";

/** The tool policy service token; lives with the mechanism. */
export const toolPolicy = defineService<ToolPolicyService>("tool.policy", {
  scope: "workspace",
  capability: "services",
});
