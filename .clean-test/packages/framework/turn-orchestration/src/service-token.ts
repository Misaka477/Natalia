import { defineService } from "@anthelia/runtime-services";
import type { TurnController } from "@anthelia/turn-orchestration";

/** The turn orchestration controller token; lives with the mechanism. */
export const turnController = defineService<TurnController>("turn.controller", {
  scope: "workspace",
  capability: "services",
});
