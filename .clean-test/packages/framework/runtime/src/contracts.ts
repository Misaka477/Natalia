import type { LocalAttachment } from "@anthelia/contracts";
import type { SessionRecord } from "@anthelia/session";
import type {
  RetryAttemptContext,
  RetryContext,
  RetryRunnerOptions,
} from "./index";

export interface RetryService {
  policy(): RetryRunnerOptions["policy"];
  run<T>(
    context: RetryContext,
    fn: (attempt: RetryAttemptContext) => Promise<T>,
    options?: Omit<RetryRunnerOptions, "policy">,
  ): Promise<T>;
}

export interface CompactionService {
  compactBeforeProviderStep(input: any): Promise<any>;
  runWithContextLimitRecovery(input: any): Promise<any>;
  /** Identity-free prune -> remeasure -> decide -> summarize preflight. */
  prepareContextRequest(input: any): Promise<any>;
}

export type AttachmentService = {
  store(paths: string[]): Promise<LocalAttachment[]>;
  storeBytes(input: {
    name: string;
    mediaType: string;
    data: Uint8Array;
  }): Promise<LocalAttachment>;
  dataURL(attachment: LocalAttachment): Promise<string>;
  text(attachment: LocalAttachment): Promise<string>;
  isText(attachment: LocalAttachment): boolean;
  cleanup(attachments: LocalAttachment[]): Promise<string[]>;
  referencedForSessions(sessions: SessionRecord[]): LocalAttachment[];
};

export type ProviderUsage = {
  inputTokens: number;
  outputTokens: number;
  /** Anthropic cache metrics (ADR E): prefix written / prefix reused. */
  cacheCreationInputTokens?: number;
  cacheReadInputTokens?: number;
};
