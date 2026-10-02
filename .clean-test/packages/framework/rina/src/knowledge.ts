import type { RinaMemoryService, MemoryEntry } from "./memory";
import type { RinaVaultService, VaultRecallHit } from "./vault";

/**
 * The recall-priority face (rina-cache study Phase 7 rule 3):
 * 检索优先级 = State → Workspace Memory → Global Memory → ContextVault.
 *
 * The priority is the CONSULTATION ORDER, and this face is that order:
 * the live fold first (what is true NOW is answered without touching
 * durable knowledge), then this workspace's memories, then the global
 * ones, and only then the session's cold vault. The caller reads the
 * sections top-down; an empty lane is skipped rather than rendered as an
 * empty section (the order survives, the noise does not).
 *
 * Pure over its four inputs — the laning and the ordering are the unit's
 * job, fetching is the wire's (the same split the vault's scoring
 * uses). One rule the face enforces: memories are ACTIVE only by
 * default (the lifecycle's retired knowledge never answers a recall),
 * and a scope is never crossed implicitly (a global memory is in the
 * global lane; a workspace memory answers the workspace lane).
 */

export type KnowledgeSource =
  | "state"
  | "workspace_memory"
  | "global_memory"
  | "vault";

export type KnowledgeSection<T> = {
  source: KnowledgeSource;
  items: T[];
};

export type KnowledgeRecallInput = {
  /** The live fold's answer for "what is true now" (the vault's hot-state
   * face, the injected fact-state reader). */
  state?:
    | { available: true; state: unknown }
    | { available: false; reason: string };
  /** The workspace-scoped memories (active). */
  workspaceMemories?: readonly MemoryEntry[];
  /** The global-scoped memories (active). */
  globalMemories?: readonly MemoryEntry[];
  /** The session's cold-vault hits. */
  vaultHits?: readonly VaultRecallHit[];
};

export type KnowledgeRecall = {
  sections: KnowledgeSection<unknown>[];
  /** How many lanes had something to say (observability of the order). */
  sources: number;
};

export function recallKnowledge(input: KnowledgeRecallInput): KnowledgeRecall {
  const lanes: Array<KnowledgeSection<unknown>> = [
    {
      source: "state",
      items: input.state?.available ? [input.state.state] : [],
    },
    { source: "workspace_memory", items: [...(input.workspaceMemories ?? [])] },
    { source: "global_memory", items: [...(input.globalMemories ?? [])] },
    { source: "vault", items: [...(input.vaultHits ?? [])] },
  ];
  // The order IS the priority: the lanes array is the study's order, and
  // the filter drops the silent ones without reordering anything.
  const sections = lanes.filter((lane) => lane.items.length > 0);
  return { sections, sources: sections.length };
}

/**
 * The wire's fetch helper: one workspace's lane through its memory
 * service (active only — the lifecycle's retired knowledge never
 * answers). The scope string is the face's single place naming the
 * workspace lane's scope.
 */
export function workspaceMemoryScope(
  workspaceID: string,
): `workspace:${string}` {
  return `workspace:${workspaceID}`;
}

/** The global lane's scope (one name, used by the wire and the tests). */
export const GLOBAL_MEMORY_SCOPE = "global" as const;

/** Fetch the two memory lanes from one service, in the face's order. */
export function recallMemoryLanes(
  memory: RinaMemoryService,
  workspaceID: string,
  limit?: number,
): {
  workspaceMemories: MemoryEntry[];
  globalMemories: MemoryEntry[];
} {
  return {
    workspaceMemories: memory.recall({
      scope: workspaceMemoryScope(workspaceID),
      ...(limit === undefined ? {} : { limit }),
    }),
    globalMemories: memory.recall({
      scope: GLOBAL_MEMORY_SCOPE,
      ...(limit === undefined ? {} : { limit }),
    }),
  };
}
