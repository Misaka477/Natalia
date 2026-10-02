import { defineService } from "@anthelia/runtime-services";
import type { StatusSnapshotController } from "./status-controller";

/** The runtime status snapshot controller token; lives with the mechanism. */
export const statusSnapshotController = defineService<StatusSnapshotController>(
  "status.snapshot.controller",
  { scope: "workspace", capability: "services" },
);
