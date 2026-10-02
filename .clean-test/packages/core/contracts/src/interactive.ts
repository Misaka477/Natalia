/**
 * Interactive protocol types shared between the runtime and any UI.
 *
 * These belong to contracts (the kernel's shared-contract layer), not to a UI
 * package, so the kernel never depends on a host: `@natalia/ui-model` imports
 * them from here rather than the reverse (audit A-03, contracts -> ui-model).
 */

export type ApprovalDecision = "once" | "session" | "project" | "reject";

export type ApprovalRequest = {
  id: string;
  title: string;
  preview: string;
  detail?: string;
  keyArguments?: string[];
  sensitive?: boolean;
  risk?: "terminal_low" | "terminal_high";
  scope?: string;
  expiresAt?: string;
  revocable?: boolean;
  /** False hides the session-wide grant action for forced approvals. */
  allowSession?: boolean;
  /** False hides the project-wide grant action for forced approvals. */
  allowProject?: boolean;
};

export type ApprovalResponse = {
  requestID: string;
  decision: ApprovalDecision;
  feedback?: string;
  /** Optional routing hints for multi-workspace clients. */
  sessionID?: string;
  workspaceID?: string;
};

export type QuestionOption = {
  label: string;
  description?: string;
};

export type QuestionItem = {
  id: string;
  header: string;
  question: string;
  options: QuestionOption[];
  multiple?: boolean;
  custom?: boolean;
};

export type QuestionRequest = {
  id: string;
  title: string;
  questions: QuestionItem[];
};

export type QuestionResponse = {
  requestID: string;
  answers: string[][];
  rejected?: boolean;
  /** Optional routing hints for multi-workspace clients. */
  sessionID?: string;
  workspaceID?: string;
};
