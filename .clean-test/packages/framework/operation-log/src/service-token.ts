import { defineService } from "@anthelia/runtime-services";
import type { OperationLog } from "./index";

/**
 * The operation-log service (decisions §5: the runtime telemetry zone —
 * process-scoped, one per runtime instance, its own file and retention).
 */
export const operationLog = defineService<OperationLog>("operation.log", {
  scope: "process",
  capability: "services",
});
