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
import {
  mkdir,
  readdir,
  readFile,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { createHash } from "node:crypto";
import { spawn } from "node:child_process";
import { dirname, join, resolve } from "node:path";
import { sharedObjectStore, type ObjectStore } from "@anthelia/object-store";
import {
  mergeConfig,
  replaceProjectConfig,
  updateConfigAtScope,
} from "@anthelia/config";
import type { ConfigV4, Generation, RuntimeEvent } from "@anthelia/contracts";
import { sandboxService } from "@anthelia/runtime-services";
import { logOf } from "@anthelia/operation-log";
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
  // The shared store for this root, not a fresh one: a construction per
  // call was one SQLite handle (and pack daemon) per operation, none of
  // them released — which Windows answers with EBUSY when the root is
  // later removed. See sharedObjectStore.
  return sharedObjectStore(resolveWorkspaceObjectsRoot(workspaceRoot(ctx)));
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
      // The state the envelope reports, not the verb the call used.
      resultSummary: (facts) =>
        typeof facts.status === "string"
          ? `proposed · ${facts.status}`
          : "proposed",
      titleKey: "sessionID",
      meta: [
        ["status", "status"],
        ["candidates", "candidates"],
      ],
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
      resultSummary: (facts) =>
        typeof facts.status === "string" ? facts.status : "applied",
      titleKey: "generationID",
      meta: [["status", "status"]],
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
        // The scope is the daemon's, not this workspace's: a staged build
        // replaces the BINARY, so every workspace's runtime dies with the
        // swap — and the drain that runs is `daemon.drain` on the facade,
        // which drains every workspace (see workspace-manager's
        // drainForUpdate). This runtime's own drain is what THIS process
        // can establish directly; the facade's is what the daemon's RPC
        // reaches, and the switch's caller (the daemon) is the one holding
        // it. So the drain handed to the switch is the local one, and the
        // ANSWER names which drain ran, because a switch that claims a
        // quiet it did not establish is the lie this whole path exists to
        // prevent.
        drain: async () => {
          await waitForDrain(ctx.ports, {
            timeoutMs: 120_000,
            log: logOf(ctx.state.serviceDirectory),
          });
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
      // Instrumented (audit 缺口 4: the seams that can fail). A failed switch
      // returned only to the model, which is the one reader that cannot
      // investigate — the operator's log had nothing. The stage is the answer
      // to "where did it stop", the verdict's failing checks are the answer to
      // "why", and both carry the candidate so two switches can be told apart.
      // The OPERATION log, not the perf helper: the perf helper is silent
      // unless NATALIA_PERF_VERBOSE=1, and a switch that did not take is not a
      // timing observation — it must be there at the default level.
      const log = logOf(ctx.state.serviceDirectory);
      const fields = {
        candidateID: args.candidateID,
        stage: result.stage,
        verdict: result.verdict.verdict,
        failedChecks: result.verdict.checks
          .filter((check) => !check.ok)
          .map((check) =>
            check.detail ? `${check.check}: ${check.detail}` : check.check,
          ),
        ...(result.detail ? { detail: result.detail } : {}),
      };
      if (result.switched || result.stage === "rolled-back")
        log.info("generation-switch", "applied", fields);
      else log.error("generation-switch", "did not take", fields);
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
      resultSummary: (facts) =>
        typeof facts.status === "string"
          ? `rolled back · ${facts.status}`
          : "rolled back",
      titleKey: "generationID",
      meta: [["status", "status"]],
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
      resultSummary: (facts) =>
        typeof facts.status === "string"
          ? `cancelled · ${facts.status}`
          : "cancelled",
      titleKey: "generationID",
      meta: [["status", "status"]],
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
      // What the call FOUND, because "listed" tells a reader nothing.
      resultSummary: (facts) =>
        typeof facts.candidates === "string"
          ? `${facts.candidates} candidate${facts.candidates === "1" ? "" : "s"}`
          : "no candidates",
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
  const landed = installStagedBuild({
    home,
    version: source.version,
    files,
    // Windows has no service manager: the process running the old code has
    // to hand over to the new one, or the swap lands and nothing changes.
    // POSIX leaves this absent and lets `restartUnit` cover it — which the
    // installer's own update path already passes.
    ...(process.platform === "win32"
      ? { relaunch: () => relaunchSelf(home, source.version) }
      : {}),
  });
  if (landed.outcome === "rolled_back")
    throw new Error(
      `the staged build failed its self-check and was rolled back: ${landed.reason}`,
    );
  if (landed.outcome === "failed")
    throw new Error(`the staged build could not be landed: ${landed.reason}`);

  // The baseline, updated AFTER the probe succeeded.
  //
  // This is the half that makes self-iteration more than a one-way trip:
  // without it the next iteration copies the PREVIOUS baseline and this
  // generation's work silently does not exist for it. It lands after the
  // probe because a build that failed its self-check must not advance the
  // baseline — the ordering is the atomicity, and a throw here leaves the
  // binary new while the baseline is old, which the caller is told about
  // rather than left to discover.
  if (source.sourceArtifact) {
    const sourceManifest = JSON.parse(
      new TextDecoder().decode(await store.get(source.sourceArtifact)),
    ) as { files: Array<{ path: string; next: string }> };
    const baselineDir = join(home, "source");
    await mkdir(baselineDir, { recursive: true });
    let written = 0;
    for (const file of sourceManifest.files) {
      const content = Buffer.from(await store.get(file.next));
      const target = resolve(baselineDir, file.path);
      if (!target.startsWith(resolve(baselineDir)))
        throw new Error(
          `baseline update refused: ${file.path} escapes the baseline directory`,
        );
      await mkdir(dirname(target), { recursive: true });
      await writeFile(target, content);
      written += 1;
    }
    ctx.ports.publish({
      type: "diagnostic",
      level: "info",
      owner: "natalia-generations",
      message:
        `baseline updated to ${source.version}: ${written} source file(s) ` +
        `written to ${baselineDir}`,
    });
  }
}

/**
 * Directories a build produces that are not part of the built product.
 * `dist` is skipped for a SOURCE root (it is build output) and kept for a
 * BUILD root (it IS the product) — the caller passes which it is walking.
 */
const BUILD_SKIP = new Set([
  "node_modules",
  ".git",
  ".bun",
  ".bun-local",
  ".bun-scratch",
  "coverage",
  ".natalia",
]);

type StagedFile = { name: string; content: string; hash: string };

function hashOf(bytes: Uint8Array): string {
  return createHash("sha256").update(bytes).digest("hex");
}

/** Every file under a directory, as store-ready records. */
async function collectStagedFiles(
  root: string,
  prefix = "",
): Promise<{ files: StagedFile[]; count: number }> {
  const files: StagedFile[] = [];
  let count = 0;
  for (const entry of await readdir(root, { withFileTypes: true })) {
    if (BUILD_SKIP.has(entry.name)) continue;
    const from = join(root, entry.name);
    const name = prefix ? `${prefix}/${entry.name}` : entry.name;
    if (entry.isDirectory()) {
      const nested = await collectStagedFiles(from, name);
      files.push(...nested.files);
      count += nested.count;
      continue;
    }
    if (!entry.isFile()) continue;
    const bytes = await readFile(from);
    files.push({
      name,
      content: Buffer.from(bytes).toString("base64"),
      hash: hashOf(bytes),
    });
    count += 1;
  }
  return { files, count };
}

/**
 * `propose_code_generation` — the tool that closes the L3 loop.
 *
 * Before this, nothing produced a generation carrying a `source`: the two
 * `buildGeneration` callers passed none, so the `staged-build` lane above
 * was built and unreachable — a session could edit the source copy and
 * build it, and then have nowhere to put the result.
 *
 * It carries TWO payloads, because a self-iteration that landed only the
 * binary would be a one-way trip:
 *
 *   1. the BUILT artifacts — what `installStagedBuild` stages, swaps and
 *      probes, so the running process becomes the new code;
 *   2. the SOURCE state — the baseline the next iteration copies. Without
 *      it, iteration N+1 starts from the pre-N baseline and N's work
 *      silently does not exist for it.
 *
 * Both go into the object store (content-addressed), so the generation
 * stays self-contained and outlives the sandbox it was built in. The
 * four-face gate and the atomic swap are `apply_generation`'s job; this
 * tool only PROPOSES.
 */
export function createProposeCodeGenerationTool(
  ctx: RuntimeContext,
): RuntimeTool {
  return {
    name: "propose_code_generation",
    description:
      "Propose a self-iteration generation from a BUILT tree: it stores the build " +
      "artifacts (what the swap stages and probes) AND the source state (what the " +
      "next iteration copies) in the object store, and assembles a staged-build " +
      "candidate. Returns the candidateID for apply_generation. Call it AFTER the " +
      "build and tests pass in the source-copy workspace — a candidate built from " +
      "an unverified tree lands an unverified binary.",
    requiresApproval: true,
    timeoutSec: 600,
    parameters: {
      type: "object",
      properties: {
        buildDir: {
          type: "string",
          description:
            "The built distribution directory (the one holding natalia.exe and plugins/). Absolute, or relative to the workspace root.",
        },
        version: {
          type: "string",
          description: "The version this build reports, e.g. 0.0.0-m14.",
        },
        sourceRoot: {
          type: "string",
          description:
            "The source tree the build was made from. Defaults to the workspace root; pass it when the build ran elsewhere.",
        },
        note: { type: "string" },
      },
      required: ["buildDir", "version"],
      additionalProperties: false,
    },
    output: genericToolCard({
      family: "generation",
      callSummary: "propose_code",
      resultSummary: (facts) =>
        typeof facts.version === "string"
          ? `proposed ${facts.version} · ${facts.buildFiles ?? 0} file(s)`
          : "proposed",
      titleKey: "candidateID",
      meta: [
        ["version", "version"],
        ["buildFiles", "build files"],
        ["sourceFiles", "source files"],
      ],
    }),
    async execute(input) {
      const args = input as {
        buildDir: string;
        version: string;
        sourceRoot?: string;
        note?: string;
      };
      const buildDir = resolve(
        workspaceRoot(ctx),
        requireStringArg(args.buildDir, "buildDir"),
      );
      const version = requireStringArg(args.version, "version");
      const sourceRoot = resolve(workspaceRoot(ctx), args.sourceRoot ?? ".");
      const note = args.note;

      const buildStats = await stat(buildDir).catch(() => undefined);
      if (!buildStats?.isDirectory())
        throw new Error(
          `propose_code_generation: ${buildDir} is not a directory — build first, then propose the result`,
        );

      // The build artifacts: everything the swap needs.
      const build = await collectStagedFiles(buildDir);
      if (build.count === 0)
        throw new Error(
          `propose_code_generation: ${buildDir} holds no files — nothing to land`,
        );
      // The source state: what the next iteration copies. `dist` is build
      // output for a source root, so it is skipped there.
      const source = await collectStagedFiles(sourceRoot);
      if (source.files.length === 0)
        throw new Error(
          `propose_code_generation: ${sourceRoot} holds no source — the next ` +
            `iteration would copy an empty baseline`,
        );

      const store = objectStore(ctx);
      const artifact = await store.put(
        Buffer.from(JSON.stringify({ version, files: build.files })),
      );
      const sourceArtifact = await store.put(
        Buffer.from(
          JSON.stringify({
            files: source.files.map((file) => ({
              path: file.name,
              next: file.hash,
            })),
          }),
        ),
      );

      const live = ctx.ports.getTsRuntimeConfig();
      if (!live)
        throw new Error(
          "propose_code_generation: no running config to propose against",
        );
      const candidate = buildGeneration({
        config: live,
        catalog: ctx.ports
          .getPluginsController()
          .catalog()
          .map((entry) => ({ ...entry })),
        policyRows: activeConstitutionRows(ctx),
        prompts: generationPrompts(workspaceRoot(ctx)),
        rows: generationAdapterRows(ctx),
        source: {
          kind: "staged-build",
          version,
          artifact,
          // The source state rides with the build: the landing updates the
          // baseline atomically with the swap, or the next iteration starts
          // from the previous one and this work is lost to it.
          sourceArtifact,
        },
      });
      const candidateID = await storeGeneration(store, candidate);
      ctx.ports.publish({
        type: "composition.proposed",
        candidateID,
        reason: note ?? `code: ${version}`,
      });

      return JSON.stringify(
        {
          ok: true,
          candidateID,
          version,
          artifact,
          sourceArtifact,
          buildFiles: build.count,
          sourceFiles: source.files.length,
          next:
            `call apply_generation with candidateID ${candidateID} — the four-face ` +
            `gate runs, the turn drains, the binary is swapped and probed, and the ` +
            `baseline is updated with the source state. A failed probe rolls the ` +
            `swap back.`,
        },
        null,
        2,
      );
    },
  };
}

/** A string argument, with the tool's name in the refusal. */
function requireStringArg(value: unknown, name: string): string {
  if (typeof value !== "string" || value.trim().length === 0)
    throw new Error(`propose_code_generation: ${name} is required`);
  return value;
}

/**
 * Hand this process over to the version just landed.
 *
 * The new binary is spawned detached with the same arguments this process
 * was started with, and then this process exits. Detached matters: the
 * child must outlive the parent's exit, and inheriting the console would
 * take it down with it. The parent's exit code is 0 on purpose — the
 * switch SUCCEEDED, and a supervisor reading a failure would roll back a
 * build that just passed its probe.
 *
 * The spawn failure is reported rather than swallowed: a relaunch that
 * silently did nothing leaves the new binary linked while the old code
 * keeps running, which is the exact failure this exists to prevent.
 */
function relaunchSelf(
  home: string,
  version: string,
): {
  code: number;
  output: string;
} {
  const target = join(home, "versions", version, "natalia.exe");
  if (!existsSync(target))
    return { code: 1, output: `no landed binary at ${target}` };
  try {
    const child = spawn(target, process.argv.slice(2), {
      detached: true,
      stdio: "ignore",
    });
    child.unref();
    // The exit is deferred one turn: the caller's `switched` answer has to
    // reach the journal before the process that would write it is gone.
    setTimeout(() => process.exit(0), 50).unref();
    return { code: 0, output: `spawned ${target}` };
  } catch (error) {
    return {
      code: 1,
      output: error instanceof Error ? error.message : String(error),
    };
  }
}
