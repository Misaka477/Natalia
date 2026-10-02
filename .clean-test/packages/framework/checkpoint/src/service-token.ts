import type { CheckpointFactory } from "./contracts";
import { defineService } from "@anthelia/runtime-services";

/**
 * The checkpoint factory token; lives with the mechanism that implements it.
 */
export const checkpointFactory = defineService<CheckpointFactory>(
  "checkpoint.factory",
  { scope: "workspace", capability: "services" },
);
