import type {
  ConfirmedWorkspaceChange,
  WorkspaceOperation,
} from "@anthelia/contracts";

/**
 * Workspace mechanism contracts. They moved here from runtime-services as the
 * token migration completed: the package that implements the mechanism now
 * also declares its face, and the runtime-services pile keeps only the
 * cross-boundary contracts.
 */

export type ExpectedMutation = {
  sessionID?: string;
  episodeID?: string;
  turnID?: string;
  callID?: string;
  operationID?: string;
  toolName: string;
  authorizedPaths: string[];
  expectedOperations: WorkspaceOperation[];
  settled: boolean;
};

export type WorkspaceWriteActivity = {
  sessionID?: string;
  paths: string[];
  acquiredAt: number;
  queuedAt: number;
  active: boolean;
};

export interface WorkspaceWriteLock {
  acquire(sessionID?: string, paths?: string[]): Promise<() => void>;
  snapshot(): WorkspaceWriteActivity[];
}

export interface WorkspaceFilesController {
  init(): Promise<void>;
  close(): void;
  reconcile(): Promise<ConfirmedWorkspaceChange[]>;
  observationStatus(): unknown;
  auditor: unknown;
}

export interface MutationRegistry {
  register(input: Omit<ExpectedMutation, "settled">): string;
  match(input: { path: string; operation: WorkspaceOperation }):
    | {
        turnID?: string;
        callID?: string;
        operationID?: string;
        sessionID?: string;
        episodeID?: string;
        toolName: string;
      }
    | undefined;
  settle(key: string): void;
  forget(key: string): void;
  pendingCount(): number;
}
