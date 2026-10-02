/**
 * Long-lived processes a model started, and the tools that manage them.
 *
 * The registry is the only durable state in this family: a process outlives the
 * turn and session that started it, so it is persisted per workspace and
 * re-adopted on load.
 */
/**
 * Long-lived processes a model started, and the tools that manage them.
 *
 * The registry is the only durable state in this package: a process outlives the
 * turn that started it and the session that started it, so it is persisted per
 * workspace and re-adopted on load. That is why identity is checked before any
 * signal is sent — a recorded PID may belong to something else by now — and why
 * deadlines survive a restart rather than being forgotten with the process that
 * set them.
 *
 * The `background_*` tools are aliases over the same registry with a shorter
 * vocabulary, not a second implementation.
 */
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";
import {
  detachedShellPrefix,
  shellQuote,
  startDetachedProcess,
} from "@anthelia/platform";
import {
  processFingerprint,
  readOptionalFile,
  safeToolEnv,
  stopProcessTree,
  truncateProcessOutput,
} from "@anthelia/tools";
import {
  numberOr,
  optionalString,
  positiveNumberOr,
  positiveNumberOrUndefined,
  requireObject,
  requireString,
} from "@anthelia/tools";
import type { Plugin, PluginManifest } from "@anthelia/plugin";
import { PROCESS_OBSERVER_SERVICE } from "@anthelia/tools";
import type {
  RuntimeTool,
  ToolExecutionContext,
  ToolFamily,
} from "@anthelia/tools";
import type { SettlementReason } from "@anthelia/contracts";
import {
  SETTLEMENT_SERVICE,
  SETTLEMENT_SOURCE_KINDS,
  type SettlementService,
} from "@natalia/collaboration";

export type ManagedProcessStatus = "running" | "exited" | "failed" | "stopped";

export type ManagedProcessInfo = {
  id: string;
  command: string;
  cwd: string;
  status: ManagedProcessStatus;
  attached: boolean;
  persistent: boolean;
  pid?: number;
  exitCode?: number | null;
  startedAt: string;
  endedAt?: string;
  output: string;
  ready?: boolean;
  readyPattern?: string;
  maxOutputBytes?: number;
  stopTimeoutMs?: number;
  maxRuntimeMs?: number;
  deadlineAt?: string;
};

/**
 * A terminal transition's settlement reason, pure so the table can be
 * pinned without a process: our own stop is `stopped`, a non-zero exit
 * is `failed`, and an exit with no readable code stays `exited` — never
 * silently a success (the spine's reason discipline).
 */
export function settlementReasonFor(
  status: ManagedProcessSettledEvent["status"],
  exitCode: number | undefined,
): SettlementReason {
  if (status === "stopped") return "stopped";
  if (status === "failed") return "failed";
  if (exitCode !== undefined && exitCode !== 0) return "failed";
  return "exited";
}

export class ManagedProcessRegistry {
  readonly observer: ManagedProcessObserver;
  /**
   * The settlement bridge, resolved by the plugin's setup from the
   * runtime's service registry. Absent in bare constructions (the unit
   * tests) — a registry without it simply reports no notices, exactly as
   * it did before the spine existed.
   */
  constructor(private readonly settlement?: SettlementService) {
    this.observer = new ManagedProcessObserver({
      snapshot: () =>
        [...this.processes.entries()].flatMap(([workspaceRoot, byID]) =>
          [...byID.values()].map((info) => ({ ...info, workspaceRoot })),
        ),
      settle: ({ id, status }) => {
        for (const [workspaceRoot, byID] of this.processes) {
          const info = byID.get(id);
          if (!info || info.status !== "running") continue;
          return this.markTerminal(
            { workspaceRoot } as unknown as ToolExecutionContext,
            info,
            status,
          );
        }
        return undefined;
      },
      ready: ({ id, workspaceRoot }) => this.markReady(id, workspaceRoot),
    });
  }

  /**
   * The settlement notice for a terminal transition (the spine's process
   * adopter). The reason is the record's, not the caller's.
   */
  private notifySettled(event: ManagedProcessSettledEvent): void {
    if (!this.settlement || !event.sessionID) return;
    const reason = settlementReasonFor(event.status, event.exitCode);
    this.settlement.deliverForSession(event.sessionID, {
      subject: event.id,
      reason,
      summary: `process ${event.id} (${event.command}) ended as ${event.status}`,
      ...(event.exitCode === undefined
        ? {}
        : { detail: `exitCode ${event.exitCode}` }),
      sourceKind: SETTLEMENT_SOURCE_KINDS.processExited,
    });
  }

  /**
   * The ready probe: mark a record ready when its pattern first matches
   * the process output, and report the flip. The registry stays the only
   * writer of `ready` (the observer's sweep asks, it does not write).
   */
  private async markReady(
    id: string,
    workspaceRoot: string,
    preReadOutput?: string,
  ): Promise<boolean> {
    const info = this.processes.get(workspaceRoot)?.get(id);
    if (!info || !info.readyPattern || info.ready) return false;
    if (info.status !== "running") return false;
    const rawOutput =
      preReadOutput ?? (await readOptionalFile(info.outputPath));
    if (!new RegExp(info.readyPattern).test(rawOutput)) return false;
    info.ready = true;
    // The readiness notice: the process's own boundary, through the same
    // spine an exit uses. Best-effort and session-scoped like the exit's.
    if (this.settlement && info.startedBySessionID)
      this.settlement.deliverForSession(info.startedBySessionID, {
        subject: id,
        reason: "ready",
        summary: `process ${id} (${info.command}) is ready — its pattern matched`,
        detail: `pattern: ${info.readyPattern}`,
        sourceKind: SETTLEMENT_SOURCE_KINDS.processReady,
      });
    return true;
  }

  /**
   * Release everything the registry holds when its owning plugin unloads: the
   * observer's poll loop, every per-process deadline timer, and any process
   * still running. Without this, disabling or uninstalling the plugin mid-run
   * orphans child processes and leaves the sweep timer armed (audit
   * uninstall-safety). Best-effort per process: one failure to stop does not
   * abandon the rest.
   */
  async dispose(): Promise<void> {
    this.observer.dispose();
    for (const timer of this.deadlines.values()) clearTimeout(timer);
    this.deadlines.clear();
    const running: ManagedProcessRuntime[] = [];
    for (const byID of this.processes.values())
      for (const info of byID.values())
        if (info.status === "running" && info.pid) running.push(info);
    await Promise.allSettled(
      running.map((info) =>
        stopProcessTree(
          info.pid!,
          info.stopTimeoutMs ?? 1000,
          info.pidStartTicks,
        ),
      ),
    );
    const endedAt = new Date().toISOString();
    for (const info of running) {
      info.status = "stopped";
      info.endedAt = endedAt;
    }
    this.processes.clear();
  }
  private processes = new Map<string, Map<string, ManagedProcessRuntime>>();
  private deadlines = new Map<string, ReturnType<typeof setTimeout>>();
  private sequences = new Map<string, number>();
  private loadedRoots = new Set<string>();

  async start(
    command: string,
    context: ToolExecutionContext,
    id?: string,
    options: {
      readyPattern?: string;
      maxOutputBytes?: number;
      stopTimeoutMs?: number;
      maxRuntimeMs?: number;
    } = {},
  ) {
    await this.load(context);
    const processes = this.workspaceProcesses(context);
    const processID = id ?? `proc_${this.nextSequence(context).toString(36)}`;
    if (processes.has(processID))
      throw new Error(`process already exists: ${processID}`);
    const processDir = resolve(context.workspaceRoot, ".natalia", "processes");
    await mkdir(processDir, { recursive: true });
    const outputPath = resolve(processDir, `${processID}.log`);
    const { pid } = await startDetachedProcess({
      command,
      posixScript: `${detachedShellPrefix()}bash -c ${shellQuote(command)} > ${shellQuote(outputPath)} 2>&1 & echo $!`,
      cwd: context.workspaceRoot,
      outputPath,
      env: safeToolEnv(context.settings?.envAllowlist),
    });
    const info: ManagedProcessRuntime = {
      id: processID,
      command,
      cwd: context.workspaceRoot,
      status: "running",
      attached: true,
      persistent: true,
      pid,
      startedAt: new Date().toISOString(),
      // Who started it: a terminal notice has to reach the session that asked,
      // because a workspace may hold several and the others did not do this work.
      startedBySessionID: context.sessionID,
      output: "",
      outputPath,
      ready: false,
      readyPattern: options.readyPattern,
      maxOutputBytes: options.maxOutputBytes ?? 20000,
      stopTimeoutMs: options.stopTimeoutMs ?? 1000,
      maxRuntimeMs: options.maxRuntimeMs,
      deadlineAt: options.maxRuntimeMs
        ? new Date(Date.now() + options.maxRuntimeMs).toISOString()
        : undefined,
      ...(await processFingerprint(pid)),
    };
    processes.set(processID, info);
    await this.save(context);
    this.scheduleDeadline(info, context);
    // Arm the liveness sweep now that something is running.
    this.observer.sync();
    return publicProcessInfo(info);
  }

  /**
   * Block until a process reaches a terminal state or the budget runs out.
   *
   * Built on the observer rather than a second polling loop: the observer is
   * already the thing that notices an exit, so a wait is one more subscriber
   * rather than another timer racing the first.
   *
   * Returns the terminal notice, or `undefined` when the budget ran out first —
   * a wait that timed out still leaves the caller knowing the process is alive.
   */
  async wait(
    id: string,
    context: ToolExecutionContext,
    timeoutMs: number = DEFAULT_PROCESS_WAIT_MS,
  ): Promise<ManagedProcessSettledEvent | undefined> {
    await this.load(context);
    const info = this.workspaceProcesses(context).get(id);
    if (!info) throw new Error(`process not found: ${id}`);
    if (info.status !== "running") {
      const settled = this.settleFromRecord(context, info);
      if (settled) return settled;
      return {
        kind: "settled" as const,
        id: info.id,
        command: info.command,
        status: info.status as "exited" | "stopped" | "failed",
        workspaceRoot: context.workspaceRoot,
        startedAt: info.startedAt,
        endedAt: info.endedAt ?? new Date().toISOString(),
        ...(info.startedBySessionID
          ? { sessionID: info.startedBySessionID }
          : {}),
      };
    }
    return await new Promise<ManagedProcessSettledEvent | undefined>(
      (resolve) => {
        let unsubscribe = () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (result: ManagedProcessSettledEvent | undefined) => {
          if (timer) clearTimeout(timer);
          timer = undefined;
          unsubscribe();
          resolve(result);
        };
        unsubscribe = this.observer.subscribe((event) => {
          // Only terminal transitions end a wait; a readiness flip travels
          // the same channel and is skipped here.
          if (event.kind !== "settled") return;
          if (event.id !== id || event.workspaceRoot !== context.workspaceRoot)
            return;
          finish(event);
        });
        // The observer sweeps on an interval, so a process that exited just
        // before this wait may not have been noticed yet: check once on entry
        // rather than waiting a whole poll for it.
        const settled = this.settleFromRecord(context, info);
        if (settled) {
          finish(settled);
          return;
        }
        timer = setTimeout(() => finish(undefined), Math.max(0, timeoutMs));
        timer.unref();
        // The observer must be armed for the subscription above to ever fire.
        this.observer.sync();
      },
    );
  }

  /**
   * Settle a record the observer has not reached yet, returning its notice.
   *
   * The observer's sweep is periodic, so a process that exited moments ago is
   * still marked running. Re-checking liveness here closes that window for a
   * caller who is about to block on it.
   */
  private settleFromRecord(
    context: ToolExecutionContext,
    info: ManagedProcessRuntime,
  ): ManagedProcessSettledEvent | undefined {
    if (info.status !== "running") return undefined;
    let alive = true;
    try {
      if (info.pid) process.kill(info.pid, 0);
    } catch {
      alive = false;
    }
    if (alive) return undefined;
    return this.markTerminal(context, info, "exited");
  }

  /**
   * The ONE terminal-transition writer: mark the record, build the event,
   * notify the spine. Every path that can flip running -> terminal goes
   * through here — the sweep's settle callback, the lazy re-check, the
   * restore's fingerprint loss — because a silent marker (a `list()` that
   * drains an exit before the sweep sees it) is a notice lost to a polling
   * reader, the exact disease this spine exists to cure.
   */
  private markTerminal(
    context: ToolExecutionContext,
    info: ManagedProcessRuntime,
    status: "exited" | "stopped" | "failed",
  ): ManagedProcessSettledEvent {
    info.status = status;
    info.endedAt = new Date().toISOString();
    const event: ManagedProcessSettledEvent = {
      kind: "settled",
      id: info.id,
      command: info.command,
      status,
      workspaceRoot: context.workspaceRoot,
      ...(info.startedBySessionID
        ? { sessionID: info.startedBySessionID }
        : {}),
      startedAt: info.startedAt,
      endedAt: info.endedAt,
      // The record's `exitCode` is `number | null`; the event carries
      // only a real code, so a null stays absent rather than becoming 0.
      ...(info.exitCode === null || info.exitCode === undefined
        ? {}
        : { exitCode: info.exitCode }),
    };
    this.notifySettled(event);
    return event;
  }

  async list(context: ToolExecutionContext) {
    await this.load(context);
    return [...this.workspaceProcesses(context).values()].map((info) => {
      this.settleFromRecord(context, info);
      return publicProcessInfo(info);
    });
  }

  async runningCount(context: ToolExecutionContext): Promise<number> {
    await this.load(context);
    return [...this.workspaceProcesses(context).values()].filter((info) => {
      this.settleFromRecord(context, info);
      return info.status === "running";
    }).length;
  }

  async get(id: string, context: ToolExecutionContext) {
    await this.load(context);
    const info = this.workspaceProcesses(context).get(id);
    if (!info) throw new Error(`process not found: ${id}`);
    this.settleFromRecord(context, info);
    return publicProcessInfo(info);
  }

  async output(id: string, context: ToolExecutionContext) {
    await this.load(context);
    const info = this.workspaceProcesses(context).get(id);
    if (!info) throw new Error(`process not found: ${id}`);
    const rawOutput = await readOptionalFile(info.outputPath);
    info.output = truncateProcessOutput(rawOutput, info.maxOutputBytes);
    // The lazy ready check delegates to the sweep's writer: the flip
    // notifies whether the probe or a read found it (one writer, one
    // notice).
    await this.markReady(id, context.workspaceRoot, rawOutput);
    this.settleFromRecord(context, info);
    return info.output;
  }

  async stop(id: string, context: ToolExecutionContext) {
    await this.load(context);
    const info = this.workspaceProcesses(context).get(id);
    if (!info) throw new Error(`process not found: ${id}`);
    this.clearDeadline(this.deadlineKey(context, id));
    if (info.status === "running" && info.pid)
      await stopProcessTree(
        info.pid,
        info.stopTimeoutMs ?? 1000,
        info.pidStartTicks,
      );
    info.status = "stopped";
    info.endedAt = new Date().toISOString();
    await this.save(context);
    // A stop is a terminal transition too, so the sweep re-evaluates whether any
    // process is still running.
    this.observer.sync();
    return publicProcessInfo(info);
  }

  async restart(id: string, context: ToolExecutionContext) {
    const current = await this.get(id, context);
    if (current.status === "running") await this.stop(id, context);
    this.workspaceProcesses(context).delete(id);
    return await this.start(current.command, context, id, {
      readyPattern: current.readyPattern,
      maxOutputBytes: current.maxOutputBytes,
      stopTimeoutMs: current.stopTimeoutMs,
      maxRuntimeMs: current.maxRuntimeMs,
    });
  }

  async attach(id: string, context: ToolExecutionContext) {
    await this.load(context);
    const info = this.workspaceProcesses(context).get(id);
    if (!info) throw new Error(`process not found: ${id}`);
    info.attached = true;
    await this.save(context);
    this.settleFromRecord(context, info);
    return publicProcessInfo(info);
  }

  async detach(id: string, context: ToolExecutionContext) {
    await this.load(context);
    const info = this.workspaceProcesses(context).get(id);
    if (!info) throw new Error(`process not found: ${id}`);
    info.attached = false;
    await this.save(context);
    this.settleFromRecord(context, info);
    return publicProcessInfo(info);
  }

  async cleanup(context: ToolExecutionContext) {
    await this.load(context);
    let removed = 0;
    const processes = this.workspaceProcesses(context);
    for (const [id, info] of processes) {
      this.settleFromRecord(context, info);
      if (info.status !== "running") {
        processes.delete(id);
        this.clearDeadline(this.deadlineKey(context, id));
        removed++;
      }
    }
    await this.save(context);
    return { removed, remaining: processes.size };
  }

  async audit(context: ToolExecutionContext) {
    await this.load(context);
    return {
      root: resolve(context.workspaceRoot),
      processes: [...this.workspaceProcesses(context).values()].map((info) => {
        this.settleFromRecord(context, info);
        return publicProcessInfo(info);
      }),
    };
  }

  /**
   * Wait for readiness through the observer, not a poll: the sweep's ready
   * probe marks the flip, and this call is one more subscriber (the wait
   * tool's pattern — one watcher per boundary, never a second timer racing
   * the first).
   */
  async waitForReady(
    id: string,
    context: ToolExecutionContext,
    timeoutMs = 30000,
  ) {
    await this.load(context);
    const info = this.workspaceProcesses(context).get(id);
    if (!info) throw new Error(`process not found: ${id}`);
    if (!info.readyPattern || info.ready) return publicProcessInfo(info);
    if (info.status !== "running")
      throw new Error(`process exited before ready: ${id}`);
    return await new Promise<ReturnType<typeof publicProcessInfo>>(
      (resolve, reject) => {
        let unsubscribe = () => {};
        let timer: ReturnType<typeof setTimeout> | undefined;
        const finish = (fn: () => void) => {
          if (timer) clearTimeout(timer);
          timer = undefined;
          unsubscribe();
          fn();
        };
        unsubscribe = this.observer.subscribe((event) => {
          if (event.id !== id || event.workspaceRoot !== context.workspaceRoot)
            return;
          if (event.kind === "ready") {
            finish(() =>
              resolve(
                publicProcessInfo(this.workspaceProcesses(context).get(id)!),
              ),
            );
            return;
          }
          // A settle event here means the process died before its pattern.
          finish(() => reject(new Error(`process exited before ready: ${id}`)));
        });
        // The sweep is periodic; a pattern that matched moments ago may not
        // have been probed yet — re-check once on entry rather than waiting a
        // whole poll.
        void this.markReady(id, context.workspaceRoot).then((flipped) => {
          const current = this.workspaceProcesses(context).get(id)!;
          if (flipped || current.ready)
            finish(() => resolve(publicProcessInfo(current)));
        });
        // Arm the sweep: the subscription above needs it.
        this.observer.sync();
        timer = setTimeout(
          () => {
            finish(() => reject(new Error(`process ready timeout: ${id}`)));
          },
          Math.max(0, timeoutMs),
        );
        timer.unref?.();
      },
    );
  }

  private async load(context: ToolExecutionContext) {
    const root = resolve(context.workspaceRoot);
    if (this.loadedRoots.has(root)) return;
    this.loadedRoots.add(root);
    try {
      const parsed = JSON.parse(
        await readFile(
          resolve(root, ".natalia", "processes", "processes.json"),
          "utf8",
        ),
      ) as { processes?: ManagedProcessRuntime[] };
      for (const info of parsed.processes ?? []) {
        if (!info.id || !info.command || !info.outputPath) continue;
        const restored = await this.restorePersistedRecord(context, info);
        this.workspaceProcesses(context).set(restored.id, restored);
        if (
          restored.status === "running" &&
          restored.deadlineAt &&
          new Date(restored.deadlineAt).getTime() <= Date.now()
        )
          await this.stop(restored.id, context);
        else this.scheduleDeadline(restored, context);
        const match = info.id.match(/^proc_([0-9a-z]+)$/u);
        if (match)
          this.sequences.set(
            root,
            Math.max(this.sequences.get(root) ?? 0, parseInt(match[1]!, 36)),
          );
      }
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }

  private async save(context: ToolExecutionContext) {
    const processDir = resolve(context.workspaceRoot, ".natalia", "processes");
    await mkdir(processDir, { recursive: true, mode: 0o700 });
    await writeFile(
      resolve(processDir, "processes.json"),
      `${JSON.stringify({ processes: [...this.workspaceProcesses(context).values()] }, null, 2)}\n`,
      { mode: 0o600 },
    );
  }

  private scheduleDeadline(
    info: ManagedProcessRuntime,
    context: ToolExecutionContext,
  ) {
    this.clearDeadline(this.deadlineKey(context, info.id));
    if (info.status !== "running" || !info.deadlineAt) return;
    const delay = new Date(info.deadlineAt).getTime() - Date.now();
    if (!Number.isFinite(delay)) return;
    const timer = setTimeout(
      () => void this.stop(info.id, context),
      Math.max(0, delay),
    );
    timer.unref();
    this.deadlines.set(this.deadlineKey(context, info.id), timer);
  }

  private clearDeadline(key: string) {
    const timer = this.deadlines.get(key);
    if (timer) clearTimeout(timer);
    this.deadlines.delete(key);
  }

  private workspaceProcesses(context: ToolExecutionContext) {
    const root = resolve(context.workspaceRoot);
    let processes = this.processes.get(root);
    if (!processes) {
      processes = new Map();
      this.processes.set(root, processes);
    }
    return processes;
  }

  private nextSequence(context: ToolExecutionContext) {
    const root = resolve(context.workspaceRoot);
    const next = (this.sequences.get(root) ?? 0) + 1;
    this.sequences.set(root, next);
    return next;
  }

  private deadlineKey(context: ToolExecutionContext, id: string) {
    return `${resolve(context.workspaceRoot)}\0${id}`;
  }

  /**
   * Restore a persisted record through the notice-bearing checks: liveness
   * first, then the pid-fingerprint (a pid whose start ticks no longer
   * match means the process died and the OS reused the pid — an ownership
   * loss, which is a terminal `failed`, and one that must notify like any
   * other exit: a process that died while the session was away must not
   * restore silently).
   */
  private async restorePersistedRecord(
    context: ToolExecutionContext,
    info: ManagedProcessRuntime,
  ): Promise<ManagedProcessRuntime> {
    if (info.status !== "running") return info;
    let alive = true;
    try {
      if (info.pid) process.kill(info.pid, 0);
    } catch {
      alive = false;
    }
    if (!alive) {
      this.markTerminal(context, info, "exited");
      return info;
    }
    if (info.pid && info.pidStartTicks) {
      const current = await processFingerprint(info.pid);
      if (current.pidStartTicks !== info.pidStartTicks) {
        info.output =
          `${info.output}\nmanaged process ownership lost: PID ${info.pid} no longer matches its persisted process fingerprint`.trim();
        this.markTerminal(context, info, "failed");
        return info;
      }
    }
    return info;
  }
}

type ManagedProcessRuntime = ManagedProcessInfo & {
  outputPath: string;
  /** Session that started the process, when one did. */
  startedBySessionID?: string;
  pidStartTicks?: string;
  commandLine?: string;
  deadlineAt?: string;
};

function publicProcessInfo(info: ManagedProcessRuntime): ManagedProcessInfo {
  return {
    id: info.id,
    command: info.command,
    cwd: info.cwd,
    status: info.status,
    attached: info.attached,
    persistent: info.persistent,
    pid: info.pid,
    exitCode: info.exitCode,
    startedAt: info.startedAt,
    endedAt: info.endedAt,
    output: info.output,
    ready: info.ready,
    readyPattern: info.readyPattern,
    maxOutputBytes: info.maxOutputBytes,
    stopTimeoutMs: info.stopTimeoutMs,
    maxRuntimeMs: info.maxRuntimeMs,
    deadlineAt: info.deadlineAt,
  };
}

function processControlTool(
  name: string,
  description: string,
  requiresApproval: boolean,
  action: (
    id: string,
    context: ToolExecutionContext,
  ) => Promise<ManagedProcessInfo>,
): RuntimeTool {
  return {
    name,
    description,
    requiresApproval,
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      return JSON.stringify(
        await action(requireString(args.id, "id"), context),
        null,
        2,
      );
    },
  };
}

function aliasTool(
  name: string,
  description: string,
  requiresApproval: boolean,
  execute: RuntimeTool["execute"],
): RuntimeTool {
  return {
    name,
    description,
    requiresApproval,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        command: { type: "string" },
      },
      additionalProperties: true,
    },
    execute,
  };
}

function processStartTool(registry: ManagedProcessRegistry): RuntimeTool {
  return {
    name: "process_start",
    description:
      "Start a long-running shell process in the workspace. The shell is always bash-compatible (Git Bash on Windows, native bash on Linux/Mac).",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: {
        command: { type: "string" },
        id: { type: "string" },
        readyPattern: { type: "string" },
        maxOutputBytes: { type: "number" },
        stopTimeoutMs: { type: "number" },
        maxRuntimeMs: { type: "number" },
      },
      required: ["command"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { id: { type: "string" } },
        required: ["id"],
        additionalProperties: false,
      },
      presentCall(args) {
        return {
          kind: "terminal",
          title: requireObject(args).command as string,
          summary: "start",
        };
      },
      presentResult(args, value) {
        const command = requireObject(args).command as string;
        const id = JSON.parse(value)?.id as string | undefined;
        return {
          kind: "terminal",
          title: command,
          summary: id ? `started ${id}` : "started",
          meta: id ? [["id", id]] : [],
        };
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      return JSON.stringify(
        await registry.start(
          requireString(args.command, "command"),
          context,
          optionalString(args.id),
          {
            readyPattern: optionalString(args.readyPattern),
            maxOutputBytes: positiveNumberOr(args.maxOutputBytes, 20000),
            stopTimeoutMs: positiveNumberOr(args.stopTimeoutMs, 1000),
            maxRuntimeMs: positiveNumberOrUndefined(args.maxRuntimeMs),
          },
        ),
        null,
        2,
      );
    },
  };
}

function processListTool(registry: ManagedProcessRegistry): RuntimeTool {
  return {
    name: "process_list",
    description: "List managed workspace processes.",
    requiresApproval: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, context) {
      return JSON.stringify(await registry.list(context), null, 2);
    },
  };
}

function processWaitTool(registry: ManagedProcessRegistry): RuntimeTool {
  return {
    name: "process_wait",
    description:
      "Convenience wait for a managed process to finish and return how it ended. You are USUALLY TOLD: an exit (including a crash and a non-zero code) delivers a settlement notice, so you do not need to block on this — prefer doing other work and reading the notice. Returns the current state instead of hanging when the timeout runs out.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: {
        id: { type: "string" },
        timeoutMs: { type: "number", minimum: 0 },
      },
      required: ["id"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          id: { type: "string" },
          status: { type: "string" },
          exitCode: { type: "number" },
          timedOut: { type: "boolean" },
        },
        required: ["id", "status", "timedOut"],
        additionalProperties: false,
      },
      presentCall(args) {
        return {
          kind: "generic",
          title: requireString(requireObject(args).id, "id"),
          summary: "wait",
        };
      },
      presentResult(_args, value) {
        const parsed = JSON.parse(value) as {
          id?: string;
          status?: string;
          timedOut?: boolean;
        } | null;
        return {
          kind: "generic",
          title: parsed?.id ?? "process",
          summary: parsed?.timedOut
            ? `still ${parsed.status ?? "running"}`
            : (parsed?.status ?? "finished"),
        };
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      const timeoutMs = numberOr(args.timeoutMs, DEFAULT_PROCESS_WAIT_MS);
      const settled = await registry.wait(
        requireString(args.id, "id"),
        context,
        timeoutMs,
      );
      return JSON.stringify(
        {
          id: requireString(args.id, "id"),
          status: settled?.status ?? "running",
          ...(settled?.exitCode === undefined
            ? {}
            : { exitCode: settled.exitCode }),
          ...(settled?.endedAt ? { endedAt: settled.endedAt } : {}),
          timedOut: settled === undefined,
        },
        null,
        2,
      );
    },
  };
}

function processStatusTool(registry: ManagedProcessRegistry): RuntimeTool {
  return {
    name: "process_status",
    description: "Return status for a managed process.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      return JSON.stringify(
        await registry.get(requireString(args.id, "id"), context),
        null,
        2,
      );
    },
  };
}

function processOutputTool(registry: ManagedProcessRegistry): RuntimeTool {
  return {
    name: "process_output",
    description: "Return retained output for a managed process.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      return await registry.output(requireString(args.id, "id"), context);
    },
  };
}

function processReadyTool(registry: ManagedProcessRegistry): RuntimeTool {
  return {
    name: "process_ready",
    description:
      "Wait until a managed process output matches its ready pattern. One subscriber on the observer's sweep, not a poll — and readiness itself also delivers a settlement notice, so a server that comes up while you work elsewhere reaches you without this call.",
    requiresApproval: false,
    parameters: {
      type: "object",
      properties: { id: { type: "string" }, timeoutMs: { type: "number" } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      return JSON.stringify(
        await registry.waitForReady(
          requireString(args.id, "id"),
          context,
          numberOr(args.timeoutMs, 30000),
        ),
        null,
        2,
      );
    },
  };
}

function processStopTool(registry: ManagedProcessRegistry): RuntimeTool {
  return {
    name: "process_stop",
    description: "Stop a managed process.",
    requiresApproval: true,
    parameters: {
      type: "object",
      properties: { id: { type: "string" } },
      required: ["id"],
      additionalProperties: false,
    },
    async execute(input, context) {
      const args = requireObject(input);
      return JSON.stringify(
        await registry.stop(requireString(args.id, "id"), context),
        null,
        2,
      );
    },
  };
}

function processRestartTool(registry: ManagedProcessRegistry): RuntimeTool {
  return processControlTool(
    "process_restart",
    "Restart a managed process.",
    true,
    (id, context) => registry.restart(id, context),
  );
}

function processAttachTool(registry: ManagedProcessRegistry): RuntimeTool {
  return processControlTool(
    "process_attach",
    "Mark a managed process as attached.",
    false,
    (id, context) => registry.attach(id, context),
  );
}

function processDetachTool(registry: ManagedProcessRegistry): RuntimeTool {
  return processControlTool(
    "process_detach",
    "Mark a managed process as detached.",
    false,
    (id, context) => registry.detach(id, context),
  );
}

function processCleanupTool(registry: ManagedProcessRegistry): RuntimeTool {
  return {
    name: "process_cleanup",
    description: "Remove stopped or exited managed processes.",
    requiresApproval: true,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, context) {
      return JSON.stringify(await registry.cleanup(context), null, 2);
    },
  };
}

function processAuditTool(registry: ManagedProcessRegistry): RuntimeTool {
  return {
    name: "process_audit",
    description: "Return managed process audit state.",
    requiresApproval: false,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    async execute(_input, context) {
      return JSON.stringify(await registry.audit(context), null, 2);
    },
  };
}

function backgroundStartTool(registry: ManagedProcessRegistry): RuntimeTool {
  return aliasTool(
    "background_start",
    "Start a background workspace process. Uses a bash-compatible shell on all platforms (Git Bash on Windows).",
    true,
    (input, context) => processStartTool(registry).execute(input, context),
  );
}

function backgroundListTool(registry: ManagedProcessRegistry): RuntimeTool {
  return aliasTool(
    "background_list",
    "List background processes.",
    false,
    async (_input, context) =>
      JSON.stringify(await registry.list(context), null, 2),
  );
}

function backgroundOutputTool(registry: ManagedProcessRegistry): RuntimeTool {
  return aliasTool(
    "background_output",
    "Return background process output.",
    false,
    (input, context) => processOutputTool(registry).execute(input, context),
  );
}

function backgroundStopTool(registry: ManagedProcessRegistry): RuntimeTool {
  return aliasTool(
    "background_stop",
    "Stop a background process.",
    true,
    (input, context) => processStopTool(registry).execute(input, context),
  );
}

function backgroundRestartTool(registry: ManagedProcessRegistry): RuntimeTool {
  return aliasTool(
    "background_restart",
    "Restart a background process.",
    true,
    (input, context) => processRestartTool(registry).execute(input, context),
  );
}

function backgroundCleanupTool(registry: ManagedProcessRegistry): RuntimeTool {
  return aliasTool(
    "background_cleanup",
    "Cleanup background process registry.",
    true,
    async (_input, context) =>
      JSON.stringify(await registry.cleanup(context), null, 2),
  );
}

function backgroundAuditTool(registry: ManagedProcessRegistry): RuntimeTool {
  return aliasTool(
    "background_audit",
    "Return background process audit state.",
    false,
    async (_input, context) =>
      JSON.stringify(await registry.audit(context), null, 2),
  );
}

/**
 * Every tool that manages a long-lived process, over one registry.
 *
 * Assembled here rather than listed in the barrel so the family owns both its
 * state and the surface that reaches it: adding a process tool is one edit in one
 * file.
 */
export function managedProcessTools(
  registry: ManagedProcessRegistry,
): RuntimeTool[] {
  return [
    processStartTool(registry),
    processListTool(registry),
    processStatusTool(registry),
    processWaitTool(registry),
    processOutputTool(registry),
    processReadyTool(registry),
    processStopTool(registry),
    processRestartTool(registry),
    processAttachTool(registry),
    processDetachTool(registry),
    processCleanupTool(registry),
    processAuditTool(registry),
    backgroundStartTool(registry),
    backgroundListTool(registry),
    backgroundOutputTool(registry),
    backgroundStopTool(registry),
    backgroundRestartTool(registry),
    backgroundCleanupTool(registry),
    backgroundAuditTool(registry),
  ];
}

/**
 * Session scope: the tools are meaningful only while the session using them is
 * alive, even though the processes they manage outlive it.
 */
export function processToolFamily(
  processRegistry = new ManagedProcessRegistry(),
): ToolFamily {
  return {
    id: "process",
    name: "Managed Process Tools",
    version: "1.0.0",
    description: "Long-running background processes.",
    scope: "session",
    tools: [...managedProcessTools(processRegistry)],
  };
}

export const PROCESS_PLUGIN_ID = "natalia-tool-process";

export const MANAGED_PROCESS_REGISTRY_SERVICE = "managedProcessRegistry";

export const PROCESS_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: PROCESS_PLUGIN_ID,
  version: "1.0.0",
  name: "Managed Process Tools",
  description: "Long-running background processes.",
  entry: "index.js",
  scope: "session",
  // The observer is declared alongside the registry so a consumer can subscribe
  // to terminal transitions through the documented service seam.
  provides: [MANAGED_PROCESS_REGISTRY_SERVICE, PROCESS_OBSERVER_SERVICE],
  requires: [],
  optionalRequires: [],
  conflicts: [],
  dependencies: [],
  hooks: {},
  integrationPoints: ["tools", "services"],
};

export function createProcessPlugin(): Plugin {
  let registry: ManagedProcessRegistry | undefined;
  return {
    manifest: PROCESS_PLUGIN_MANIFEST,
    setup(api) {
      registry = new ManagedProcessRegistry();
      api.services.provide(MANAGED_PROCESS_REGISTRY_SERVICE, registry);
      // The observer is published separately from the registry so a consumer can
      // watch terminal transitions without holding the registry itself, which
      // owns start, stop and every write to process state.
      api.services.provide(PROCESS_OBSERVER_SERVICE, registry.observer);
      for (const tool of managedProcessTools(registry))
        api.tools.register(tool);
    },
    async dispose() {
      // The framework releases the service/tool registrations on unload, but
      // not the processes, deadline timers, or the observer's poll loop the
      // registry owns — dispose those here so an unload mid-run leaves nothing
      // running.
      await registry?.dispose();
      registry = undefined;
    },
  };
}

/**
 * One managed process reaching a terminal state, observed rather than polled.
 *
 * `refreshProcessStatus` only transitions `running → exited` when something
 * happens to observe the process, so `list()` and `runningCount()` report a
 * finished process as running until then. The observer closes that gap, and this
 * is what it reports.
 */
/** One managed process reaching a terminal state. */
export interface ManagedProcessSettledEvent {
  kind: "settled";
  id: string;
  command: string;
  status: "exited" | "stopped" | "failed";
  exitCode?: number;
  workspaceRoot: string;
  /** The session that started it, when one did. */
  sessionID?: string;
  startedAt: string;
  endedAt: string;
}

/**
 * How often the observer checks liveness.
 *
 * A poll rather than a per-process timer: `process.kill(pid, 0)` is the only
 * signal available for a detached child, and one interval is one thing to clear
 * on dispose rather than one per process.
 */
export const DEFAULT_PROCESS_POLL_MS = 5_000;

/**
 * How long `process_wait` blocks before reporting what it has.
 *
 * Bounded because the wait holds a tool call, and a tool call holds a turn. The
 * caller is told it timed out rather than left waiting indefinitely, so it can
 * decide between waiting again and moving on.
 */
export const DEFAULT_PROCESS_WAIT_MS = 300_000;

/** Everything the observer needs, injected so it can be driven by a clock. */
export interface ProcessObserverOptions {
  pollMs?: number;
  setTimer?: (fn: () => void, ms: number) => ReturnType<typeof setTimeout>;
  clearTimer?: (timer: ReturnType<typeof setTimeout>) => void;
}

/**
 * An active liveness sweep over every workspace's managed processes.
 *
 * Deliberately idle when nothing is running: a permanently-armed interval in
 * every session would be a timer nobody needs, and the sweep is what makes
 * `status` honest rather than merely eventually correct.
 */
/**
 * A managed process becoming ready: its `readyPattern` first matched the
 * output. Readiness is not settlement — the process keeps running — so it
 * travels the same channel under its own kind (the spine's process adopter
 * turns it into a `process-ready` notice).
 */
export type ManagedProcessReadyEvent = {
  kind: "ready";
  id: string;
  workspaceRoot: string;
};

export class ManagedProcessObserver {
  private readonly subscribers = new Set<
    (event: ManagedProcessSettledEvent | ManagedProcessReadyEvent) => void
  >();
  private readonly pollMs: number;
  private readonly setTimer: (
    fn: () => void,
    ms: number,
  ) => ReturnType<typeof setTimeout>;
  private readonly clearTimer: (timer: ReturnType<typeof setTimeout>) => void;
  private timer?: ReturnType<typeof setTimeout>;
  private sweeping = false;

  constructor(
    private readonly source: {
      /** Every live process record, across every workspace this registry holds. */
      snapshot(): Array<{
        id: string;
        command: string;
        status: string;
        exitCode?: number | null;
        workspaceRoot: string;
        startedAt: string;
        endedAt?: string;
        pid?: number | null;
      }>;
      /** Mark a record terminal and return it, or `undefined` if already was. */
      settle(input: {
        id: string;
        workspaceRoot: string;
        status: "exited" | "failed";
      }): ManagedProcessSettledEvent | undefined;
      /** Mark a record ready when its pattern matches; report the flip. */
      ready?(input: { id: string; workspaceRoot: string }): Promise<boolean>;
    },
    options: ProcessObserverOptions = {},
  ) {
    this.pollMs = options.pollMs ?? DEFAULT_PROCESS_POLL_MS;
    this.setTimer = options.setTimer ?? ((fn, ms) => setTimeout(fn, ms));
    this.clearTimer = options.clearTimer ?? ((timer) => clearTimeout(timer));
  }

  /**
   * Register a notice sink: terminal transitions AND readiness flips. The
   * union is the spine's shape — a sink that only cares about settling
   * filters on the kind (the wait tool does).
   */
  subscribe(
    fn: (event: ManagedProcessSettledEvent | ManagedProcessReadyEvent) => void,
  ): () => void {
    this.subscribers.add(fn);
    return () => {
      this.subscribers.delete(fn);
    };
  }

  /** True while the sweep is armed. */
  get armed(): boolean {
    return this.timer !== undefined;
  }

  /**
   * Arm the sweep when any process is running, and disarm it when none is.
   *
   * Called after every start, stop and settle, so the interval exists exactly as
   * long as there is something to watch.
   */
  sync(): void {
    const running = this.source
      .snapshot()
      .some((info) => info.status === "running");
    if (running) {
      if (this.timer) return;
      const timer = this.setTimer(() => void this.sweep(), this.pollMs);
      // Never hold the process open for a poll nobody is waiting on.
      timer.unref?.();
      this.timer = timer;
      return;
    }
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
  }

  /** Run one sweep now. Exported so a test can drive it without a clock. */
  async sweep(): Promise<void> {
    if (this.sweeping) return;
    this.sweeping = true;
    try {
      for (const info of this.source.snapshot()) {
        if (info.status !== "running" || !info.pid) continue;
        // The readiness probe runs before the liveness check: a process can
        // become ready and exit in the same poll window, and the ready
        // notice is the one a model is likely waiting for.
        if (this.source.ready) {
          const newlyReady = await this.source.ready({
            id: info.id,
            workspaceRoot: info.workspaceRoot,
          });
          if (newlyReady)
            for (const subscriber of [...this.subscribers])
              subscriber({
                kind: "ready",
                id: info.id,
                workspaceRoot: info.workspaceRoot,
              });
        }
        // A live pid answers signal 0; anything else has exited. The record is
        // settled through the source so the registry stays the only writer.
        let alive = true;
        try {
          process.kill(info.pid, 0);
        } catch {
          alive = false;
        }
        if (alive) continue;
        const settled = this.source.settle({
          id: info.id,
          workspaceRoot: info.workspaceRoot,
          status: "exited",
        });
        if (settled) this.emit(settled);
      }
    } finally {
      this.sweeping = false;
      this.sync();
    }
  }

  /** Disarm and drop every subscriber. */
  dispose(): void {
    if (this.timer) {
      this.clearTimer(this.timer);
      this.timer = undefined;
    }
    this.subscribers.clear();
  }

  private emit(event: ManagedProcessSettledEvent) {
    for (const subscriber of [...this.subscribers]) subscriber(event);
  }
}
