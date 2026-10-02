/**
 * Lightweight Markdown plan document runtime — runtime/collaboration/
 * plan-doc-runtime.ts.
 *
 * Replaces the former C4 plan APIs. The workspace `.natalia/plans/` directory
 * owns the Markdown source files; `index.json` is the small registry that maps
 * planID → documentPath → lifecycle status. The runtime publishes plan.doc.*
 * events so session projections and the UI can stay in sync.
 *
 * Read-only: this module only writes `.natalia/plans/` plan documents and the
 * index. It never touches project source, shell, sandbox or checkpoints.
 */
import { readFileSync } from "node:fs";
import { mkdir, readFile, rm, stat, writeFile } from "node:fs/promises";
import { isAbsolute, join, relative, resolve } from "node:path";
import { RuntimeInvalidParams } from "@anthelia/contracts";
import type { RuntimeServiceClient } from "@anthelia/runtime-services";
import { sessionStoreController } from "@anthelia/session-store";
import { workLedgerController } from "@natalia/work-ledger";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import type { SessionStoreController } from "@anthelia/session-store";
import type { WorkLedgerController } from "@natalia/work-ledger";
import { logOf } from "@anthelia/operation-log";

// The port contract moved to @anthelia/substrate (P3): one definition,
// at the port. Callers importing PlanDocRuntime/PlanDocRecord from here
// are re-exporting the engine's shape.
export type { PlanDocRuntime, PlanDocRecord } from "@anthelia/substrate";
import type { PlanDocRuntime, PlanDocRecord } from "@anthelia/substrate";

type IndexEntry = PlanDocRecord;

const PLAN_DIR = ".natalia/plans";

function planRoot(ctx: RuntimeContext) {
  return resolve(ctx.ports.getWorkspaceRoot(), PLAN_DIR);
}

async function readIndex(
  ctx: RuntimeContext,
): Promise<Record<string, IndexEntry>> {
  try {
    const raw = await readFile(join(planRoot(ctx), "index.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, IndexEntry>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

function readIndexSync(ctx: RuntimeContext): Record<string, IndexEntry> {
  try {
    const raw = readFileSync(join(planRoot(ctx), "index.json"), "utf8");
    const parsed = JSON.parse(raw) as Record<string, IndexEntry>;
    return parsed ?? {};
  } catch {
    return {};
  }
}

async function writeIndex(
  ctx: RuntimeContext,
  entries: Record<string, IndexEntry>,
) {
  const root = planRoot(ctx);
  await mkdir(root, { recursive: true });
  await writeFile(
    join(root, "index.json"),
    JSON.stringify(entries, null, 2),
    "utf8",
  );
}

function ensurePlanPath(ctx: RuntimeContext, inputPath: string) {
  if (!inputPath || typeof inputPath !== "string")
    throw new RuntimeInvalidParams("plan document path is required");
  const rootPath = planRoot(ctx);
  const root = rootPath + "/";

  if (isAbsolute(inputPath)) {
    const resolved = resolve(inputPath);
    if (resolved !== rootPath && !resolved.startsWith(root))
      throw new RuntimeInvalidParams(
        `plan document path must be under ${PLAN_DIR}: ${inputPath}`,
      );
    return resolved;
  }

  // Accept both plan-dir-relative names ("neon-plan.md") and workspace
  // paths (".natalia/plans/neon-plan.md", "natalia/plans/neon-plan.md").
  const normalizedInput = inputPath
    .trim()
    .replace(/^[.\/]*natalia\/plans[\/]*/u, "")
    .replace(/^\.natalia[\/]plans[\/]*/u, "")
    .replace(/^[\/]+/u, "");
  const resolved = resolve(rootPath, normalizedInput);
  if (resolved !== rootPath && !resolved.startsWith(root))
    throw new RuntimeInvalidParams(
      `plan document path is outside ${PLAN_DIR}: ${inputPath}`,
    );
  return resolved;
}

function normalizeSlashes(value: string) {
  return value.split(/[\\/]/u).join("/");
}

function relativePlanPath(ctx: RuntimeContext, absolute: string) {
  return normalizeSlashes(relative(planRoot(ctx), absolute));
}

function planIDForPath(path: string) {
  const basename = path.split(/[\\/]/u).pop() ?? "plan";
  const slug = basename
    .replace(/\.md$/iu, "")
    .replace(/[^a-z0-9_-]+/giu, "-")
    .replace(/^-+|-+$/gu, "")
    .toLowerCase();
  return `plan_${slug || "doc"}`;
}

/**
 * Resolve the plan activated in this session. Document existence/status stays
 * workspace-level; only the pointer is session-scoped.
 */
export function activePlanForExec(
  ctx: RuntimeContext,
  exec?: SessionExecutionState,
): PlanDocRecord | undefined {
  const planID = exec?.session?.metadata?.activePlanID;
  if (typeof planID !== "string" || planID.length === 0) return undefined;
  return ctx.ports.planDocRuntime.planDocByID(planID);
}

export function createPlanDocRuntime(ctx: RuntimeContext): PlanDocRuntime {
  function requireWorkLedger() {
    return ctx.state.serviceDirectory.get(workLedgerController);
  }

  function sessionExec(sessionID?: string) {
    if (sessionID)
      return ctx.ports
        .getExecutionBySession()
        .get(sessionID as import("@anthelia/contracts").SessionID);
    return ctx.ports.getActiveExec();
  }

  function publish(
    event: import("@anthelia/contracts").RuntimeEvent,
    sessionID?: string,
  ) {
    ctx.ports.publishForSession(sessionExec(sessionID), event);
  }

  async function updateActivePlanID(
    planID: string | undefined,
    sessionID?: string,
  ): Promise<{ planID?: string; updated: boolean }> {
    let exec = sessionExec(sessionID);
    if (!exec && sessionID)
      exec = await ctx.ports.ensureExecution(
        sessionID as import("@anthelia/contracts").SessionID,
      );
    if (!exec) return { updated: false };
    const store = ctx.state.serviceDirectory.getOptional(
      sessionStoreController,
    );
    if (!store)
      throw new Error("session store unavailable (natalia-session-store)");
    const metadata = { ...exec.session.metadata };
    if (planID) metadata.activePlanID = planID;
    else delete metadata.activePlanID;
    exec.session.metadata = metadata;
    await store.updateMetadata(exec.session, { activePlanID: planID });
    return { ...(planID ? { planID } : {}), updated: true };
  }

  return {
    async planDocList(_sessionID?: string) {
      await ctx.ports.getReady();
      const entries = await readIndex(ctx);
      return Object.values(entries);
    },

    async planDocRead(input) {
      await ctx.ports.getReady();
      const entries = await readIndex(ctx);
      const record =
        (input.planID && entries[input.planID]) ||
        (input.path &&
          Object.values(entries).find(
            (entry) =>
              entry.documentPath === normalizeSlashes(input.path ?? ""),
          )) ||
        undefined;
      const targetPath = record
        ? ensurePlanPath(ctx, record.documentPath)
        : ensurePlanPath(ctx, input.path ?? "");
      let content: string;
      try {
        content = await readFile(targetPath, "utf8");
      } catch {
        throw new RuntimeInvalidParams(
          `plan document not found: ${record?.documentPath ?? input.path ?? ""}`,
        );
      }
      return {
        ...(record ? { planID: record.planID } : {}),
        ...(record ? { title: record.title } : {}),
        documentPath: record
          ? record.documentPath
          : normalizeSlashes(input.path ?? ""),
        content,
      };
    },

    async planDocWrite(input) {
      await ctx.ports.getReady();
      const targetPath = ensurePlanPath(ctx, input.path);
      await mkdir(join(targetPath, ".."), { recursive: true });
      await writeFile(targetPath, input.content, "utf8");
      // EI §3.4: an edit to an already-marked plan bumps its revision and
      // publishes `plan.doc.updated`, so a WorkContract draft extracted from
      // the older revision is marked stale and must be re-proposed. A write to
      // a not-yet-marked file only creates the Markdown source (no registry
      // entry to version yet).
      const documentPath = relativePlanPath(ctx, targetPath);
      const entries = await readIndex(ctx);
      const existing = Object.values(entries).find(
        (entry) => entry.documentPath === documentPath,
      );
      if (existing) {
        const now = new Date().toISOString();
        const revision = (existing.revision ?? 1) + 1;
        existing.revision = revision;
        existing.updatedAt = now;
        entries[existing.planID] = existing;
        await writeIndex(ctx, entries);
        publish(
          requireWorkLedger().buildPlanDocUpdated({
            id: `${existing.planID}:updated:${revision}:${ctx.ports.nextPlanSequence()}`,
            planID: existing.planID,
            revision,
            updatedAt: now,
          }),
          input.sessionID,
        );
        return { written: true, planID: existing.planID };
      }
      return { written: true, planID: input.planID };
    },

    async planDocMark(input) {
      await ctx.ports.getReady();
      const targetPath = ensurePlanPath(ctx, input.path);
      let target;
      try {
        target = await stat(targetPath);
      } catch {
        throw new RuntimeInvalidParams(
          `plan document does not exist: ${input.path}`,
        );
      }
      if (!target.isFile())
        throw new RuntimeInvalidParams(
          `plan document is not a file: ${input.path}`,
        );
      const entries = await readIndex(ctx);
      const existing = Object.values(entries).find(
        (entry) => entry.documentPath === relativePlanPath(ctx, targetPath),
      );
      if (existing) return { marked: true, planID: existing.planID };
      const planID = `${planIDForPath(relativePlanPath(ctx, targetPath))}_${Date.now().toString(36)}`;
      const now = new Date().toISOString();
      const record: IndexEntry = {
        planID,
        title: input.title?.trim() || planID,
        documentPath: relativePlanPath(ctx, targetPath),
        status: "marked",
        // EI §8.1: the source that marked the plan, not a hardcoded user —
        // a plan drafted by Navi through the Live Work Chat is createdBy
        // live_chat, and one drafted by the main agent is main_agent.
        createdBy: input.createdBy ?? "user",
        createdAt: now,
        updatedAt: now,
        // EI §3.4: the plan document starts at revision 1; every later write
        // bumps it, and a WorkContract draft binds to the revision it was
        // extracted from (its planVersion).
        revision: 1,
        markedAt: now,
      };
      entries[planID] = record;
      await writeIndex(ctx, entries);
      publish(
        requireWorkLedger().buildPlanDocCreated({
          id: `${planID}:created:${ctx.ports.nextPlanSequence()}`,
          planID,
          title: record.title,
          documentPath: record.documentPath,
          createdBy: record.createdBy,
          status: record.status,
          createdAt: record.createdAt,
        }),
        input.sessionID,
      );
      return { marked: true, planID };
    },

    async planDocDelete(planID, sessionID?) {
      await ctx.ports.getReady();
      const entries = await readIndex(ctx);
      if (!entries[planID]) return { deleted: false };
      const record = entries[planID];
      delete entries[planID];
      await writeIndex(ctx, entries);
      if (record?.documentPath) {
        try {
          await rm(ensurePlanPath(ctx, record.documentPath), { force: true });
        } catch (error) {
          // The registry entry is gone; a missing/unlinked Markdown file
          // should not make delete look like a failure.
          logOf(ctx.state.serviceDirectory).warn(
            "plan-doc",
            "delete Markdown file failed",
            { error },
          );
        }
      }
      try {
        publish(
          {
            type: "plan.doc.deleted",
            id: `${planID}:deleted:${ctx.ports.nextPlanSequence()}`,
            planID,
            deletedAt: new Date().toISOString(),
          },
          sessionID,
        );
      } catch (error) {
        // Deletion from the registry already succeeded; a projection event
        // failure should not make the RPC call look like it failed.
        logOf(ctx.state.serviceDirectory).warn(
          "plan-doc",
          "delete event publish failed",
          { error },
        );
      }
      return { deleted: true };
    },

    async planDocStatus(planID, _sessionID?) {
      await ctx.ports.getReady();
      const entries = await readIndex(ctx);
      const record = entries[planID];
      return { status: record?.status ?? "unmarked" };
    },

    planDocSnapshot() {
      return Object.values(readIndexSync(ctx));
    },

    planDocByID(planID) {
      return readIndexSync(ctx)[planID];
    },

    async planDocActive(sessionID?) {
      await ctx.ports.getReady();
      let exec = sessionExec(sessionID);
      if (!exec && sessionID)
        exec = await ctx.ports.ensureExecution(
          sessionID as import("@anthelia/contracts").SessionID,
        );
      const planID = exec?.session?.metadata?.activePlanID;
      return {
        ...(typeof planID === "string" && planID.length ? { planID } : {}),
      };
    },

    async planDocActivate(planID, sessionID?) {
      await ctx.ports.getReady();
      if (!planID || !readIndexSync(ctx)[planID]) return { updated: false };
      return await updateActivePlanID(planID, sessionID);
    },

    async planDocDeactivate(sessionID?) {
      await ctx.ports.getReady();
      return await updateActivePlanID(undefined, sessionID);
    },

    async planDocUpdateStatus(input) {
      await ctx.ports.getReady();
      const { planID, status, sessionID } = input;
      const entries = await readIndex(ctx);
      const record = entries[planID];
      if (!record) return { updated: false };
      const now = new Date().toISOString();
      const previousStatus = record.status;
      record.status = status;
      record.updatedAt = now;
      entries[planID] = record;
      await writeIndex(ctx, entries);
      logOf(ctx.state.serviceDirectory).info("plan-status", "updated", {
        planID,
        status,
        sessionID,
        previousStatus,
      });
      const statusID = `${planID}:status:${ctx.ports.nextPlanSequence()}`;
      publish(
        requireWorkLedger().buildPlanDocStatus({
          id: statusID,
          planID,
          status,
          at: now,
        }),
        sessionID,
      );
      // The status is a LIFECYCLE PROJECTION, never an audit request
      // (the 2026-09-25 convergence): the block that used to live here
      // wrote an audit.requested fact and woke Nia on every
      // awaiting_audit/auditing write — a COMPLETE second trigger running
      // parallel to the completion fact's one, so any caller that walked
      // both lines got two audit rounds (the dedupe keys differ). The
      // audit trigger has exactly one home now: the completion fact's
      // requestAuditAfterCompletion (which also projects awaiting_audit);
      // Nia's turn start projects auditing. Writing a status here writes a
      // status — tombstone in .kilo/plans/landing/plan-audit-line.
      return { updated: true };
    },
  };
}
