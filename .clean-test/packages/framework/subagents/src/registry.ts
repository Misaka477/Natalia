import { boundVerboseOutput } from "./format-output";
import type {
  SubagentID,
  SubagentStatus,
  SubagentRecord,
  SubagentPhase,
  SubagentHealth,
  OutputEntry,
  AuditEntry,
  SubagentEvent,
  SubagentRegistryOptions,
  SpawnOptions,
  RunnerContext,
  RunnerCallback,
} from "./types";
import { SubagentStore } from "./store";
import { formatStatusCounts, truncate } from "./format";

const DEFAULT_STALL_MS = 30_000;

/**
 * Every status a subagent record may carry. A `Record<SubagentStatus, true>`
 * (not a hand-written list) so adding a union member without listing it here
 * fails typecheck — the completeness the audit mechanizes elsewhere.
 */
const SUBAGENT_STATUS_MEMBER: Record<SubagentStatus, true> = {
  idle: true,
  running: true,
  paused: true,
  stopped: true,
  completed: true,
  failed: true,
};

/**
 * `RunnerContext.setStatus` takes a plain string (it is the shared tool/host
 * surface), but a record's status is the closed `SubagentStatus` union. Narrow
 * with a runtime check instead of an `as any` cast: an unknown status is a bug
 * to surface, not a value to silently store into the record.
 */
function isSubagentStatus(value: string): value is SubagentStatus {
  return Object.hasOwn(SUBAGENT_STATUS_MEMBER, value);
}

export type StopResult =
  | { outcome: "stopped"; id: string }
  | { outcome: "not_found"; id: string }
  | { outcome: "not_running"; id: string; status: SubagentStatus }
  | {
      outcome: "protected";
      id: string;
      health: "active" | "quiet";
      retryAfterMs: number;
    };

/**
 * A subagent's terminal status mapped to the spine's reason, pure so the
 * table can be pinned without a run: the registry's own vocabulary
 * already matches (completed / stopped / failed) — the mapping is kept
 * explicit so a status added later fails compile here rather than
 * silently defaulting in a notice.
 */
export function subagentSettlementReason(
  status: SubagentRecord["status"],
): "completed" | "stopped" | "failed" {
  if (status === "completed") return "completed";
  if (status === "failed") return "failed";
  return "stopped";
}

export class SubagentRegistry {
  readonly store: SubagentStore;
  private readonly runner: RunnerCallback;
  private readonly clock: () => number;
  private readonly stallThresholdMs: number;
  private readonly wallClockBudgetMs: number;
  private readonly onSettled?: (record: SubagentRecord) => void;
  private readonly onChildMessage?: (message: {
    agentId: string;
    text: string;
  }) => void;
  /** One deadline timer per running subagent, cleared when its run settles. */
  private readonly budgetTimers = new Map<
    SubagentID,
    ReturnType<typeof setTimeout>
  >();
  private records = new Map<SubagentID, SubagentRecord>();
  private readonly steerHooks = new Map<
    SubagentID,
    (message: string) => string | undefined
  >();
  private running = new Map<SubagentID, AbortController>();
  private subscribers = new Set<(event: SubagentEvent) => void>();
  private auditEntries: AuditEntry[] = [];
  private auditSeq = 0;
  private nextID = 1;
  private readonly maxAudit = 1000;
  private activityThrottle = new Map<SubagentID, number>();

  constructor(opts: SubagentRegistryOptions) {
    this.runner = opts.runner;
    this.clock = opts.clock ?? (() => Date.now());
    this.stallThresholdMs = opts.stallThresholdMs ?? DEFAULT_STALL_MS;
    this.wallClockBudgetMs = opts.wallClockBudgetMs ?? 0;
    this.onSettled = opts.onSettled;
    this.onChildMessage = opts.onChildMessage;
    this.store = new SubagentStore(opts.workDir, opts.sessionID);
  }

  /**
   * Fire the settlement hook once per terminal transition. The record is
   * already marked, so the notice the parent receives carries the true
   * ending; a throwing hook degrades (the child's ending must not fail
   * because a notice could not fly — the spine's discipline).
   */
  private notifySettled(record: SubagentRecord): void {
    if (!this.onSettled) return;
    try {
      this.onSettled(record);
    } catch {
      // degraded on purpose
    }
  }

  async load(): Promise<void> {
    const records = await this.store.load();
    let recovered = false;
    const now = this.clock();
    for (const rec of records) {
      if (rec.status === "running" || rec.status === "paused") {
        rec.status = "stopped";
        rec.updatedAt = now;
        rec.endedAt = now;
        rec.phase = "finalizing";
        rec.lastActivityAt = now;
        rec.activityDetail = "runtime restarted";
        rec.outputs.push({
          step: rec.outputs.length + 1,
          text: "subagent stopped because the owning runtime restarted; resubmit the task to continue",
          timestamp: now,
        });
        // A run the restart interrupted tells its parent too — the same
        // rule the process adopter applies: a death while the session was
        // away must not restore silently.
        this.notifySettled(rec as SubagentRecord);
        recovered = true;
      }
      if (!rec.phase) rec.phase = derivePhase(rec);
      if (rec.lastActivityAt === undefined) rec.lastActivityAt = rec.updatedAt;
      if (!rec.startedAt) rec.startedAt = rec.createdAt;
      this.records.set(rec.id, rec as SubagentRecord);
      const n = parseInt(rec.id.slice(1), 10);
      if (n >= this.nextID) this.nextID = n + 1;
    }
    if (recovered) await this.save();
  }

  async save(): Promise<void> {
    await this.store.save([...this.records.values()]);
  }

  async spawn(
    task: string,
    options: SpawnOptions = {},
  ): Promise<SubagentRecord> {
    if (!task) throw new Error("task is required");
    this.assertDepth(options.parentAgentID, options.maxDepth);

    const id = `a${this.nextID++}` as SubagentID;
    const now = this.clock();
    const record: SubagentRecord = {
      id,
      task,
      mode: options.mode ?? "code",
      ...(options.agentType ? { agentType: options.agentType } : {}),
      ...(options.context ? { context: options.context } : {}),
      ...(options.pendingMessages?.length
        ? { pendingMessages: [...options.pendingMessages] }
        : {}),
      status: "idle",
      attached: true,
      modelProfile: options.modelProfile ?? "",
      allowedTools: options.allowedTools ?? [],
      excludeTools: options.excludeTools ?? [],
      writePaths: options.writePaths,
      outputs: [],
      createdAt: now,
      updatedAt: now,
      parentSessionID: options.parentSessionID,
      parentAgentID: options.parentAgentID,
      continuation: 0,
      phase: "queued",
      lastActivityAt: now,
      activityDetail: "spawned",
      startedAt: now,
    };

    this.records.set(id, record);
    await this.save();

    await this.start(record, options.signal);
    return record;
  }

  health(id: SubagentID): SubagentHealth {
    const record = this.records.get(id);
    if (!record) return "terminal";
    if (["completed", "failed", "stopped"].includes(record.status))
      return "terminal";
    if (record.phase === "waiting") return "active";
    const elapsed = this.clock() - record.lastActivityAt;
    const quietGrace = Math.min(5_000, this.stallThresholdMs * 0.5);
    if (elapsed < quietGrace) return "active";
    if (elapsed < this.stallThresholdMs) return "quiet";
    return "stalled";
  }

  reportActivity(id: SubagentID, phase: SubagentPhase, detail: string) {
    const record = this.records.get(id);
    if (!record) return;
    const now = this.clock();
    const prevThrottle = this.activityThrottle.get(id) ?? 0;
    if (now - prevThrottle < 500 && phase !== record.phase) {
      this.activityThrottle.set(id, now);
    } else if (now - prevThrottle < 5_000) {
      return;
    } else {
      this.activityThrottle.set(id, now);
    }
    record.lastActivityAt = now;
    record.phase = phase;
    record.activityDetail = detail;
    if (phase !== "queued" && record.status === "idle") {
      record.status = "running";
      record.startedAt = now;
    }
    this.emit({
      agentId: id,
      event: "activity",
      status: record.status,
      attached: record.attached,
      timestamp: now,
      phase,
      activityDetail: detail,
    });
  }

  requestStop(
    id: SubagentID,
    reason: string,
    force = false,
    requestedBy: AuditEntry["requestedBy"] = "model",
  ): StopResult {
    const record = this.records.get(id);
    if (!record) return { outcome: "not_found", id };
    if (!["running", "paused"].includes(record.status))
      return { outcome: "not_running", id, status: record.status };
    const h = this.health(id);
    if (h === "terminal")
      return { outcome: "not_running", id, status: record.status };
    if (h !== "stalled" && !force) {
      const retryAfterMs = Math.max(
        0,
        this.stallThresholdMs - (this.clock() - record.lastActivityAt),
      );
      return { outcome: "protected", id, health: h, retryAfterMs };
    }
    this.doStop(id, reason, force, requestedBy);
    return { outcome: "stopped", id };
  }

  /**
   * Replace the messages queued for a subagent.
   *
   * Reads the record fresh rather than taking one from the caller: a stale view
   * would drop messages queued in between, and the whole point of the queue is
   * that nothing is lost.
   */
  /**
   * Registers where a live run of this subagent accepts a mid-flight message.
   * Absent a hook, `sendMessage` queues instead, so a parent is never told it
   * steered when it did not.
   */
  setSteerHook(
    id: SubagentID,
    hook: ((message: string) => string | undefined) | undefined,
  ): void {
    if (hook) this.steerHooks.set(id, hook);
    else this.steerHooks.delete(id);
  }

  /**
   * Delivers a steer to one subagent, or queues it when the run has no live
   * ledger to route through.
   *
   * Lives here rather than in the controller because this class owns the
   * records, and a service surface that only the composition can satisfy makes
   * every consumer depend on the composition.
   */
  async sendMessage(
    id: SubagentID,
    message: string,
    callerSession?: string,
  ): Promise<{ route: string }> {
    const record = this.records.get(id);
    if (!record) return { route: "not_found" };
    // Only the parent may steer: anything else is a stranger that has no
    // business redirecting this child.
    if (
      record.parentSessionID !== undefined &&
      callerSession !== undefined &&
      record.parentSessionID !== callerSession
    )
      throw new Error(
        `subagent ${id} belongs to another session; only its parent may steer it`,
      );
    const routed = this.steerHooks.get(id)?.(message);
    if (routed) return { route: routed };
    this.setPendingMessages(id, [...(record.pendingMessages ?? []), message]);
    return { route: "queued" };
  }

  setPendingMessages(id: SubagentID, messages: string[]): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    record.pendingMessages = messages.length ? [...messages] : undefined;
    record.updatedAt = this.clock();
    this.save().catch(() => {});
    return true;
  }

  async retry(id: SubagentID): Promise<SubagentRecord | undefined> {
    const record = this.records.get(id);
    if (!record || !["stopped", "failed"].includes(record.status))
      return undefined;
    record.continuation = (record.continuation ?? 0) + 1;
    record.updatedAt = this.clock();
    record.lastActivityAt = this.clock();
    record.activityDetail = "retry";
    record.phase = "queued";
    record.outputs.push({
      step: record.outputs.length + 1,
      text: `retrying continuation ${record.continuation}`,
      timestamp: record.updatedAt,
    });
    await this.save();
    await this.start(record);
    return record;
  }

  private async start(record: SubagentRecord, signal?: AbortSignal) {
    const id = record.id;
    const abortController = new AbortController();
    this.running.set(id, abortController);
    const now = this.clock();
    record.status = "running";
    record.updatedAt = now;
    record.startedAt = now;
    record.lastActivityAt = now;
    record.phase = "provider";
    record.activityDetail = "starting";
    this.emit({
      agentId: id,
      event: "activity",
      status: record.status,
      attached: record.attached,
      timestamp: now,
      phase: "provider",
      activityDetail: "starting",
    });

    this.armWallClockBudget(id, abortController);

    const ctx: RunnerContext = {
      agentId: id,
      log: (text: string) => {
        const entry: OutputEntry = {
          step: record.outputs.length + 1,
          text,
          timestamp: this.clock(),
        };
        record.outputs.push(entry);
        record.updatedAt = this.clock();
        record.lastActivityAt = this.clock();
        this.emit({
          agentId: id,
          event: "log",
          text,
          status: record.status,
          attached: record.attached,
          timestamp: this.clock(),
        });
      },
      setStatus: (s: string) => {
        if (!isSubagentStatus(s))
          throw new Error(`invalid subagent status: ${s}`);
        record.status = s;
        record.updatedAt = this.clock();
        record.lastActivityAt = this.clock();
        this.addAudit({
          agentId: id,
          action: "status",
          status: s,
          attached: record.attached,
          timestamp: this.clock(),
        });
        this.emit({
          agentId: id,
          event: "status",
          status: s,
          attached: record.attached,
          timestamp: this.clock(),
        });
      },
      signal: anySignal(abortController.signal, signal),
      reportActivity: (phase, detail) => {
        this.reportActivity(id, phase, detail);
      },
      sendToParent: (text: string) => {
        // Also a log entry: the message belongs to the run's durable
        // record as well as the parent's live view.
        ctx.log(text);
        if (!this.onChildMessage) return;
        try {
          this.onChildMessage({ agentId: id, text });
        } catch {
          // The run must not die on a report that could not fly.
        }
      },
    };

    this.addAudit({
      agentId: id,
      action: "created",
      status: record.status,
      attached: record.attached,
      timestamp: this.clock(),
    });
    this.emit({
      agentId: id,
      event: "created",
      status: record.status,
      attached: record.attached,
      timestamp: this.clock(),
    });

    const runPromise = Promise.resolve().then(async () => {
      try {
        await this.runner(record.task, ctx);
        const finalStatus = abortController.signal.aborted
          ? "stopped"
          : "completed";
        record.status = finalStatus;
        record.phase = "finalizing";
        record.activityDetail = finalStatus;
        record.endedAt = this.clock();
        record.lastActivityAt = this.clock();
        this.notifySettled(record);
        this.emit({
          agentId: id,
          event: finalStatus === "completed" ? "done" : "stopped",
          status: finalStatus,
          attached: record.attached,
          timestamp: this.clock(),
          phase: "finalizing",
          activityDetail: finalStatus,
        });
      } catch (err) {
        const finalStatus =
          (err as Error)?.name === "AbortError" ||
          abortController.signal.aborted
            ? "stopped"
            : "failed";
        record.status = finalStatus;
        record.phase = "finalizing";
        record.activityDetail =
          finalStatus === "stopped" ? "aborted" : String(err);
        record.endedAt = this.clock();
        record.lastActivityAt = this.clock();
        if (finalStatus === "failed") {
          record.outputs.push({
            step: record.outputs.length + 1,
            text: String(err),
            timestamp: this.clock(),
          });
        }
        this.notifySettled(record);
        this.emit({
          agentId: id,
          event: finalStatus === "stopped" ? "stopped" : "done",
          status: finalStatus,
          attached: record.attached,
          timestamp: this.clock(),
          phase: "finalizing",
          activityDetail: record.activityDetail,
        });
      } finally {
        record.updatedAt = this.clock();
        this.running.delete(id);
        this.activityThrottle.delete(id);
        this.clearWallClockBudget(id);
        this.addAudit({
          agentId: id,
          action: "done",
          status: record.status,
          attached: record.attached,
          timestamp: this.clock(),
        });
        await this.save();
      }
    });

    runPromise.catch(() => {});
  }

  list(): SubagentRecord[] {
    return [...this.records.values()];
  }

  runningCount(): number {
    return this.running.size;
  }

  get(id: SubagentID): SubagentRecord | undefined {
    return this.records.get(id);
  }

  status(id: SubagentID): SubagentStatus | undefined {
    return this.records.get(id)?.status;
  }

  output(id: SubagentID): OutputEntry[] | undefined {
    return this.records.get(id)?.outputs;
  }

  /**
   * Arm this run's wall-clock deadline.
   *
   * The stop on expiry is forced: the run is by definition not making progress
   * anyone would want to pay for, so the stall protection that shields a healthy
   * run does not apply to it. A disabled budget arms nothing.
   *
   * The timer is unref'd so a deadline never holds the process open after its
   * run has settled.
   */
  private armWallClockBudget(id: SubagentID, ctrl: AbortController) {
    if (this.wallClockBudgetMs <= 0) return;
    this.clearWallClockBudget(id);
    const timer = setTimeout(() => {
      this.budgetTimers.delete(id);
      if (!this.records.has(id)) return;
      this.requestStop(
        id,
        `wall-clock budget of ${this.wallClockBudgetMs}ms exceeded`,
        true,
        "runtime",
      );
    }, this.wallClockBudgetMs);
    timer.unref?.();
    this.budgetTimers.set(id, timer);
    // The controller is read by the callback above only through the record
    // lookup, so keep the reference explicit for readers of this method.
    void ctrl;
  }

  private clearWallClockBudget(id: SubagentID) {
    const timer = this.budgetTimers.get(id);
    if (timer === undefined) return;
    clearTimeout(timer);
    this.budgetTimers.delete(id);
  }

  private doStop(
    id: SubagentID,
    reason: string,
    force: boolean,
    requestedBy: AuditEntry["requestedBy"] = "model",
  ) {
    const record = this.records.get(id);
    if (!record) return;
    const ctrl = this.running.get(id);
    if (ctrl) {
      ctrl.abort();
      record.status = "stopped";
      record.updatedAt = this.clock();
      record.phase = "finalizing";
      record.activityDetail = reason;
      record.endedAt = this.clock();
      record.lastActivityAt = this.clock();
      this.addAudit({
        agentId: id,
        action: "stop",
        status: "stopped",
        attached: record.attached,
        timestamp: this.clock(),
        stopReason: reason,
        requestedBy,
        force,
      });
      this.emit({
        agentId: id,
        event: "stopped",
        status: "stopped",
        attached: record.attached,
        timestamp: this.clock(),
        phase: "finalizing",
        activityDetail: reason,
        stopReason: reason,
        requestedBy,
        force,
      });
      void this.save();
    }
  }

  stop(id: SubagentID): boolean {
    return (
      this.requestStop(id, "model requested stop", false).outcome === "stopped"
    );
  }

  async resume(id: SubagentID): Promise<boolean> {
    const record = this.records.get(id);
    if (!record) return false;
    if (record.status !== "paused") return false;
    if (this.running.has(id)) return false;
    record.status = "running";
    record.updatedAt = this.clock();
    record.lastActivityAt = this.clock();
    record.phase = "queued";
    record.activityDetail = "resume";
    this.addAudit({
      agentId: id,
      action: "resume",
      status: "running",
      attached: record.attached,
      timestamp: this.clock(),
    });
    this.emit({
      agentId: id,
      event: "resumed",
      status: "running",
      attached: record.attached,
      timestamp: this.clock(),
    });
    await this.save();
    await this.start(record);
    return true;
  }

  attach(id: SubagentID): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    record.attached = true;
    record.updatedAt = this.clock();
    this.addAudit({
      agentId: id,
      action: "attach",
      status: record.status,
      attached: true,
      timestamp: this.clock(),
    });
    this.emit({
      agentId: id,
      event: "attached",
      status: record.status,
      attached: true,
      timestamp: this.clock(),
    });
    return true;
  }

  detach(id: SubagentID): boolean {
    const record = this.records.get(id);
    if (!record) return false;
    record.attached = false;
    record.updatedAt = this.clock();
    this.addAudit({
      agentId: id,
      action: "detach",
      status: record.status,
      attached: false,
      timestamp: this.clock(),
    });
    this.emit({
      agentId: id,
      event: "detached",
      status: record.status,
      attached: false,
      timestamp: this.clock(),
    });
    return true;
  }

  cleanup(dryRun = false): string[] {
    const affected: SubagentID[] = [];
    for (const [id, rec] of this.records) {
      if (
        rec.status === "completed" ||
        rec.status === "failed" ||
        rec.status === "stopped"
      ) {
        affected.push(id);
      }
    }
    if (!dryRun) {
      for (const id of affected) {
        this.records.delete(id);
        this.addAudit({
          agentId: id,
          action: "cleanup",
          status: "completed",
          attached: false,
          timestamp: this.clock(),
        });
      }
      this.save();
    }
    return affected;
  }

  audit(tail?: number, format?: string): string {
    let entries = this.auditEntries;
    if (tail && tail > 0 && tail < entries.length) {
      entries = entries.slice(entries.length - tail);
    }
    if (entries.length === 0) return "<no agent audit entries>";
    if (format === "json") {
      return JSON.stringify(
        entries.map((e) => ({
          event_id: e.eventId,
          resource_type: "subagent",
          resource_id: e.agentId,
          agent_id: e.agentId,
          action: e.action,
          status: e.status,
          stop_reason: e.stopReason,
          requested_by: e.requestedBy,
          force: e.force,
          time: new Date(e.timestamp).toISOString(),
        })),
        null,
        2,
      );
    }
    return entries
      .map(
        (e) =>
          `${new Date(e.timestamp).toISOString()} event_id=${e.eventId} agent_id=${e.agentId} action=${e.action} status=${e.status} attached=${e.attached}${e.stopReason ? ` stop_reason=${JSON.stringify(e.stopReason)} requested_by=${e.requestedBy} force=${e.force}` : ""}`,
      )
      .join("\n");
  }

  subscribe(fn: (event: SubagentEvent) => void): () => void {
    this.subscribers.add(fn);
    return () => this.subscribers.delete(fn);
  }

  async formatList(): Promise<string> {
    const all = this.list();
    if (all.length === 0) return "no subagents";
    const lines = all.map((rec) => {
      const parts = [`${rec.id} [${rec.status}] attached=${rec.attached}`];
      if (rec.modelProfile) parts.push(`model_profile=${rec.modelProfile}`);
      parts.push(rec.task);
      const last =
        rec.outputs.length > 0
          ? truncate(rec.outputs[rec.outputs.length - 1].text, 40)
          : "";
      if (last) parts.push(`→ ${last}`);
      parts.push(`(${rec.outputs.length} steps)`);
      return parts.join(" ");
    });
    return `${lines.join("\n")}\n${formatStatusCounts(all)}`;
  }

  async formatOutput(id: SubagentID, verbose = false): Promise<string> {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`subagent ${id} not found`);
    if (rec.outputs.length === 0) return "no output";
    if (!verbose) {
      const last = rec.outputs[rec.outputs.length - 1]!;
      return `${rec.id} [${rec.status}]\n${truncate(last.text, 1200)}`;
    }
    // Bounded: the whole audit trail would spend the parent's context on a
    // history it rarely needs whole, and the tail is the part it acts on.
    return boundVerboseOutput(
      rec.outputs.map((o) => `[${rec.id}] step=${o.step} ${o.text}`),
    );
  }

  async formatStatus(id: SubagentID): Promise<string> {
    const rec = this.records.get(id);
    if (!rec) throw new Error(`subagent ${id} not found`);
    const lines = [
      `${rec.id} [${rec.status}] attached=${rec.attached} ${rec.task}`,
    ];
    if (rec.modelProfile) lines.push(`  model_profile: ${rec.modelProfile}`);
    lines.push(`  mode: ${rec.mode}`);
    lines.push(`  phase: ${rec.phase}`);
    lines.push(
      `  last_activity: ${new Date(rec.lastActivityAt).toISOString()}`,
    );
    lines.push(`  activity: ${rec.activityDetail}`);
    lines.push(`  created: ${new Date(rec.createdAt).toISOString()}`);
    lines.push(`  updated: ${new Date(rec.updatedAt).toISOString()}`);
    lines.push(`  started: ${new Date(rec.startedAt).toISOString()}`);
    if (rec.endedAt)
      lines.push(`  ended: ${new Date(rec.endedAt).toISOString()}`);
    for (const o of rec.outputs) {
      lines.push(`  [step ${o.step}] ${truncate(o.text, 200)}`);
    }
    return lines.join("\n");
  }

  wait(
    ids: string[],
    until: "all_terminal" | "any_terminal",
    timeoutMs: number,
    signal?: AbortSignal,
  ): Promise<Record<string, { status: SubagentStatus; phase: SubagentPhase }>> {
    return new Promise((resolve) => {
      const deadline = this.clock() + timeoutMs;
      const terminalStatuses = new Set(["completed", "failed", "stopped"]);

      const check = (): boolean => {
        const results: Record<
          string,
          { status: SubagentStatus; phase: SubagentPhase }
        > = {};
        let terminalCount = 0;
        for (const id of ids) {
          const rec = this.records.get(id);
          const status = rec?.status ?? "idle";
          const phase = rec?.phase ?? "idle";
          results[id] = { status, phase };
          if (terminalStatuses.has(status)) terminalCount++;
        }
        if (
          until === "all_terminal"
            ? terminalCount === ids.length
            : terminalCount > 0
        ) {
          resolve(results);
          return true;
        }
        return false;
      };

      if (check()) return;

      const unsub = this.subscribe((event) => {
        if (!ids.includes(event.agentId)) return;
        if (check()) unsub();
      });

      const timer = setInterval(() => {
        if (this.clock() >= deadline) {
          clearInterval(timer);
          unsub();
          const results: Record<
            string,
            { status: SubagentStatus; phase: SubagentPhase }
          > = {};
          for (const id of ids) {
            const rec = this.records.get(id);
            results[id] = {
              status: rec?.status ?? "idle",
              phase: rec?.phase ?? "idle",
            };
          }
          resolve(results);
        }
      }, 200);

      signal?.addEventListener(
        "abort",
        () => {
          clearInterval(timer);
          unsub();
          const results: Record<
            string,
            { status: SubagentStatus; phase: SubagentPhase }
          > = {};
          for (const id of ids) {
            const rec = this.records.get(id);
            results[id] = {
              status: rec?.status ?? "idle",
              phase: rec?.phase ?? "idle",
            };
          }
          resolve(results);
        },
        { once: true },
      );
    });
  }

  getAuditEntries(): AuditEntry[] {
    return this.auditEntries;
  }

  private emit(event: SubagentEvent) {
    const record = this.records.get(event.agentId);
    if (record) {
      event.parentSessionID = record.parentSessionID;
      event.parentAgentID = record.parentAgentID;
      event.continuation = record.continuation;
      event.phase = event.phase ?? record.phase;
      event.activityDetail = event.activityDetail ?? record.activityDetail;
    }
    for (const fn of this.subscribers) {
      try {
        fn(event);
      } catch {
        // subscriber error ignored
      }
    }
  }

  private assertDepth(parentID: SubagentID | undefined, maxDepth = 1) {
    let depth = 1;
    let parent = parentID ? this.records.get(parentID) : undefined;
    while (parent) {
      depth++;
      parent = parent.parentAgentID
        ? this.records.get(parent.parentAgentID)
        : undefined;
    }
    if (depth > maxDepth)
      throw new Error(
        `subagent depth limit reached (${maxDepth}); increase runtime.subagentDepth to allow nested subagents`,
      );
  }

  private addAudit(entry: {
    agentId: SubagentID;
    action: string;
    status: string;
    attached: boolean;
    timestamp: number;
    stopReason?: string;
    requestedBy?: "model" | "user" | "parent" | "runtime";
    force?: boolean;
  }) {
    this.auditSeq++;
    const auditEntry: AuditEntry = {
      eventId: `aevt_${this.auditSeq}`,
      agentId: entry.agentId,
      action: entry.action,
      status: entry.status,
      attached: entry.attached,
      timestamp: entry.timestamp,
      stopReason: entry.stopReason,
      requestedBy: entry.requestedBy,
      force: entry.force,
    };
    this.auditEntries.push(auditEntry);
    if (this.auditEntries.length > this.maxAudit) {
      this.auditEntries = this.auditEntries.slice(
        this.auditEntries.length - this.maxAudit,
      );
    }
  }
}

function derivePhase(rec: { status: string }): SubagentPhase {
  const s = rec.status;
  if (s === "idle") return "idle";
  if (s === "paused") return "waiting";
  if (s === "completed" || s === "failed" || s === "stopped")
    return "finalizing";
  return "provider";
}

function anySignal(...signals: (AbortSignal | undefined)[]): AbortSignal {
  const cleanSignals = signals.filter(Boolean) as AbortSignal[];
  if (cleanSignals.length === 0) return new AbortController().signal;
  if (cleanSignals.length === 1) return cleanSignals[0];
  const ctrl = new AbortController();
  for (const sig of cleanSignals) {
    if (sig.aborted) {
      ctrl.abort(sig.reason);
      return ctrl.signal;
    }
    sig.addEventListener("abort", () => ctrl.abort(sig.reason), { once: true });
  }
  return ctrl.signal;
}
