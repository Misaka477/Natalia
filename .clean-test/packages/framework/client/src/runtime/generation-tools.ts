/**
 * The agent-facing generation tools (NGM study §4.4, the L2 half of the
 * self-modification surface; `constitution_propose_rule` is the L1
 * precedent living beside them).
 *
 * - `propose_generation` builds and stores a content-addressed candidate
 *   (config patch + plugin toggles over the live composition) and journals
 *   the proposal. Nothing runs.
 * - `apply_generation` drives the full orchestration: four-face gate ->
 *   approval -> switch -> health (or rollback). Its `requiresApproval`
 *   floor IS the study's approval step (composition changes default to
 *   human confirmation); `now` is the hermes-style opt-in, the default
 *   defers to the next session.
 * - `rollback_generation` is the safety action: always allowed, no gate
 *   and no approval — a candidate must never be able to block its own
 *   undo (study: 回退永不被候选禁止).
 */
import { existsSync, readFileSync } from "node:fs";
import { dirname, resolve } from "node:path";
import { ObjectStore } from "@anthelia/object-store";
import { mergeConfig, updateConfigAtScope } from "@anthelia/config";
import type { ConfigV3, RuntimeEvent } from "@anthelia/contracts";
import {
  buildGeneration,
  deriveCompositionPointer,
  guardsFace,
  loadGeneration,
  storeGeneration,
  switchGeneration,
  type VerificationFace,
  compositionProfile,
} from "@anthelia/composition";
import { resolveWorkspaceObjectsRoot } from "@anthelia/platform";
import { createNiaChatSurface } from "@natalia/collab";
import { activeConstitutionRows } from "./config-reload";
import { generationAdapterRows, generationPrompts } from "./generation-inputs";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import { niaFace, smokeFace } from "./verification-faces";
import type { RuntimeTool } from "@anthelia/tools";

function activeExec(ctx: RuntimeContext): SessionExecutionState | undefined {
  return ctx.ports.getActiveExec();
}

function workspaceRoot(ctx: RuntimeContext): string {
  return ctx.ports.getWorkspaceRoot();
}

function objectStore(ctx: RuntimeContext): ObjectStore {
  return new ObjectStore(resolveWorkspaceObjectsRoot(workspaceRoot(ctx)));
}

/**
 * The nearest directory above the workspace whose package.json declares the
 * guard chain — the architecture face's root. Not found means the candidate
 * cannot be checked against the architecture at all, which fails the face
 * loudly rather than passing it silently.
 */
export function findGuardRoot(start: string): string | undefined {
  let current = resolve(start);
  for (;;) {
    const manifest = joinManifest(current);
    if (manifest) {
      try {
        const parsed = JSON.parse(readFileSync(manifest, "utf8")) as {
          scripts?: Record<string, string>;
        };
        if (parsed.scripts?.["guard:imports"]) return current;
      } catch {
        /* unreadable manifest: keep walking */
      }
    }
    const parent = dirname(current);
    if (parent === current) return undefined;
    current = parent;
  }
}

function joinManifest(dir: string): string | undefined {
  const manifest = joinSafe(dir, "package.json");
  return existsSync(manifest) ? manifest : undefined;
}

function joinSafe(dir: string, file: string): string {
  return resolve(dir, file);
}

function guardsFaceFor(ctx: RuntimeContext): VerificationFace {
  const root =
    findGuardRoot(workspaceRoot(ctx)) ?? findGuardRoot(process.cwd());
  if (!root)
    return () => ({
      check: "guards",
      ok: false,
      detail:
        "no guard root above the workspace — the candidate cannot be verified against the architecture here",
    });
  return guardsFace({ repoRoot: root });
}

function niaSurfaces(ctx: RuntimeContext) {
  const planDoc = ctx.ports.planDocRuntime;
  return {
    planDocWrite: planDoc.planDocWrite.bind(planDoc),
    planDocMark: planDoc.planDocMark.bind(planDoc),
    planDocActivate: planDoc.planDocActivate.bind(planDoc),
    planDocStatus: planDoc.planDocStatus.bind(planDoc),
    niaChat: createNiaChatSurface(ctx),
  };
}

/** The candidate's journal handle plus the pointer links a switch needs. */
function generationPointers(ctx: RuntimeContext) {
  const events: RuntimeEvent[] = activeExec(ctx)?.session.events ?? [];
  return deriveCompositionPointer(events);
}

export function createProposeGenerationTool(ctx: RuntimeContext): RuntimeTool {
  return {
    name: "propose_generation",
    description:
      "Propose a composition change (L2 self-modification): a config patch and/or plugin enable/disable list, built as a content-addressed candidate and journaled as composition.proposed. Nothing changes until apply_generation passes the verification gate; the summary tells you how many live sessions the change would affect.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        configPatch: {
          type: "object",
          description:
            "Partial config overlay merged over the running config (project-scoped rows land in the workspace config; global-model rows in the user's global config).",
        },
        plugins: {
          type: "array",
          items: {
            type: "object",
            properties: {
              id: { type: "string" },
              enabled: { type: "boolean" },
            },
            required: ["id", "enabled"],
            additionalProperties: false,
          },
          description: "Desired enabled state for plugins by id.",
        },
        note: {
          type: "string",
          description: "One sentence: why this change is being proposed.",
        },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const args = input as {
        configPatch?: Record<string, unknown>;
        plugins?: Array<{ id: string; enabled: boolean }>;
        note?: string;
      };
      if (typeof args.note !== "string" || !args.note.trim())
        return "propose_generation requires a non-empty note (the journal records why)";
      const live = ctx.ports.getTsRuntimeConfig();
      if (!live) return "no running config to propose a change against";
      const merged = (
        args.configPatch ? mergeConfig(live, args.configPatch) : live
      ) as ConfigV3;
      const catalog = ctx.ports
        .getPluginsController()
        .catalog()
        .map((entry) => ({ ...entry }));
      for (const override of args.plugins ?? []) {
        const target = catalog.find((entry) => entry.id === override.id);
        if (!target)
          return `unknown plugin id: ${override.id} (not in the desired catalog)`;
        target.enabled = override.enabled;
      }
      const candidate = buildGeneration({
        config: merged,
        catalog,
        policyRows: activeConstitutionRows(ctx),
        // The prompt surface and the seam rows the candidate would run
        // with: a proposal that edits the prompt docs or the backend
        // selection must land inside the generation hash, or the switch
        // would look like a no-op to the cache scope.
        prompts: generationPrompts(ctx.ports.getWorkspaceRoot()),
        rows: generationAdapterRows(ctx),
      });
      const candidateID = await storeGeneration(objectStore(ctx), candidate);
      ctx.ports.publish({
        type: "composition.proposed",
        candidateID,
        reason: args.note,
      });
      const sessions = [...ctx.ports.getExecutionBySession().values()].length;
      return JSON.stringify({
        candidateID,
        sessionsAffected: sessions,
        effect:
          "nothing runs yet — apply_generation verifies and switches (default: effective next session; now: opt in)",
        note: args.note,
      });
    },
  };
}

export function createApplyGenerationTool(ctx: RuntimeContext): RuntimeTool {
  return {
    name: "apply_generation",
    description:
      "Apply a proposed generation: run the four-face verification gate (constitution, architecture guards, isolated smoke boot, Nia audit), then switch. This call itself requires approval at the tool floor — composition changes confirm with the human by default. Without now=true the switch is durable but takes effect at the next session; a failed post-switch health check rolls back automatically and records the incident.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        candidateID: {
          type: "string",
          description: "The proposed generation's content id.",
        },
        now: {
          type: "boolean",
          description:
            "Opt in to taking the switch live immediately instead of at the next session boundary.",
        },
        reason: { type: "string", description: "Why this switch is applied." },
      },
      required: ["candidateID"],
      additionalProperties: false,
    },
    async execute(input) {
      const args = input as {
        candidateID?: string;
        now?: boolean;
        reason?: string;
      };
      if (typeof args.candidateID !== "string")
        return "apply_generation requires candidateID";
      const live = ctx.ports.getTsRuntimeConfig();
      if (!live) return "no running config to switch away from";
      const candidate = await loadGeneration(
        objectStore(ctx),
        args.candidateID,
      );
      const pointer = generationPointers(ctx);
      const result = await switchGeneration({
        candidateID: args.candidateID,
        candidate,
        activeRules: activeConstitutionRows(ctx),
        faces: {
          guards: guardsFaceFor(ctx),
          smoke: smokeFace(),
          nia: niaFace(niaSurfaces(ctx)),
        },
        reason: args.reason ?? "apply_generation",
        when: args.now ? "now" : "next-session",
        ...(pointer.current ? { currentGenerationID: pointer.current } : {}),
        currentConfig: live,
        // The tool's requiresApproval floor already asked the human — the
        // study routes composition approval through the approval floors,
        // not a second bespoke channel.
        requestApproval: async () => "granted",
        applyConfig: async (config) => {
          await updateConfigAtScope(workspaceRoot(ctx), config, "project", {
            globalPath: ctx.ports.configGlobalPath?.(),
          });
        },
        reloadRuntime: async () => {
          await ctx.ports.reloadConfigFromDisk();
        },
        healthCheck: async () => {
          await ctx.ports.getReady();
          return { ok: Boolean(ctx.ports.getTsRuntimeConfig()) };
        },
        publish: (event) => ctx.ports.publish(event),
      });
      return JSON.stringify({
        switched: result.switched,
        stage: result.stage,
        ...(result.detail ? { detail: result.detail } : {}),
        verdict: {
          result: result.verdict.verdict,
          checks: result.verdict.checks,
        },
        ...(result.stage === "deferred"
          ? { effect: "durable now — live from the next session" }
          : {}),
      });
    },
  };
}

export function createRollbackGenerationTool(ctx: RuntimeContext): RuntimeTool {
  return {
    name: "rollback_generation",
    description:
      "Roll the composition back to a previous generation (default: the one before the current). Always allowed: no verification gate and no approval — a rollback must never be blocked by the candidate it undoes. Journals composition.switched back.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        to: {
          type: "string",
          description:
            "Target generation id; defaults to the previous generation.",
        },
        reason: {
          type: "string",
          description: "Why the rollback is happening.",
        },
      },
      additionalProperties: false,
    },
    async execute(input) {
      const args = input as { to?: string; reason?: string };
      const pointer = generationPointers(ctx);
      const target = args.to ?? pointer.previous;
      if (!target)
        return "rollback_generation: no previous generation is recorded and no target was given";
      if (pointer.current === target)
        return JSON.stringify({
          switched: false,
          reason: "already current",
          to: target,
        });
      const live = ctx.ports.getTsRuntimeConfig();
      if (!live) return "no running config to roll back from";
      const generation = await loadGeneration(objectStore(ctx), target);
      await updateConfigAtScope(
        workspaceRoot(ctx),
        generation.config,
        "project",
        {
          globalPath: ctx.ports.configGlobalPath?.(),
        },
      );
      await ctx.ports.reloadConfigFromDisk();
      const profile =
        ctx.state.serviceDirectory.getOptional(compositionProfile);
      ctx.ports.publish({
        type: "composition.switched",
        ...(pointer.current ? { from: pointer.current } : {}),
        ...(profile ? { compositionHash: profile.hash } : {}),
        to: target,
        reason: args.reason ?? "rollback_generation",
      });
      return JSON.stringify({
        switched: true,
        to: target,
        from: pointer.current,
      });
    },
  };
}
