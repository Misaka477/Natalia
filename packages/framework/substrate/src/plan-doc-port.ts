/**
 * The plan-doc port contract (P3 substrate extraction): the ENGINE owns
 * port shapes; the product's `createPlanDocRuntime` satisfies this
 * structurally at the assignment site. `plan-doc-runtime` re-exports it,
 * so its callers did not change — and the shape now lives where the
 * port lives, not under runtime/collaboration.
 */
import type { RuntimeServiceClient } from "@anthelia/runtime-services";

export type PlanDocRuntime = {
  planDocList(sessionID?: string): Promise<
    Array<{
      planID: string;
      title: string;
      documentPath: string;
      status: string;
      createdBy: "user" | "live_chat" | "main_agent";
      createdAt: string;
      updatedAt: string;
      revision: number;
      markedAt?: string;
      /**
       * The status this plan had before it was paused, so a resume returns
       * the plan's OWN state (the 2026-10-08 audit's P0-3: a pause round
       * trip used to land every plan on `executing`).
       */
      statusBeforePause?: string;
    }>
  >;
  planDocRead(input: {
    planID?: string;
    path?: string;
    sessionID?: string;
  }): Promise<{
    planID?: string;
    title?: string;
    documentPath: string;
    content: string;
  }>;
  planDocWrite(input: {
    path: string;
    content: string;
    title?: string;
    planID?: string;
    sessionID?: string;
  }): Promise<{ written: boolean; planID?: string }>;
  planDocMark(input: {
    path: string;
    title?: string;
    /** Who marked the plan (EI §8.1); defaults to `user`. */
    createdBy?: "user" | "live_chat" | "main_agent";
    sessionID?: string;
  }): Promise<{ marked: boolean; planID: string }>;
  planDocDelete(
    planID: string,
    sessionID?: string,
  ): Promise<{ deleted: boolean }>;
  planDocStatus(
    planID: string,
    sessionID?: string,
  ): Promise<{ status: string }>;
  planDocUpdateStatus(input: {
    planID: string;
    status: string;
    sessionID?: string;
  }): Promise<{ updated: boolean; reason?: string }>;
  /**
   * Pause/resume that keeps the plan's OWN status. A pause records the
   * status the plan had before it (in the index, beside the plan) and a
   * resume returns that status — so `audit_gaps` pauses and resumes as
   * `audit_gaps`, never as the hardcoded `executing` the 2026-10-08 audit
   * caught (P0-3: a round trip used to lose the caller's state).
   */
  planDocPause(input: {
    planID: string;
    paused: boolean;
    sessionID?: string;
  }): Promise<{
    updated: boolean;
    status?: string;
    previousStatus?: string;
    reason?: string;
  }>;
  /** Workspace-level plan registry snapshot for synchronous prompt building. */
  planDocSnapshot(): PlanDocRecord[];
  /** Workspace-level lookup by planID. */
  planDocByID(planID: string): PlanDocRecord | undefined;
  /** Session-scoped active plan pointer. */
  planDocActive(sessionID?: string): Promise<{ planID?: string }>;
  planDocActivate(
    planID: string,
    sessionID?: string,
  ): Promise<{ planID?: string; updated: boolean }>;
  planDocDeactivate(
    sessionID?: string,
  ): Promise<{ planID?: string; updated: boolean }>;
};

export type PlanDocRecord = Awaited<
  ReturnType<NonNullable<RuntimeServiceClient["planDocList"]>>
>[number];
