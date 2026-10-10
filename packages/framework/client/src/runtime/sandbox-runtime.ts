import { randomUUID } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";
import type {
  EpisodeID,
  SandboxDiffKind,
  SessionID,
} from "@anthelia/contracts";
import {
  sandboxService,
  type RuntimeServiceClient,
  type SandboxService,
} from "@anthelia/runtime-services";
import { workLedgerController } from "@natalia/work-ledger";
import { governanceLedgerController } from "@natalia/governance-ledger";
import { workspaceMutations } from "@anthelia/workspace";
import { detectPromoteCommand } from "@anthelia/sandbox";
import type { RuntimeContext } from "@anthelia/substrate";
import {
  ensureSessionEventWindow,
  sessionWindowEvents,
} from "@anthelia/substrate";
import {
  riskTierForChanges,
  riskTierForPath,
  SandboxPromotionConflict,
} from "@anthelia/sandbox";
import { captureRepositoryEvidenceFields } from "@anthelia/substrate";
import type { GovernanceLedgerController } from "@natalia/governance-ledger";
import type { WorkLedgerController } from "@natalia/work-ledger";

async function appendSandboxMutation(
  ctx: RuntimeContext,
  sessionID: string,
  path: string,
  operation: "add" | "modify" | "delete" | "rename",
) {
  try {
    const logPath = resolve(
      ctx.ports.getWorkspaceRoot(),
      ".natalia",
      "workspace-mutations.json",
    );
    await mkdir(dirname(logPath), { recursive: true });
    let rows: Array<Record<string, unknown>> = [];
    try {
      rows = JSON.parse(await readFile(logPath, "utf8")) as Array<
        Record<string, unknown>
      >;
    } catch {
      rows = [];
    }
    rows.push({
      id: `mut_${Date.now().toString(36)}`,
      at: new Date().toISOString(),
      workspaceRoot: ctx.ports.getWorkspaceRoot(),
      sessionID,
      path,
      operation,
      origin: "sandbox_merge",
    });
    await writeFile(logPath, JSON.stringify(rows, null, 2));
  } catch {
    // best-effort
  }
}

type SandboxRuntime = Pick<
  RuntimeServiceClient,
  | "sandboxList"
  | "sandboxDiff"
  | "sandboxResources"
  | "sandboxResourceOutput"
  | "sandboxMerge"
  | "sandboxDelete"
  | "sandboxRollback"
  | "sandboxResourceStop"
  // T6-2/T6-3 (F14): the conflict message names `sandbox_refresh`, so the
  // surface it points at has to exist.
  | "sandboxRefresh"
  | "sandboxResolveConflict"
>;

export function createSandboxRuntime(
  ctx: RuntimeContext,
  episodeID?: EpisodeID,
): SandboxRuntime {
  function requireSandboxes() {
    const sandboxes = ctx.state.serviceDirectory.get(sandboxService);
    if (!sandboxes) throw new Error("sandbox controller unavailable");
    return sandboxes;
  }

  function requireWorkLedger() {
    return ctx.state.serviceDirectory.get(workLedgerController);
  }

  function mutationRegistry() {
    return ctx.state.serviceDirectory.getOptional(workspaceMutations);
  }

  async function sessionOwner(sessionID?: string) {
    const owner = sessionID
      ? (ctx.ports.getExecutionBySession().get(sessionID as SessionID) ??
        (await ctx.ports.ensureExecution(sessionID as SessionID)))
      : ctx.ports.getActiveExec();
    if (!owner) throw new Error("session is not initialized");
    return owner;
  }

  async function sandboxIDsFor(
    owner: import("@anthelia/substrate").SessionExecutionState | undefined,
  ) {
    if (!owner?.session) return new Set<string>();
    const window = await ensureSessionEventWindow(ctx, owner);
    const events = window
      ? sessionWindowEvents(owner, window)
      : owner.session.events;
    return new Set(
      events
        .filter((event) => event.type === "sandbox.update")
        .map((event) => event.id),
    );
  }

  async function assertSandboxOwned(
    ctx: RuntimeContext,
    owner: import("@anthelia/substrate").SessionExecutionState,
    id: string,
  ) {
    if (!(await sandboxIDsFor(owner)).has(id))
      throw new Error(
        `sandbox ${id} does not belong to session ${owner.session.id}`,
      );
  }

  function requireGovernanceLedger() {
    const ledger = ctx.state.serviceDirectory.get(governanceLedgerController);
    if (!ledger)
      throw new Error(
        "governance ledger unavailable (natalia-governance-ledger)",
      );
    return ledger;
  }

  /**
   * The validation command a sandbox merge runs before it lands, in the one
   * honest order: the configured `sandbox.promoteCommand` wins; otherwise the
   * workspace's OWN project markers decide; with neither, the caller gets a
   * refusal that says what to set.
   *
   * The T-09 regression this replaces: the client path fell back to a
   * hardcoded `npm run typecheck` when nothing was configured, so a CMake/C
   * workspace was validated by a command whose package.json does not exist —
   * exit 254, no merge, and no honest reason. The detector is the same one
   * the sandbox tool family uses, so both surfaces agree.
   */
  function promoteCommand(): string {
    const configured = ctx.ports.getTsRuntimeConfig()?.sandbox.promoteCommand;
    const trimmed = configured?.trim();
    if (trimmed) return trimmed;
    const detected = detectPromoteCommand(ctx.ports.getWorkspaceRoot());
    if (detected) return detected.command;
    throw new Error(
      "sandbox_merge needs a validation command for this workspace: no " +
        "project marker (package.json, CMakeLists.txt, Cargo.toml, " +
        "pyproject.toml) was found under " +
        ctx.ports.getWorkspaceRoot() +
        ", and sandbox.promoteCommand is not configured. Set " +
        "sandbox.promoteCommand to the command that verifies this project, " +
        "or call sandbox_validate with an explicit command first.",
    );
  }

  return {
    async sandboxList(sessionID?: string) {
      await ctx.ports.getReady();
      const owner = sessionID
        ? await sessionOwner(sessionID)
        : ctx.ports.getActiveExec();
      const owned = await sandboxIDsFor(owner);
      return (await requireSandboxes().list())
        .filter((sandbox) => owned.has(sandbox.id))
        .map((sandbox) => ({
          id: sandbox.id,
          root: sandbox.root,
          isolationLevel: sandbox.isolationLevel,
          changedFiles: sandbox.changedFiles.length,
          runningResources: sandbox.runningResources.length,
          envAllowlist: sandbox.envAllowlist,
        }));
    },
    async sandboxDiff(
      id: string,
      sessionID?: string,
      options?: { includePatch?: boolean },
    ) {
      await ctx.ports.getReady();
      const owner = await sessionOwner(sessionID);
      await assertSandboxOwned(ctx, owner, id);
      const changes = await requireSandboxes().previewMerge(id);
      if (options?.includePatch === false) {
        return changes.map((change) => ({
          kind: change.kind,
          path: change.path,
          ...(change.oldPath ? { oldPath: change.oldPath } : {}),
          ...(change.mode ? { mode: change.mode } : {}),
          additions: 0,
          deletions: 0,
          ...(change.structured ? { structured: change.structured } : {}),
        }));
      }
      return changes;
    },
    async sandboxResources(id, sessionID?: string) {
      await ctx.ports.getReady();
      const owner = await sessionOwner(sessionID);
      await assertSandboxOwned(ctx, owner, id);
      return requireSandboxes().resourcesFor(id);
    },
    async sandboxResourceOutput(input: {
      id: string;
      resourceID: string;
      maxBytes?: number;
      sessionID?: string;
    }) {
      await ctx.ports.getReady();
      const owner = await sessionOwner(input.sessionID);
      await assertSandboxOwned(ctx, owner, input.id);
      return await requireSandboxes().resourceOutput(
        input.id,
        input.resourceID,
        input.maxBytes,
      );
    },
    async sandboxMerge(id, sessionID?) {
      await ctx.ports.getReady();
      const owner = await sessionOwner(sessionID);
      await assertSandboxOwned(ctx, owner, id);
      const sandboxes = requireSandboxes();
      await ctx.ports.authorizeSandboxManagement(
        "sandbox_merge",
        { id },
        owner,
      );
      const command = promoteCommand();
      const ledger = requireGovernanceLedger();
      const startedAt = performance.now();
      const taskID = `sandbox:${id}`;
      const objective = `promote sandbox ${id}`;
      const redact = (text: string) => ctx.ports.redactToolOutput(text, true);
      const publishPromotionEvidence = async (input: {
        status: "promoted" | "failed";
        result: "passed" | "failed";
        output: string;
        durationMs: number;
        changes?: Array<{ path: string; kind: SandboxDiffKind }>;
        knownGaps?: string[];
      }) => {
        const outcome = ledger.boundValidationOutcome({
          command: redact(command),
          result: input.result,
          safeSummary: redact(input.output),
          durationMs: input.durationMs,
        });
        // EI E2: a promotion is evidence like any other — stamp the same
        // repository refs as every other evidence writer.
        const repoRefs = await captureRepositoryEvidenceFields(
          ctx.ports.getWorkspaceRoot(),
        );
        const evidence = ledger.buildEvidenceRecorded({
          id: `evidence:${Date.now().toString(36)}:${ctx.ports.nextEvidenceSequence()}`,
          taskID,
          objective,
          status: input.status,
          changes: (input.changes ?? []).map((change) => ({
            path: change.path,
            changeType: evidenceChangeType(change.kind),
            summary: change.path,
          })),
          validations: [outcome],
          knownGaps: input.knownGaps,
          ...repoRefs,
        });
        ctx.ports.publishForSession(owner, evidence);
        return { evidence, outcome };
      };
      try {
        // EI E5 (R3/R4): compute the promotion's risk tier from the candidate's
        // real change set, and require a multi-stage confirmation for a
        // high-risk promotion — one that touches the tool contract, the
        // capability kernel or the plugin registry. A low/medium change clears
        // the single per-path constitution gate; a high-risk one gets an
        // explicit preview + confirm so a self-modifying agent cannot silently
        // rewrite its own contract. The tier is recorded as an audit fact.
        const preview = await sandboxes.previewMerge(id);
        const tier = riskTierForChanges(preview);
        // Naming the transition: the manifest can only say "has changes", so the
        // merge lifecycle is unreportable without an explicit status.
        ctx.ports.publishForSession(
          owner,
          sandboxes.updateEvent(id, "merge_previewed"),
        );
        ctx.ports.publishForSession(
          owner,
          sandboxes.auditEvent(id, "merge", tier === "high"),
        );
        if (tier === "high") {
          const highRiskPaths = preview
            .filter((change) => riskTierForPath(change.path) === "high")
            .map((change) => change.path);
          const response = await ctx.ports
            .getInteractive()
            .requirePlanAcceptance({
              approvalID: `sandbox_promotion:${id}:${Date.now().toString(36)}`,
              planID: id,
              title: `High-risk promotion: sandbox ${id}`,
              preview: highRiskPaths.join("\n"),
              detail:
                `This promotion touches ${highRiskPaths.length} high-risk path(s) ` +
                `(the tool contract, capability kernel or plugin registry):\n` +
                `${highRiskPaths.join("\n")}\n\nConfirm to proceed, or reject to leave the host unchanged.`,
              scope: "sandbox_promotion",
              sessionID: owner.session.id,
            });
          if (!response || response.decision === "reject") {
            await publishPromotionEvidence({
              status: "failed",
              result: "failed",
              output: "high-risk promotion rejected by the user",
              durationMs: performance.now() - startedAt,
              knownGaps: ["high-risk promotion not confirmed; host unchanged"],
            });
            throw new Error(
              `high-risk promotion of sandbox ${id} was rejected by the user`,
            );
          }
        }
        // ONE validation, run by the promotion gate itself INSIDE the
        // candidate. This used to run the same command once more before the
        // preview, which paid for the gate twice and — worse — left the first
        // run's build output in the candidate, where the gate's own artifact
        // cleanup (keyed on what appeared after ITS OWN before-capture) could
        // no longer tell it from the model's change: a promotion then merged
        // artifacts the validation had produced. The gate's result rides back
        // on the promotion for the evidence record below.
        const promotion = await sandboxes.promoteWithValidation(id, {
          command,
          hostRoot: ctx.ports.getWorkspaceRoot(),
          authorize: async (paths) =>
            await ctx.ports.authorizeSandboxMerge({ id, paths }, owner),
        });
        const changes = promotion.changedFiles;
        const durationMs = performance.now() - startedAt;
        for (const change of changes) {
          void appendSandboxMutation(
            ctx,
            owner.session.id,
            change.path,
            change.kind === "add"
              ? "add"
              : change.kind === "delete"
                ? "delete"
                : change.kind === "rename"
                  ? "rename"
                  : "modify",
          );
        }
        const operationID = `sandbox_merge:${id}:${randomUUID()}`;
        mutationRegistry()?.register({
          sessionID: owner.session.id,
          episodeID,
          operationID,
          toolName: "sandbox_merge",
          authorizedPaths: ["."],
          expectedOperations: ["added", "modified", "deleted"],
        });
        for (const change of changes) {
          ctx.ports.publishForSession(
            owner,
            requireWorkLedger().workspaceChangeNode({
              operationID,
              path: change.path,
              toolName: "sandbox_merge",
              sessionID: owner.session.id,
            }),
          );
        }
        mutationRegistry()?.settle(operationID);
        ctx.ports.publishForSession(owner, sandboxes.updateEvent(id, "merged"));
        ctx.ports.publishForSession(owner, sandboxes.auditEvent(id, "merge"));
        const { evidence, outcome } = await publishPromotionEvidence({
          status: "promoted",
          result: "passed",
          // The gate's own output, from the one run it did.
          output: promotion.validation.output,
          durationMs,
          changes,
        });
        ctx.ports.publishForSession(
          owner,
          ledger.buildCompletionRecorded({
            id: `completion:${Date.now().toString(36)}:${ctx.ports.nextCompletionSequence()}`,
            taskID,
            objective,
            changeSummary: `${changes.length} files promoted from sandbox ${id}`,
            validations: [outcome],
            // Derived from what the promotion actually left behind. Claiming
            // "available" as a constant described a rollback point nobody had
            // checked for, and there is no entry point that could act on one.
            rollbackState: promotion.lastKnownGood ? "available" : "none",
            evidenceIDs: [evidence.id],
            recordedAt: new Date().toISOString(),
          }),
        );
        await announcePromotionFollowUp(
          ctx,
          changes.map((change) => change.path),
        );
        return changes;
      } catch (error) {
        // A conflict is a state, not just a failure: the candidate needs
        // rebasing, and the sandbox itself is what says so. Reported before the
        // evidence record so a consumer watching status sees it either way.
        if (error instanceof SandboxPromotionConflict)
          ctx.ports.publishForSession(
            owner,
            sandboxes.updateEvent(id, "conflicted"),
          );
        await publishPromotionEvidence({
          status: "failed",
          result: "failed",
          output: error instanceof Error ? error.message : String(error),
          durationMs: performance.now() - startedAt,
          knownGaps: [
            error instanceof SandboxPromotionConflict
              ? `promotion refused; host unchanged, candidate must be rebased ` +
                `(${error.paths.length} conflicting path(s))`
              : // The gate's own refusal, named: the promotion is what runs
                // the validation now, so a failed check arrives as its error.
                "candidate failed validation; host unchanged",
          ],
        });
        throw error;
      }
    },
    /**
     * Brings a candidate up to date with the host's newer commits (T6-2/F14).
     *
     * Exposed because the conflict message NAMES it: `SandboxPromotionConflict`
     * tells a caller that on a git workspace the worktree backend "can refresh a
     * candidate instead, with `sandbox_refresh`" — and until now there was no
     * such surface, so the guidance pointed at a name the model could not call.
     *
     * It mutates the CANDIDATE (a merge of the host's head into it), never the
     * host, so it clears the same management gate a sandbox write does rather
     * than the promotion's.
     */
    async sandboxRefresh(id: string, sessionID?: string) {
      await ctx.ports.getReady();
      const owner = await sessionOwner(sessionID);
      await assertSandboxOwned(ctx, owner, id);
      await ctx.ports.authorizeSandboxManagement(
        "sandbox_refresh",
        { id },
        owner,
      );
      const controller =
        requireSandboxes() as typeof requireSandboxes extends () => infer T
          ? T
          : never;
      if (typeof controller.refresh !== "function")
        return {
          refreshed: false,
          conflicted: false,
          reason:
            "this workspace is not a git repository: a snapshot candidate has " +
            "no branch to refresh. Delete it and create a new one from the " +
            "current host.",
        };
      return await controller.refresh(id);
    },

    /**
     * Clears a conflicted candidate (T6-3/F14): take the resolution (write the
     * content per path and commit it) or rebase (re-derive the merge against a
     * named base). Both leave the candidate on a clean commit, so a promotion
     * afterwards is an ordinary promotion.
     */
    async sandboxResolveConflict(
      id: string,
      resolution:
        | { kind: "resolve"; contents: Record<string, string> }
        | { kind: "rebase"; base?: string },
      sessionID?: string,
    ) {
      await ctx.ports.getReady();
      const owner = await sessionOwner(sessionID);
      await assertSandboxOwned(ctx, owner, id);
      // It writes into the candidate and commits, so it clears the same gate a
      // sandbox write does — never the promotion's.
      await ctx.ports.authorizeSandboxManagement(
        "sandbox_resolve_conflict",
        { id },
        owner,
      );
      const controller = requireSandboxes();
      if (typeof controller.resolveConflict !== "function")
        return {
          refreshed: false,
          conflicted: false,
          reason:
            "this workspace is not a git repository: a snapshot candidate has " +
            "no merge to resolve. Delete it and create a new one from the " +
            "current host.",
        };
      return await controller.resolveConflict(id, resolution);
    },

    async sandboxRollback(id, sessionID?) {
      await ctx.ports.getReady();
      const owner = await sessionOwner(sessionID);
      await assertSandboxOwned(ctx, owner, id);
      const sandboxes = requireSandboxes();
      // It rewrites host files, so it clears the same gate as the merge it
      // undoes rather than a weaker one.
      const preview = await sandboxes.previewMerge(id);
      await ctx.ports.authorizeSandboxMerge(
        { id, paths: preview.map((change) => change.path) },
        owner,
      );
      const result = await sandboxes.rollback(id);
      if (result.restored) {
        ctx.ports.publishForSession(owner, sandboxes.updateEvent(id));
        ctx.ports.publishForSession(
          owner,
          sandboxes.auditEvent(id, "rollback"),
        );
      }
      return result;
    },
    async sandboxDelete(id, sessionID?) {
      await ctx.ports.getReady();
      const owner = await sessionOwner(sessionID);
      await assertSandboxOwned(ctx, owner, id);
      const sandboxes = requireSandboxes();
      await ctx.ports.authorizeSandboxManagement(
        "sandbox_delete",
        { id },
        owner,
      );
      const result = await sandboxes.delete(id);
      ctx.ports.publishForSession(owner, {
        type: "sandbox.update",
        id,
        status: "deleted",
        root: "",
        isolationLevel: "workspace",
        changedFiles: result.pendingChanges.length,
        runningResources: result.runningResources.length,
        target: { kind: "host", cwd: ctx.ports.getWorkspaceRoot() },
        resourcePolicy: "sandbox deleted after resource cleanup",
      });
      return result;
    },
    async sandboxResourceStop(input: {
      id: string;
      resourceID: string;
      sessionID?: string;
    }) {
      await ctx.ports.getReady();
      const owner = await sessionOwner(input.sessionID);
      await assertSandboxOwned(ctx, owner, input.id);
      const sandboxes = requireSandboxes();
      await ctx.ports.authorizeSandboxManagement(
        "sandbox_resource_stop",
        input,
        owner,
      );
      const resource = await sandboxes.stopResource(input.id, input.resourceID);
      ctx.ports.publishForSession(owner, sandboxes.updateEvent(input.id));
      ctx.ports.publishForSession(
        owner,
        sandboxes.auditEvent(input.id, "resource_stop"),
      );
      return resource;
    },
  };
}

function evidenceChangeType(
  kind: SandboxDiffKind,
): "added" | "modified" | "deleted" {
  if (kind === "add") return "added";
  if (kind === "delete") return "deleted";
  return "modified";
}

async function announcePromotionFollowUp(ctx: RuntimeContext, paths: string[]) {
  const frameworkTouched = paths.some(
    (path) =>
      path.startsWith("packages/framework/") || path.startsWith("apps/cli/"),
  );
  if (frameworkTouched) {
    ctx.ports.publish({
      type: "diagnostic",
      level: "warning",
      message: "restart_required",
    });
    return;
  }
  const families = new Set(
    paths
      .map((path) => {
        const match = /^packages\/plugins\/tools\/([^/]+)\//u.exec(path);
        return match?.[1];
      })
      .filter((family): family is string => Boolean(family)),
  );
  for (const family of families) {
    try {
      await ctx.ports.hotReloadToolFamily(family);
    } catch {
      ctx.ports.publish({
        type: "diagnostic",
        level: "warning",
        message: `tool family reload failed: ${family}`,
      });
    }
  }
}
