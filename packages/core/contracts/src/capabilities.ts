/**
 * What a runtime is required to do, and how a consumer finds out what else it can.
 *
 * `RuntimeClient` has 87 members and only eight of them are required, so on its own
 * the type says almost nothing: an implementer cannot tell what the minimum is, and
 * a consumer has to feature-detect nearly every call. Worse, `optional` cannot
 * express *why* something is absent — "this runtime does not do terminals" and
 * "nobody has implemented this yet" look identical from the outside, and a query
 * that returns an empty array looks like "no data".
 *
 * This module says all three things explicitly:
 *
 *   - `REQUIRED_RUNTIME_MEMBERS` is the minimum. A runtime providing these is
 *     usable: start a session, submit a turn, cancel it, read state, answer a
 *     prompt.
 *   - `RUNTIME_CAPABILITY_GROUPS` assigns every remaining member to a capability,
 *     so "which parts of the API does this runtime have" is answerable by group
 *     rather than one member at a time. A member that belongs to no group fails
 *     typecheck, so the classification cannot rot as members are added.
 *   - `UNIMPLEMENTED_QUERIES` names the surfaces that exist, are wired end to end,
 *     and have no production writer yet. They answer with an empty result today,
 *     which a consumer would otherwise read as "nothing recorded".
 *
 * `describeRuntimeCapabilities()` derives the report from an instance instead of
 * asking the implementer to declare it, because a hand-maintained declaration is
 * one more thing that can disagree with the code.
 */
import type { RuntimeClient } from "./events";

/**
 * The API version of this contract, as a single integer. It appears in
 * `runtime.availability` and in `/healthz`, and it is bound to the stable
 * surface below: a change to the required members is a breaking change and
 * must bump this number. A consumer reads it and refuses to guess when it
 * meets a version it does not know.
 */
export const API_VERSION = 1 as const;

/**
 * The stable surface: the required members and the version they are promised
 * under. This is the one place a breaking change is declared — moving a member
 * out of the required set (or changing its meaning) without bumping
 * `apiVersion` here is exactly the silent breakage this module exists to
 * prevent. `REQUIRED_RUNTIME_MEMBERS` is derived from it, so the promise and
 * the code cannot disagree.
 */
export const API_STABLE_SURFACE = {
  apiVersion: API_VERSION,
  requiredMembers: [
    "start",
    "submit",
    "cancel",
    "snapshot",
    "diagnostic",
    "lastSubmission",
    "respondApproval",
    "respondQuestion",
  ],
} as const;

/**
 * The minimum a runtime must implement to be usable at all: open a session, take a
 * turn, stop it, read the current state, report a problem, and answer the two
 * prompts a turn can block on.
 */
export const REQUIRED_RUNTIME_MEMBERS = API_STABLE_SURFACE.requiredMembers;

export type RequiredRuntimeMember = (typeof REQUIRED_RUNTIME_MEMBERS)[number];

/**
 * Members marked deprecated, with the replacement a consumer should move to.
 * Empty today; the mechanism exists so a future deprecation shows up in the
 * availability report (`deprecated` on the channel member) instead of being
 * learned from a changelog. Removing a member's meaning is a breaking change:
 * it requires the version machinery, not just this table.
 */
export const DEPRECATED_RUNTIME_MEMBERS: Readonly<
  Record<string, { replacement?: string; since?: number }>
> = {};

/**
 * Optional members grouped by the capability they belong to. A consumer checks a
 * group, not 87 individual members, and an implementer reads a group as a unit of
 * work rather than a list of methods to guess at.
 */
export const RUNTIME_CAPABILITY_GROUPS = {
  /** Reading and replaying a session's own history. */
  transcript: [
    "history",
    "eventWindow",
    "messages",
    "pendingInteractive",
    "respondInteractive",
    "submitInput",
    "submitAndWait",
  ],
  /** Recording human opinions about the work — never model input (D6a). */
  feedback: ["feedback"],
  /** Pausing and resuming a running turn, plus editing its queued inputs. */
  turnControl: [
    "pause",
    "resume",
    "removeInput",
    "replaceInput",
    "promoteInput",
  ],
  /** Lifecycle beyond a single session. */
  lifecycle: [
    "drainForUpdate",
    "dispose",
    "canReloadConfig",
    "reloadConfig",
    "updateConfig",
    "configGet",
  ],
  /** The interface-preference settings file served over RPC. */
  settings: ["settingsGet", "settingsSet", "responseCache"],
  /** Choosing the agent and model a turn runs as. */
  selection: [
    "agents",
    "selectAgent",
    "modelCatalog",
    "modelSelection",
    "selectModel",
    "setDefaultModel",
    "reasoningEffort",
    "setReasoningEffort",
    "skills",
    "skillSetEnabled",
    "skillRemove",
    "agentCreate",
    "agentUpdate",
    "agentDelete",
    "providerDiscover",
    "providerAdd",
    "providerRemove",
  ],
  /** Reading and searching the workspace. */
  workspace: [
    "workspaceFiles",
    "workspaceSearch",
    "workspaceList",
    "workspaceRead",
    "resourceRead",
    "workspaceWrite",
    "workspaceCreate",
    "workspaceRename",
    "workspaceDelete",
    "workspaceWriteConflicts",
    "workspaceGlob",
    "workspaceDiff",
    "workspaceGitDiff",
    "gitRefs",
    "astDiff",
    "astDiffBatch",
    "astRefactorPreview",
    "astService",
    "astMove",
    "workspaceAstMove",
    "astRefactorPlan",
    "astApplyRefactor",
    "workspaceRoots",
    "workspaceAdd",
    "workspaceRemove",
    "workspaceActivate",
    "workspacePermissionGet",
    "workspacePermissionSet",
    "workspaceToolGet",
    "workspaceToolSet",
  ],
  /** The native terminal host, including secure input and approval scopes. */
  nativeTerminal: [
    "nativeTerminalList",
    "nativeTerminalRead",
    "nativeTerminalClaimHumanInput",
    "nativeTerminalOpenHub",
    "nativeTerminalRevokeApprovalScope",
    "nativeTerminalReleaseHumanControl",
    "nativeTerminalBeginSecureInput",
    "nativeTerminalEndSecureInput",
    "nativeTerminalStop",
    "nativeTerminalStart",
    "nativeTerminalWrite",
    "nativeTerminalResize",
  ],
  /** Snapshotting the workspace and rolling it back. */
  checkpoint: [
    "checkpointList",
    "checkpointListByKind",
    "auditRounds",
    "roundDiff",
    "checkpointPreview",
    "checkpointRollback",
    "checkpointRename",
  ],
  /** Working inside an isolated copy of the workspace. */
  sandbox: [
    "sandboxList",
    "sandboxDiff",
    "sandboxResources",
    "sandboxResourceOutput",
    "sandboxMerge",
    "sandboxDelete",
    "sandboxRollback",
    "sandboxResourceStop",
    "teamPRList",
  ],
  /** Managing sessions as durable records. */
  sessions: [
    "sessionList",
    "sessionTouch",
    "sessionRename",
    "sessionPin",
    "sessionDuplicate",
    "sessionFork",
    "sessionRollbackMessages",
    "sessionDelete",
    "sessionNew",
    "sessionArchive",
    "sessionRestore",
    "sessionExport",
    "sessionAttach",
    "subagents",
    "subagentHistory",
    "subagentHistoryPage",
  ],
  /** Tools and prompts contributed by MCP servers. */
  mcp: [
    "mcpCatalog",
    "getMcpPrompt",
    "readMcpResource",
    "mcpServerAdd",
    "mcpServerRemove",
  ],
  /** What has been loaded into this runtime. */
  extensions: [
    "plugins",
    "commandCatalog",
    "commandExecute",
    "capabilities",
    "pluginUnload",
    "pluginReload",
    "pluginInstall",
    "pluginUninstall",
    "pluginSetEnabled",
    "pluginCatalog",
    "toolFamilyReload",
    "projectionContributions",
  ],
  /** Security and configuration management (permission profiles). */
  management: ["permissionList", "permissionSave", "permissionDelete"],
  /** Durable task and flow documents. */
  observability: [
    "runtimeStatus",
    "diagnostics",
    "operationRecords",
    "sessionSnapshot",
  ],
  /** The Work Graph: what happened and what caused it. */
  workGraph: ["workGraphNodes", "workGraphEdges"],
  /**
   * Engineering-intelligence records. Present end to end and empty in practice —
   * see `UNIMPLEMENTED_QUERIES`.
   */
  intelligence: [
    "constitutionRules",
    "growthPropose",
    "growthProposals",
    "promptRunGroups",
    "externalBenchmark",
    "recordExternalRun",
    "correctionPatterns",
    "growthTriggers",
    "promoteGrowthTrigger",
    "growthPromotions",

    "externalJoinedTasks",
    "constitutionOverrides",
    "decisionRecords",
    "recordDecision",
    "evidenceRecords",
    "recordValidation",
    "completions",
    "recordCompletion",
    "recordHumanValidation",
    "planTaskStates",
    "workGraphIntegrity",
    "unattributedChanges",
    "driftFindings",
    "evaluateDrift",
    "acknowledgeDriftFinding",
    "reopenDriftFinding",
    "confirmedWorkspaceChanges",
    "registeredTools",
    "requestOverride",
    "approveOverride",
    "updateConstitutionRule",
    "removeConstitutionRule",
    "createConstitutionRule",
    "constitutionDocRules",
    "promoteConstitutionDocRule",
    "updateConstitutionDocRule",
    "notices",
  ],
  /** Live Work Chat durable mailbox (P8 Phase C3). */
  mailbox: [
    "mailboxList",
    "mailboxSend",
    "mailboxDeliver",
    "mailboxAcknowledge",
    "mailboxDefer",
    "mailboxSupersede",
  ],
  /** Lightweight Markdown plan document registry (replaces P8 C4). */
  planDocs: [
    "planDocList",
    "planDocRead",
    "planDocWrite",
    "planDocMark",
    "planDocDelete",
    "planDocStatus",
    "planDocUpdateStatus",
    "planDocActive",
    "planDocActivate",
    "planDocDeactivate",
  ],
  /** Same-session goal control (pause/resume/clear/edit bypassing the model). */
  goals: ["goalControl", "goalEdit"],
  /** Durable attachment upload/storage for pasted or dropped files. */
  attachments: ["uploadAttachment", "attachmentDataUrl"],
  /** The always-available Live Work Chat conversation (P8 Phase C2). */
  chat: ["naviChat", "niaChat"],
} as const satisfies Record<string, readonly (keyof RuntimeClient)[]>;

export type RuntimeCapabilityGroup = keyof typeof RUNTIME_CAPABILITY_GROUPS;

const GROUP_BY_MEMBER = new Map<string, RuntimeCapabilityGroup>(
  (Object.keys(RUNTIME_CAPABILITY_GROUPS) as RuntimeCapabilityGroup[]).flatMap(
    (group) =>
      (RUNTIME_CAPABILITY_GROUPS[group] as readonly string[]).map(
        (member) => [member, group] as const,
      ),
  ),
);

/**
 * Which capability a member belongs to, so a caller told "not supported" can
 * switch off the whole group instead of discovering it one member at a time.
 * Required members belong to no group and answer `undefined`, because a runtime
 * missing one of those is unusable rather than degraded.
 *
 * Derived from `RUNTIME_CAPABILITY_GROUPS`; a second hand-written mapping is
 * exactly the thing that would rot.
 */
export function capabilityGroupOf(
  member: string,
): RuntimeCapabilityGroup | undefined {
  return GROUP_BY_MEMBER.get(member);
}

type ClassifiedMember =
  | RequiredRuntimeMember
  | (typeof RUNTIME_CAPABILITY_GROUPS)[RuntimeCapabilityGroup][number];

type AssertNever<T extends never> = T;
/**
 * Compile-time completeness. Adding a member to `RuntimeClient` without putting it
 * in a group fails typecheck, so the report can never quietly stop describing part
 * of the API — the failure mode this exists to prevent.
 */
export type UnclassifiedRuntimeClientMember = AssertNever<
  Exclude<keyof RuntimeClient, ClassifiedMember>
>;

/**
 * Queries that are implemented, reachable, and answer with nothing because no
 * production code writes the facts they read yet. Stated here so an integrator can
 * tell that apart from "there is nothing to report", which is the one thing an
 * empty array cannot say for itself.
 *
 * Each is a first slice whose writer is scheduled work, not an abandoned surface.
 */
export const UNIMPLEMENTED_QUERIES = {} as const satisfies Partial<
  Record<keyof RuntimeClient, string>
>;

export type UnimplementedQuery = keyof typeof UNIMPLEMENTED_QUERIES;

/**
 * How one member fares on one channel. The distinction this whole report
 * exists for: a runtime implements a member, but the connection you are on may
 * not route it. "This runtime can do it" and "I can call it" are two facts.
 */
export type ChannelMemberState =
  | "implemented_reachable"
  | "implemented_unreachable"
  | "not_implemented";

export type ChannelCapabilityMember = {
  member: string;
  state: ChannelMemberState;
  /** Why. Absent when the state speaks for itself. */
  reason?: string;
  /** Set when the member is deprecated; names what to move to. */
  deprecated?: { replacement?: string; since?: number };
};

export type ChannelCapabilityGroup = {
  name: RuntimeCapabilityGroup;
  /** Every member of the group is implemented on this runtime and routed on this channel. */
  reachable: boolean;
  /** Some but not all — usually a mistake worth looking at. */
  partial: boolean;
  members: ChannelCapabilityMember[];
};

/**
 * The channel a report describes, when the caller asked about one. Absent means
 * the report answers "what this runtime implements"; present means "what I can
 * reach over this channel".
 */
export type ChannelCapabilityReport = {
  name: string;
  groups: ChannelCapabilityGroup[];
  /**
   * The required members on this channel, with the same three states. They are
   * not part of any capability group, so this is where a consumer learns that
   * `start` or `lastSubmission` is intentionally local (or, on a broken
   * channel, missing).
   */
  requiredMembers: ChannelCapabilityMember[];
};

export type RuntimeCapabilityReport = {
  /** The API version this runtime speaks. Bound to the stable surface. */
  apiVersion: number;
  /** True when every required member is present; false means unusable, not degraded. */
  usable: boolean;
  missingRequired: RequiredRuntimeMember[];
  groups: Array<{
    name: RuntimeCapabilityGroup;
    /** Every member of the group is present. */
    available: boolean;
    /** Some but not all — worth reporting, because it is usually a mistake. */
    partial: boolean;
    missing: string[];
  }>;
  /**
   * Present and answering with nothing, with the reason. A consumer should not
   * build a feature on these.
   */
  unimplemented: Array<{ member: UnimplementedQuery; reason: string }>;
  /**
   * Per-channel reachability. The host computes it by intersecting what this
   * runtime implements with the channel's route table — the route table is the
   * only fact source, there is no second hand-maintained list.
   */
  channel?: ChannelCapabilityReport;
};

function withDeprecation(
  member: string,
  entry: { member: string; state: ChannelMemberState; reason?: string },
  deprecated: Readonly<
    Record<string, { replacement?: string; since?: number }>
  >,
): ChannelCapabilityMember {
  const annotation = deprecated[member];
  if (!annotation) return entry;
  return { ...entry, deprecated: annotation };
}

/**
 * Describes what a specific runtime can do, by looking at what it actually
 * implements rather than what it claims.
 */
export function describeRuntimeCapabilities(
  client: RuntimeClient,
  channel?: {
    name: string;
    /** The channel's route table, as member names. The caller owns this. */
    routedMembers: ReadonlySet<string>;
    /** Optional per-member reason for the unreachable state. */
    unreachableReasons?: Readonly<Record<string, string>>;
  },
  deprecated: Readonly<
    Record<string, { replacement?: string; since?: number }>
  > = DEPRECATED_RUNTIME_MEMBERS,
): RuntimeCapabilityReport {
  const has = (member: string) =>
    typeof (client as unknown as Record<string, unknown>)[member] ===
    "function";
  const missingRequired = REQUIRED_RUNTIME_MEMBERS.filter(
    (member) => !has(member),
  );
  const groups = (
    Object.keys(RUNTIME_CAPABILITY_GROUPS) as RuntimeCapabilityGroup[]
  ).map((name) => {
    const members = RUNTIME_CAPABILITY_GROUPS[name] as readonly string[];
    const missing = members.filter((member) => !has(member));
    return {
      name,
      available: missing.length === 0,
      partial: missing.length > 0 && missing.length < members.length,
      missing,
    };
  });
  const channelReport = channel
    ? {
        name: channel.name,
        requiredMembers: REQUIRED_RUNTIME_MEMBERS.map((member) => {
          if (!has(member))
            return withDeprecation(
              member,
              {
                member,
                state: "not_implemented" as const,
                reason: "this runtime does not implement it",
              },
              deprecated,
            );
          if (channel.routedMembers.has(member))
            return withDeprecation(
              member,
              {
                member,
                state: "implemented_reachable" as const,
              },
              deprecated,
            );
          return withDeprecation(
            member,
            {
              member,
              state: "implemented_unreachable" as const,
              reason:
                channel.unreachableReasons?.[member] ??
                "this transport does not route it",
            },
            deprecated,
          );
        }),
        groups: (
          Object.keys(RUNTIME_CAPABILITY_GROUPS) as RuntimeCapabilityGroup[]
        ).map((name) => {
          const members = RUNTIME_CAPABILITY_GROUPS[name] as readonly string[];
          const memberStates = members.map((member) => {
            if (!has(member))
              return withDeprecation(
                member,
                {
                  member,
                  state: "not_implemented" as const,
                  reason: "this runtime does not implement it",
                },
                deprecated,
              );
            if (channel.routedMembers.has(member))
              return withDeprecation(
                member,
                {
                  member,
                  state: "implemented_reachable" as const,
                },
                deprecated,
              );
            return withDeprecation(
              member,
              {
                member,
                state: "implemented_unreachable" as const,
                reason:
                  channel.unreachableReasons?.[member] ??
                  "this transport does not route it",
              },
              deprecated,
            );
          });
          const reachable = memberStates.every(
            (member) => member.state === "implemented_reachable",
          );
          const unreachableCount = memberStates.filter(
            (member) => member.state === "implemented_unreachable",
          ).length;
          return {
            name,
            reachable,
            partial:
              unreachableCount > 0 && unreachableCount < memberStates.length,
            members: memberStates,
          };
        }),
      }
    : undefined;
  return {
    apiVersion: API_STABLE_SURFACE.apiVersion,
    usable: missingRequired.length === 0,
    missingRequired: [...missingRequired],
    groups,
    channel: channelReport,
    unimplemented: (Object.keys(UNIMPLEMENTED_QUERIES) as UnimplementedQuery[])
      .filter((member) => has(member))
      .map((member) => ({ member, reason: UNIMPLEMENTED_QUERIES[member] })),
  };
}
