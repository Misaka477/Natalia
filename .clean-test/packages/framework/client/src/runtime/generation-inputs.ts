import { createHash } from "node:crypto";
import { agentSystemPrompt } from "@natalia/agent-prompts";
import { loadProjectDocumentsSync } from "@natalia/engineering-intelligence";
import {
  compositionProfile,
  type CompositionProfile,
} from "@anthelia/composition";
import type { GenerationPrompts } from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";

/**
 * The generation's prompt surface (NGM study §4.1), hashed: one sha256 per
 * role's STATIC system prompt — ADR D1's byte-stable block — plus the
 * instruction documents with the loader's OWN content hashes. Hashes, not
 * bodies: the generation addresses the content, the same discipline as the
 * plugin fingerprints, and it is what makes the study's cache-aware rule
 * decidable (only a role whose prompt hash changed needs the deferred
 * boundary). The document source is the same loader the turn runner reads,
 * so the generation addresses exactly what the model would have seen.
 */

const ROLES = ["natalia", "navi", "nia"] as const;

export function generationPrompts(workspaceRoot: string): GenerationPrompts {
  const perRoleStatic: Record<string, string> = {};
  for (const role of ROLES)
    perRoleStatic[role] = createHash("sha256")
      .update(agentSystemPrompt(role))
      .digest("hex");
  const docs = (loadProjectDocumentsSync(workspaceRoot)?.documents ?? []).map(
    (document) => ({ path: document.path, sha256: document.hash }),
  );
  return { perRoleStatic, docs };
}

/**
 * The seam rows the live composition selected — the generation's adapter
 * bindings (study §4.1 / G6). The registry is the composition row registry
 * (code registers what can be bound, the profile row selects what is
 * bound); this is its effective selection, so an impl switch — decision
 * 17's factory — lands inside the generation hash.
 */
export function generationAdapterRows(
  ctx: RuntimeContext,
): Array<{ id: string; impl?: string }> {
  const profile = ctx.state.serviceDirectory.getOptional(compositionProfile) as
    | CompositionProfile
    | undefined;
  return (profile?.rows ?? []).map((row) => ({
    id: row.id,
    ...(row.impl !== undefined ? { impl: row.impl } : {}),
  }));
}
