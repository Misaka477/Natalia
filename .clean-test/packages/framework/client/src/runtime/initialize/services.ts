import type {
  InitializeOptions,
  RuntimeContext,
  SessionID,
  StatusSnapshotController,
  TurnController,
} from "@anthelia/substrate";
import type {
  ContextLedgerFactory,
  GovernanceLedgerController,
  WorkLedgerController,
} from "@natalia/collab";
import { createInitializeRuntime } from "./runtime";

import { statusSnapshotController } from "@anthelia/runtime-status";
import { attachmentService as attachmentServiceToken } from "@anthelia/attachments";
import { retryService } from "@anthelia/retry";
import { governanceLedgerController } from "@natalia/governance-ledger";
import { compactionService } from "@anthelia/compaction";
import { contextLedgerFactory } from "@natalia/context-ledger";
import { turnController } from "@anthelia/turn-orchestration";
import { workLedgerController } from "@natalia/work-ledger";
import { sessionStoreController } from "@anthelia/session-store";
import type {
  AttachmentService,
  CompactionService,
  RetryService,
} from "@anthelia/runtime";

export async function resolveServices(
  ctx: RuntimeContext,
  options: InitializeOptions,
) {
  const scope = createInitializeRuntime(ctx);
  // Resolution is fail-fast by construction (see the retry check above).
  scope.serviceDirectory.get(attachmentServiceToken);
  // Resolution is fail-fast by construction: a missing binding throws with the
  // service id instead of being re-worded at every call site.
  scope.serviceDirectory.get(retryService);
  // Resolution is fail-fast by construction (see the retry check above).
  const resolvedContextLedgerFactory =
    scope.serviceDirectory.get(contextLedgerFactory);
  // Resolution is fail-fast by construction (see the retry check above).
  scope.serviceDirectory.get(compactionService);
  // Resolution is fail-fast by construction (see the retry check above).
  scope.serviceDirectory.get(statusSnapshotController);
  scope.runtimeContext = resolvedContextLedgerFactory.create();
  // Resolution is fail-fast by construction (see the retry check above).
  scope.serviceDirectory.get(workLedgerController);
  // Resolution is fail-fast by construction (see the retry check above).
  scope.serviceDirectory.get(governanceLedgerController);
  // Resolution is fail-fast by construction (see the retry check above).
  scope.serviceDirectory.get(turnController);
  scope.sessionID =
    options.sessionID ??
    (`ses_${scope.sessionSeed(scope.workspaceRoot)}` as SessionID);
  const sessionStore = scope.serviceDirectory.get(sessionStoreController);
  await sessionStore.init();
  // T-2: the sandboxed sub-agent path. A sub-agent spawned with
  // `mode: "sandbox"` gets its own sandbox worktree — its file scope.tools operate
  // in that worktree, not the parent's workspace — and the turn loop is
  // otherwise the same (same strength, reduced authority via the tool
  // domain). It is a new path; the shared-context loop below stays untouched.
  // The concurrent fan-out cap (`team.maxConcurrent`) is enforced here, at
  // the work itself, not at the spawn call.
}
