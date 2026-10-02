/**
 * WG4 Phase 3: the expected-mutation registry (§56.9).
 *
 * "工具开始时由 mutation registry 注册 expected mutation，至少包含 sessionID、
 * episodeID、turnID、callID、operation identity、授权路径范围和预期操作类型；
 * 工具成功后将实际变化与该记录匹配。"
 *
 * A tool call that may change the workspace registers what it is about to do
 * BEFORE running: the turn/call identity, the authorized path scope and the
 * expected operation. When the watcher later produces a hint for a path, the
 * auditor asks the registry whether any expected mutation covers it. A hit
 * gives the confirmed change a reliable identity (turnID+callID or operationID)
 * and an `origin`; a miss stays unattributed external/unknown.
 *
 * The registry is the secret-safe bridge between "the filesystem changed" and
 * "who changed it": it correlates paths and operations only — no file content,
 * no command text, no tool arguments or results ever enter it.
 */
import type { WorkspaceOperation } from "@anthelia/contracts";
import type { ExpectedMutation, MutationRegistry } from "./contracts";

export function createMutationRegistry(): MutationRegistry {
  const expected = new Map<string, ExpectedMutation>();

  /**
   * Register an expected mutation before the tool runs. The key is the call or
   * operation identity, so a settle can find it back.
   */
  function register(input: {
    sessionID?: string;
    episodeID?: string;
    turnID?: string;
    callID?: string;
    operationID?: string;
    toolName: string;
    authorizedPaths: string[];
    expectedOperations: WorkspaceOperation[];
  }): string {
    const key = input.callID ?? input.operationID;
    if (!key)
      throw new Error("expected mutation requires callID or operationID");
    expected.set(key, { ...input, settled: false });
    return key;
  }

  /**
   * Match a hint against the open (unsettled) expected mutations. Returns the
   * correlated identity when an authorized path within scope and an expected
   * operation both line up; undefined otherwise.
   */
  function match(input: { path: string; operation: WorkspaceOperation }):
    | {
        turnID?: string;
        callID?: string;
        operationID?: string;
        sessionID?: string;
        episodeID?: string;
        toolName: string;
      }
    | undefined {
    for (const mutation of expected.values()) {
      if (mutation.settled) continue;
      if (!mutation.expectedOperations.includes(input.operation)) continue;
      const inScope = mutation.authorizedPaths.some(
        (scope) =>
          scope === "." ||
          scope === "" ||
          input.path === scope ||
          input.path.startsWith(`${scope}/`),
      );
      if (!inScope) continue;
      return {
        turnID: mutation.turnID,
        callID: mutation.callID,
        operationID: mutation.operationID,
        sessionID: mutation.sessionID,
        episodeID: mutation.episodeID,
        toolName: mutation.toolName,
      };
    }
    return undefined;
  }

  /**
   * Mark a call/operation settled after success. The record stops matching
   * (later unrelated hints are not attributed to it) but keeps its identity so
   * attribution of the change it caused remains possible.
   */
  function settle(key: string) {
    const mutation = expected.get(key);
    if (mutation) mutation.settled = true;
  }

  /** Forget an expected mutation that never ran or was cancelled. */
  function forget(key: string) {
    expected.delete(key);
  }

  function pendingCount() {
    return [...expected.values()].filter((mutation) => !mutation.settled)
      .length;
  }

  return { register, match, settle, forget, pendingCount };
}
