import { defineService } from "@anthelia/runtime-services";
import type { CacheFabric } from "./cache";
import type { RinaMemoryService } from "./memory";
import type { RinaVaultService } from "./vault";

/**
 * `rina.*` as a tokenized service (architecture decisions: RINA's
 * cache/memory mechanisms belong to the Anthelia engine; the contract is a
 * token).
 *
 * Consumed engine-side today — the L1 read-cache wrap in the tool pipeline
 * and the workspace write hooks. The plugin-facing `ctx.cache` port is
 * BUILT (2026-09-25, the master plan's closure round): the base-completeness
 * criterion — a future capability must land as a plugin with zero base
 * edits — makes the port a base surface, not a consumer-gated feature. The
 * substrate's plugin controller builds the port over this token's fabric;
 * the plugin kernel declares the surface structurally and gates it by the
 * `cache` integration point.
 */
/**
 * RINA Memory (Phase 7): the durable reusable knowledge store, one per
 * runtime, its own SQLite beside the vault's (the study's 复用冷档存储).
 * Its scope is the runtime's lifetime — the face that reads it is the
 * knowledge recall priority (State -> Workspace -> Global -> Vault).
 */
export const rinaMemory = defineService<RinaMemoryService>("rina.memory", {
  scope: "process",
  capability: "services",
});

export const rinaCache = defineService<CacheFabric>("rina.cache", {
  scope: "workspace",
  capability: "services",
});

export const rinaVault = defineService<RinaVaultService>("rina.vault", {
  scope: "process",
  capability: "services",
});
