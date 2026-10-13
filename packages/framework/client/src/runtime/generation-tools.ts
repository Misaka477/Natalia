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
import { mkdir, readFile, rm, writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";
import { dirname, resolve } from "node:path";
import { ObjectStore } from "@anthelia/object-store";
import {
  mergeConfig,
  replaceProjectConfig,
  updateConfigAtScope,
} from "@anthelia/config";
import type { ConfigV4, Generation, RuntimeEvent } from "@anthelia/contracts";
import { sandboxService } from "@anthelia/runtime-services";
import { waitForDrain } from "./session-execution/drain";
import { planTreePromotion, treeConflictReason } from "./generation-tree";
import { editParent, planEdits } from "@anthelia/tools";
import { installStagedBuild, resolveUpdateHome } from "@natalia/installer";
import { nextContextInstructionsRevision } from "@anthelia/session";
import {
  buildGeneration,
  deriveCompositionPointer,
  guardsFace,
  loadGeneration,
  proposedGenerations,
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
import { genericToolCard, type RuntimeTool } from "@anthelia/tools";

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
  // The session the switch runs in. The audit gate activates the plan ON it
  // and submits the wake TO it, so `activePlanForExec` answers for the turn
  // that actually starts; without it the `activePlanID` lands on whatever
  // exec happens to be active and the audit machinery sees no plan.
  const sessionID = activeExec(ctx)?.session?.id;
  return {
    planDocWrite: planDoc.planDocWrite.bind(planDoc),
    planDocMark: planDoc.planDocMark.bind(planDoc),
    planDocActivate: planDoc.planDocActivate.bind(planDoc),
    planDocStatus: planDoc.planDocStatus.bind(planDoc),
    planDocUpdateStatus: planDoc.planDocUpdateStatus.bind(planDoc),
    niaChat: createNiaChatSurface(ctx),
    sessionID,
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
    output: genericToolCard({
      family: "generation",
      callSummary: "propose",
      resultSummary: "proposed",
      titleKey: "sessionID",
    }),
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
      ) as ConfigV4;
      const catalog = ctx.ports
        .getPluginsController()
        .catalog()
        .map((entry) => ({ ...entry }));
      for (const override of args.plugins ?? []) {
        const target = catalog.find((entry) => entry.id === override.id);
        if (!target)
          // P1-5: the refusal used to stop at "not in the desired catalog",
          // leaving the model to guess what the catalog DOES contain — the
          // 2026-10-08 audit lost a round to exactly that. The answer now
          // names the ids, and says where an id would have to come from.
          return (
            `unknown plugin id: ${override.id} (not in the desired catalog). ` +
            `The catalog holds ${catalog.length} plugin(s): ` +
            `${
              catalog
                .map((entry) => entry.id)
                .sort()
                .join(", ") || "(none)"
            }. ` +
            `An id enters it by being a built-in or by being installed in the ` +
            `plugin store; a plugins.enabled entry alone does not.`
          );
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
    output: genericToolCard({
      family: "generation",
      callSummary: "apply",
      resultSummary: "applied",
      titleKey: "generationID",
    }),
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
          smoke: smokeFace({
            // The workspace's own backend fact, read off its controller:
            // a candidate applied HERE inherits THAT backend's promises.
            enforcement: ctx.state.serviceDirectory
              .getOptional(sandboxService)
              ?.enforcement?.(),
          }),
          nia: niaFace(niaSurfaces(ctx), {
            sessionID: activeExec(ctx)?.session?.id,
          }),
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
          // A replace, not a merge: the generation holds the whole
          // composition, and a merge would leave the previous generation's
          // values in every field this one does not mention.
          await replaceProjectConfig(workspaceRoot(ctx), config, {
            globalPath: ctx.ports.configGlobalPath?.(),
          });
        },
        reloadRuntime: async () => {
          await ctx.ports.reloadConfigFromDisk();
        },
        // 洞 5: a source-carrying generation's live switch drains first.
        // The drain is the shared wait (the same one the lifecycle surface
        // and the daemon's flip path use) — one answer to "is it quiet".
        drain: async () => {
          await waitForDrain(ctx.ports, { timeoutMs: 120_000 });
        },
        // Land the candidate's CODE: the workspace's repository checks the
        // ref out (or applies the patch). The process restart that makes
        // the new code RUN is the deployment's job — the daemon's own
        // drain/flip/restart path — and the switch's health check is what
        // proves the landing did not break the surface. What this seam
        // refuses to do is pretend: a reload-only switch over a
        // source-carrying generation is the `code-switch-unavailable`
        // refusal above, never a silent success.
        codeSwitch: async () => {
          await landGenerationSource(ctx, candidate.source);
        },
        healthCheck: async () => {
          await ctx.ports.getReady();
          return { ok: Boolean(ctx.ports.getTsRuntimeConfig()) };
        },
        publish: (event) => ctx.ports.publish(event),
      });
      // 洞 6: the model is TOLD it moved. A live switch announces itself
      // now; a deferred one announces at the boot that performs it (the
      // reload's own notice channel), because a notice for a switch that
      // has not happened yet would claim the very thing it exists to
      // report honestly.
      if (result.switched || result.stage === "rolled-back")
        await publishGenerationSwitchNotice(ctx, {
          ...(pointer.current ? { from: pointer.current } : {}),
          to: args.candidateID,
          reason: args.reason ?? "apply_generation",
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
    output: genericToolCard({
      family: "generation",
      callSummary: "rollback",
      resultSummary: "rolled back",
      titleKey: "generationID",
    }),
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
      // A replace, not a merge (same reason as the apply path): a rollback
      // restores the whole previous composition, so a field the target does
      // not mention must be REMOVED, not inherited from the candidate being
      // undone.
      await replaceProjectConfig(workspaceRoot(ctx), generation.config, {
        globalPath: ctx.ports.configGlobalPath?.(),
      });
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
      // 洞 6: a rollback is a switch too — the model must know it went
      // BACK, to which generation, with the same delta.
      await publishGenerationSwitchNotice(ctx, {
        ...(pointer.current ? { from: pointer.current } : {}),
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

/**
 * `cancel_generation` (T-22): the abandon half of the candidate surface.
 *
 * Before it, a proposal nobody would ever apply stayed the pointer's live
 * candidate forever — the model had staged something, changed its mind, and
 * had no way to say "not this one". The cancellation is a journaled fact
 * (`composition.cancelled`), so the pointer stops carrying it and a later
 * proposal can be the outstanding one. The CURRENT generation is not
 * cancellable: a live composition is rolled back, not abandoned.
 */
export function createCancelGenerationTool(ctx: RuntimeContext): RuntimeTool {
  return {
    name: "cancel_generation",
    description:
      "Abandon a staged composition candidate so it stops being the outstanding proposal. Journals composition.cancelled with your reason. Omit candidateID to abandon the outstanding one; the current (live) generation cannot be cancelled — roll it back instead.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        candidateID: {
          type: "string",
          description:
            "The candidate to abandon; defaults to the outstanding one.",
        },
        reason: {
          type: "string",
          description:
            "Why the candidate is abandoned (the journal records why).",
        },
      },
      additionalProperties: false,
    },
    output: genericToolCard({
      family: "generation",
      callSummary: "cancel",
      resultSummary: "cancelled",
      titleKey: "generationID",
    }),
    async execute(input) {
      const args = input as { candidateID?: string; reason?: string };
      const pointer = generationPointers(ctx);
      const target = args.candidateID?.trim() || pointer.candidate;
      if (!target)
        return "cancel_generation: no outstanding candidate to cancel";
      if (target === pointer.current)
        return (
          `cancel_generation: ${target} is the CURRENT generation — a live ` +
          `composition is rolled back (rollback_generation), not abandoned`
        );
      if (pointer.candidate && target !== pointer.candidate)
        return (
          `cancel_generation: the outstanding candidate is ${pointer.candidate}, ` +
          `not ${target} — pass it, or omit candidateID for the outstanding one`
        );
      const exec = activeExec(ctx);
      ctx.ports.publish({
        type: "composition.cancelled",
        candidateID: target,
        reason: args.reason?.trim() || "abandoned by the agent",
        ...(exec ? { sessionID: exec.session.id } : {}),
      });
      return JSON.stringify({ cancelled: true, candidateID: target });
    },
  };
}

/**
 * `list_generation_candidates` (T-22): what is staged, what was applied and
 * what was abandoned — the read half that makes the abandon half aimable.
 */
export function createListGenerationCandidatesTool(
  ctx: RuntimeContext,
): RuntimeTool {
  return {
    name: "list_generation_candidates",
    description:
      "List this session's staged composition candidates with their status (outstanding / applied / cancelled) and the reason each was staged. Read-only; never changes the workspace.",
    requiresApproval: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: genericToolCard({
      family: "generations",
      callSummary: "list",
      resultSummary: "listed",
      meta: [["candidates", "candidates"]],
    }),
    async execute() {
      const pointer = generationPointers(ctx);
      const candidates = proposedGenerations(
        activeExec(ctx)?.session.events ?? [],
      );
      return JSON.stringify({
        ...(pointer.current ? { current: pointer.current } : {}),
        ...(pointer.candidate ? { outstanding: pointer.candidate } : {}),
        candidates,
      });
    },
  };
}

/**
 * 洞 6: a generation switch is TOLD, not silently performed. The notice is
 * a `context.instructions` record of kind `generation_switch` per session —
 * the same durable, latest-win channel a config reload uses — so the model
 * learns it moved, to WHAT, and what changed. Without it a model that just
 * switched reports the old version's work as the new one's, which is the
 * exact failure this closes.
 *
 * The delta is computed from the two generations' own plugin lists: a
 * candidate that enables a plugin the current one had off is an ADD, and
 * the reverse a REMOVE. Skills and other surface ride in the summary when
 * the generation's rows name them; the plugin delta is the one the
 * generation machine can answer without guessing.
 */
async function publishGenerationSwitchNotice(
  ctx: RuntimeContext,
  input: { from?: string; to: string; reason: string },
): Promise<void> {
  const delta = await generationPluginDelta(ctx, input);
  for (const exec of ctx.ports.getExecutionBySession().values()) {
    const revision = nextContextInstructionsRevision(exec.session.events);
    ctx.ports.publishForSession(exec, {
      type: "context.instructions",
      id: `context:generation:${Date.now().toString(36)}:${revision}`,
      kind: "generation_switch",
      at: new Date().toISOString(),
      revision,
      summary:
        `switched to generation ${input.to}` +
        (input.from ? ` from ${input.from}` : "") +
        ` (${input.reason})`,
      ...(delta.length ? { detail: delta } : {}),
    });
  }
}

/** The plugin delta between the two generations, as detail lines. */
async function generationPluginDelta(
  ctx: RuntimeContext,
  input: { from?: string; to: string },
): Promise<string[]> {
  try {
    const store = objectStore(ctx);
    const to = await loadGeneration(store, input.to);
    const from = input.from
      ? await loadGeneration(store, input.from)
      : undefined;
    const enabledOf = (generation: typeof to) =>
      new Set(
        generation.plugins
          .filter((entry) => entry.enabled)
          .map((entry) => entry.id),
      );
    const toEnabled = enabledOf(to);
    const fromEnabled = from ? enabledOf(from) : new Set<string>();
    const added = [...toEnabled].filter((id) => !fromEnabled.has(id)).sort();
    const removed = [...fromEnabled].filter((id) => !toEnabled.has(id)).sort();
    return [
      ...added.map((id) => `+ plugin ${id}`),
      ...removed.map((id) => `- plugin ${id}`),
    ];
  } catch {
    // A delta that cannot be computed is omitted, never invented: the
    // summary still names the switch itself.
    return [];
  }
}

/**
 * Lands a generation's SOURCE — the L3 code lane, entirely on our own
 * infrastructure. Three lanes, none of which shells out:
 *
 *  - **edits** — the friendly editor's planner (verify-then-write,
 *    all-or-nothing, named failures), the same one `apply_edits` runs.
 *  - **tree** — a content-addressed snapshot promoted through our own
 *    three-way check over the object store's sha256 hashes (see
 *    generation-tree.ts): workspace==base takes the tree's content,
 *    workspace==next is already landed, anything else is a named conflict
 *    that refuses the whole promotion before the first write.
 *  - **staged-build** — the installer's own atomic sequence (stage →
 *    swapSymlink → probeVersion → rollback on a failed probe).
 *
 * The git study was absorbed, not routed around: the object store already
 * addresses content the way git's object database does, and the promotion
 * above is the merge discipline that makes that addressing safe to land
 * with. A branch name was never the point — "this content, cut from that
 * content" is, and we can say it without an external binary.
 */
async function landGenerationSource(
  ctx: RuntimeContext,
  source: NonNullable<Generation["source"]> | undefined,
): Promise<void> {
  if (!source) return;
  const workspace = workspaceRoot(ctx);
  if (source.kind === "edits") {
    const plan = await planEdits({
      root: workspace,
      edits: source.edits,
      label: "generation edits",
    });
    for (const write of plan.writes) {
      await mkdir(editParent(write.abs), { recursive: true });
      await writeFile(write.abs, write.content);
    }
    for (const del of plan.deletes) await rm(del.abs, { force: true });
    return;
  }
  if (source.kind === "tree") {
    const store = objectStore(ctx);
    const plan = await planTreePromotion({
      root: workspace,
      files: source.files,
      readWorkspace: async (abs) => {
        try {
          return await readFile(abs);
        } catch (error) {
          if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
          return undefined;
        }
      },
      readContent: async (hash) => Buffer.from(await store.get(hash)),
      hash: (bytes) => createHash("sha256").update(bytes).digest("hex"),
    });
    if (plan.conflicts.length)
      throw new Error(treeConflictReason(plan.conflicts));
    for (const write of plan.writes) {
      await mkdir(editParent(write.abs), { recursive: true });
      await writeFile(write.abs, write.content);
    }
    for (const del of plan.deletes) await rm(del.abs, { force: true });
    return;
  }
  // staged-build: the installer's atomic lane. The manifest lives in the
  // object store (content-addressed, so the generation stays self-contained
  // and the build outlives its sandbox).
  const store = objectStore(ctx);
  const manifest = JSON.parse(
    new TextDecoder().decode(await store.get(source.artifact)),
  ) as { files: Array<{ name: string; content: string }> };
  const files = new Map<string, Uint8Array>(
    manifest.files.map((file) => [
      file.name,
      Uint8Array.from(atob(file.content), (char) => char.charCodeAt(0)),
    ]),
  );
  const home = resolveUpdateHome(process.env);
  const landed = installStagedBuild({ home, version: source.version, files });
  if (landed.outcome === "rolled_back")
    throw new Error(
      `the staged build failed its self-check and was rolled back: ${landed.reason}`,
    );
  if (landed.outcome === "failed")
    throw new Error(`the staged build could not be landed: ${landed.reason}`);
}
