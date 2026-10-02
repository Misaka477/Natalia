import type {
  LocalAttachment,
  PromptAgentMention,
  PromptResourceMention,
  SessionID,
} from "@anthelia/contracts";
import type { AdmittedSessionInput, SessionRecord } from "@anthelia/session";

/** Turn orchestration contracts, moved from runtime-services with the token. */

export interface TurnController {
  drain(signal: AbortSignal, sessionID: string): Promise<void>;
  drainQueue(signal: AbortSignal | undefined, sessionID: string): Promise<void>;
  admit(
    sessionID: string,
    id: string,
    text: string,
    attachments?: LocalAttachment[],
    resources?: PromptResourceMention[],
    agents?: PromptAgentMention[],
    internal?: boolean,
    signal?: AbortSignal,
  ): Promise<void>;
  persistPromotion(sessionID?: string): Promise<void>;
  /** Removes a not-yet-promoted inbox input. Returns the removed input. */
  removeInput(
    sessionID: string,
    id: string,
  ): Promise<AdmittedSessionInput | undefined>;
  /** Replaces the text of a not-yet-promoted inbox input. */
  replaceInput(
    sessionID: string,
    id: string,
    text: string,
  ): Promise<AdmittedSessionInput | undefined>;
  /** Promotes a queued `next-turn` input to `next-step` in place. */
  promoteInput(
    sessionID: string,
    id: string,
  ): Promise<AdmittedSessionInput | undefined>;
  dispose(): void;
}

export type TurnControllerInput = {
  session(): SessionRecord | undefined;
  activeAbort(): AbortController | undefined;
  sessionFor(sessionID: string): SessionRecord | undefined;
  activeAbortFor(sessionID: string): AbortController | undefined;
  persist(fn: () => Promise<void>): Promise<void>;
  saveInbox(snapshot: SessionRecord): Promise<void>;
  /**
   * The durable inbox as it stands on disk — the claim authority. A second
   * live client over the same session carries its own in-memory record,
   * so a claim marked only there is invisible here and the turn would run
   * twice. Optional so the bare unit controllers keep their shape; the
   * composition always provides it.
   */
  loadInbox?(sessionID: string): Promise<AdmittedSessionInput[] | undefined>;
  flush(): Promise<void>;
  runCommand(
    id: string,
    text: string,
    signal: AbortSignal | undefined,
    sessionID: string,
  ): Promise<boolean>;
  runTurn(input: {
    id: string;
    text: string;
    sessionID: string;
    attachments: LocalAttachment[];
    resources: PromptResourceMention[];
    agents: PromptAgentMention[];
    internal?: boolean;
  }): Promise<void>;
};
