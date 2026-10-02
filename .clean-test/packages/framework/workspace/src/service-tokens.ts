import type {
  MutationRegistry,
  WorkspaceFilesController,
  WorkspaceWriteLock,
} from "./contracts";
import { defineService } from "@anthelia/runtime-services";

/**
 * Workspace service tokens. Same shape as the engine's other mechanism
 * packages: typed faces over the wire names the runtime resolves, living in
 * the package that owns the mechanism.
 */
export const workspaceFiles = defineService<WorkspaceFilesController>(
  "workspace.files",
  { scope: "workspace", capability: "services" },
);

export const workspaceMutations = defineService<MutationRegistry>(
  "workspace.mutations",
  { scope: "workspace", capability: "services" },
);

export const workspaceWriteLock = defineService<WorkspaceWriteLock>(
  "workspace.writeLock",
  { scope: "workspace", capability: "services" },
);
