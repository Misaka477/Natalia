import type { AgentRegistry } from "@anthelia/agent";
import type { ProviderConcurrencyLimiter } from "@anthelia/runtime";
import type { SessionRecord } from "@anthelia/session";
import type { InteractiveWaiter } from "@anthelia/runtime-services";
import type { ContextLedger } from "@anthelia/runtime";

export type RuntimeInitializePorts = {
  getSession: () => SessionRecord | undefined;
  getReplayMode: () => "all" | "none";
  getInteractive: () => InteractiveWaiter;
  getAttachmentReferences: () => Map<
    string,
    import("@anthelia/contracts").LocalAttachment[]
  >;
  getToolCalls: () => Map<string, number[]>;
  getActiveSkill: () =>
    | import("@anthelia/runtime-services").SkillMetadata
    | undefined;
  getRuntimeDiagnosticsBySession: () => Map<
    import("@anthelia/contracts").SessionID,
    Array<
      Extract<
        import("@anthelia/contracts").RuntimeEvent,
        { type: "diagnostic" }
      > & {
        at: string;
      }
    >
  >;
  getTurnAgent: () => Map<string, string>;
  getSelectedPermissionProfile: () =>
    | import("@anthelia/contracts").PermissionProfile
    | undefined;
  getAgentRegistry: () => AgentRegistry | undefined;
  getRuntimeContext: () => ContextLedger;
  getProviderConcurrencyLimiter: () => ProviderConcurrencyLimiter;
  getRetryPolicy: () => import("@anthelia/runtime").RetryRunnerOptions["policy"];
};
