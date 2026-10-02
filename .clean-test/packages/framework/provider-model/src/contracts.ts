import type {
  LocalAttachment,
  PromptAgentMention,
  PromptResourceMention,
  RuntimeEvent,
  SessionID,
} from "@anthelia/contracts";
import type { ProviderRunnerInput } from "@anthelia/runtime-services";
import type { ProviderUsage } from "@anthelia/runtime";

export type ProviderModelControllerInput = {
  initialize(): void;
  runnerInput(sessionID: SessionID): ProviderRunnerInput;
  /**
   * The operation-log channel (T3): the collaborator turns' telemetry
   * rides here, not the console. Structural and optional — a bare context
   * (tests) degrades to silence, telemetry never crashes a turn.
   */
  log?: {
    info(
      component: string,
      message: string,
      fields?: Record<string, unknown>,
    ): void;
    error(
      component: string,
      message: string,
      fields?: Record<string, unknown>,
    ): void;
    debug(
      component: string,
      message: string,
      fields?: Record<string, unknown>,
    ): void;
  };
  commands: {
    catalog(): Promise<
      Array<{ id: string; name: string; provider: string; variants: string[] }>
    >;
    select(
      sessionID: SessionID,
      modelID: string,
      variant?: string,
    ): Promise<void>;
  };
  navi: ProviderChatStreamInput;
  nia: ProviderChatStreamInput;
};

export interface ProviderModelController {
  runTurn(sessionID: SessionID, turn: ProviderTurnInput): Promise<void>;
  runNaviChatTurn(turn: ProviderChatTurnInput): Promise<void>;
  runNiaChatTurn(turn: ProviderChatTurnInput): Promise<void>;
  requestNaviWake(sessionID: SessionID): void;
  requestNiaWake(sessionID: SessionID): void;
  naviBusy(sessionID: SessionID): boolean;
  niaBusy(sessionID: SessionID): boolean;
  abortNavi(sessionID: SessionID): boolean;
  abortNia(sessionID: SessionID): boolean;
  dispose(): Promise<void>;
}

export type ProviderChatStreamInput = {
  available(sessionID: SessionID): boolean;
  publish(sessionID: SessionID, event: RuntimeEvent): void;
  runBody(input: ProviderChatTurnInput, signal: AbortSignal): Promise<void>;
  wake(sessionID: SessionID): Promise<void>;
};

export type ProviderTurnInput = {
  id: string;
  text: string;
  attachments: LocalAttachment[];
  resources: PromptResourceMention[];
  agents: PromptAgentMention[];
  internal?: boolean;
};

export type ProviderChatTurnInput = {
  sessionID: SessionID;
  text: string;
  responseMessageID: string;
  internal?: boolean;
  /**
   * A detour-review wake (EI §3.4): when set on an internal Nia turn, the turn
   * prompts Nia to review the requested detour (via detour_review) instead of
   * the default audit wake. Her verdict is a reference for the user.
   */
  detourReview?: { detourID: string; planID: string; reason: string };
  model?: { modelID?: string; variant?: string };
  provider?: import("@anthelia/runtime").StreamingProvider;
  reasoningEffort?: import("@anthelia/contracts").RuntimeReasoningEffort;
  attachments?: import("@anthelia/contracts").LocalAttachment[];
};
