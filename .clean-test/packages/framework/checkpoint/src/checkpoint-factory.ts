import { join } from "node:path";
import type { SessionID } from "@anthelia/contracts";
import type { CheckpointFactory } from "./contracts";
import type { CheckpointControllerAccessors } from "./contracts";
import type { CheckpointController } from "./contracts";
import { createCheckpointController } from "./checkpoint-controller";

/**
 * The checkpoint subsystem factory — framework-internal, not a plugin.
 *
 * Owns one checkpoint controller per session, so repeated accessor
 * construction for the same session returns the same controller and its
 * store/rollback policy state is preserved across calls.
 */
export function createCheckpointFactory(input: {
  workspaceRoot: string;
  checkpointDir?: string;
}): CheckpointFactory & { close(): void } {
  const controllers = new Map<SessionID, CheckpointController>();
  return Object.assign(
    (accessors: CheckpointControllerAccessors): CheckpointController => {
      const sessionID = accessors.sessionID();
      const existing = controllers.get(sessionID);
      if (existing) return existing;
      const controller = createCheckpointController({
        workspaceRoot: input.workspaceRoot,
        storeDir: input.checkpointDir
          ? join(input.checkpointDir, sessionID)
          : undefined,
        ...accessors,
      });
      controllers.set(sessionID, controller);
      return controller;
    },
    {
      close() {
        controllers.clear();
      },
    },
  );
}
