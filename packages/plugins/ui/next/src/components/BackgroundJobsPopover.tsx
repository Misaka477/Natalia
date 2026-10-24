import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import type { RuntimeClient } from "@anthelia/contracts";
import type { AppState } from "@natalia/view-store";
import styles from "../styles/background-jobs.module.css";

export interface UnifiedJobItem {
  id: string;
  rawID: string;
  category: "terminal" | "subagent" | "tool";
  kindBadge: string;
  label: string;
  status: "running" | "completed" | "failed" | "stopped";
  detail: string;
  output?: string;
  startedAt?: number;
  finishedAt?: number;
  durationMs?: number;
}

function formatJobDuration(
  elapsedMs: number,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const totalSeconds = Math.max(0, Math.floor(elapsedMs / 1000));
  const seconds = totalSeconds % 60;
  const minutes = Math.floor(totalSeconds / 60) % 60;
  const hours = Math.floor(totalSeconds / 3600);
  if (hours > 0) return t("jobs.durationHours", { hours, minutes });
  if (minutes > 0) return t("jobs.durationMinutes", { minutes, seconds });
  return t("jobs.durationSeconds", { seconds });
}

export function deriveUnifiedJobs(
  state: AppState,
  clearedIDs: ReadonlySet<string>,
): UnifiedJobItem[] {
  const items: UnifiedJobItem[] = [];

  // 1. Terminals
  for (const term of Object.values(state.terminals ?? {})) {
    const id = `term:${term.id}`;
    if (clearedIDs.has(id)) continue;
    const isRunning =
      term.status === "running" ||
      term.status === "starting" ||
      term.activity === "running";
    const status: UnifiedJobItem["status"] = isRunning
      ? "running"
      : term.status === "failed"
        ? "failed"
        : term.status === "exited"
          ? "completed"
          : "stopped";
    const lastOutputMs = term.lastOutputAt
      ? Date.parse(term.lastOutputAt)
      : undefined;
    items.push({
      id,
      rawID: term.id,
      category: "terminal",
      kindBadge: term.command?.split(/[\\/]/u).pop()?.split(/\s+/u)[0] || "sh",
      label: term.prompt || term.command || term.id,
      status,
      detail: isRunning
        ? term.activity === "running"
          ? "running"
          : "waiting"
        : term.status,
      output: term.transcript || term.tail || undefined,
      startedAt: Number.isFinite(lastOutputMs) ? lastOutputMs : undefined,
      finishedAt:
        !isRunning && Number.isFinite(lastOutputMs) ? lastOutputMs : undefined,
    });
  }

  // 2. Subagents
  for (const sub of Object.values(state.subagentStream?.active ?? {})) {
    const id = `sub:${sub.id}`;
    if (clearedIDs.has(id)) continue;
    const isRunning = sub.status === "running";
    const status: UnifiedJobItem["status"] = isRunning
      ? "running"
      : sub.status === "failed"
        ? "failed"
        : sub.status === "stopped"
          ? "stopped"
          : "completed";
    items.push({
      id,
      rawID: sub.id,
      category: "subagent",
      kindBadge: "agent",
      label: sub.task || sub.id,
      status,
      detail: sub.activityDetail || sub.phase || sub.status,
      output: sub.text || undefined,
      startedAt: sub.startedAt,
      finishedAt: !isRunning ? sub.lastActivityAt : undefined,
    });
  }

  // 3. Running tool calls
  for (const [key, tool] of Object.entries(state.tools ?? {})) {
    if (tool.status !== "running" && tool.status !== "queued") continue;
    const id = `tool:${key}`;
    if (clearedIDs.has(id)) continue;
    items.push({
      id,
      rawID: key,
      category: "tool",
      kindBadge: tool.name,
      label: tool.summary || tool.name,
      status: "running",
      detail: tool.status,
      output: tool.result || tool.argumentsRaw || undefined,
      startedAt: tool.startedAt,
      durationMs: tool.durationMs,
    });
  }

  return items.sort((a, b) => {
    const liveA = a.status === "running";
    const liveB = b.status === "running";
    if (liveA !== liveB) return liveA ? -1 : 1;
    return (b.startedAt ?? 0) - (a.startedAt ?? 0);
  });
}

export interface BackgroundJobsPopoverProps {
  state: () => AppState;
  runtime?: RuntimeClient;
  sessionID: () => string | undefined;
  onOpenTerminal?: (terminalID: string) => void;
  onSelectSubagent?: () => void;
  t: (key: string, params?: Record<string, unknown>) => string;
}

export function BackgroundJobsPopover(props: BackgroundJobsPopoverProps) {
  const t = props.t;
  const [open, setOpen] = createSignal(false);
  const [expandedID, setExpandedID] = createSignal<string | null>(null);
  const [armedKillID, setArmedKillID] = createSignal<string | null>(null);
  const [clearedIDs, setClearedIDs] = createSignal<Set<string>>(new Set());
  const [now, setNow] = createSignal(Date.now());
  let rootRef: HTMLDivElement | undefined;

  const jobs = createMemo(() => deriveUnifiedJobs(props.state(), clearedIDs()));
  const liveJobs = createMemo(() =>
    jobs().filter((item) => item.status === "running"),
  );
  const settledJobs = createMemo(() =>
    jobs().filter((item) => item.status !== "running"),
  );

  // Live clock while popover is open
  createEffect(() => {
    if (!open()) return;
    setNow(Date.now());
    const timer = setInterval(() => setNow(Date.now()), 1000);
    onCleanup(() => clearInterval(timer));
  });

  // Dismiss on outside click
  createEffect(() => {
    if (!open()) return;
    const onPointerDown = (event: MouseEvent) => {
      if (rootRef && !rootRef.contains(event.target as Node)) {
        setOpen(false);
        setArmedKillID(null);
      }
    };
    document.addEventListener("mousedown", onPointerDown);
    onCleanup(() => document.removeEventListener("mousedown", onPointerDown));
  });

  // Auto-disarm kill confirmation after 3s
  createEffect(() => {
    const armed = armedKillID();
    if (!armed) return;
    const timer = setTimeout(() => setArmedKillID(null), 3000);
    onCleanup(() => clearTimeout(timer));
  });

  const handleStopJob = async (job: UnifiedJobItem) => {
    if (armedKillID() !== job.id) {
      setArmedKillID(job.id);
      return;
    }
    setArmedKillID(null);
    if (job.category === "terminal") {
      await props.runtime?.nativeTerminalStop?.(job.rawID, props.sessionID());
    }
  };

  const clearSettled = () => {
    setClearedIDs((prev) => {
      const next = new Set(prev);
      for (const item of settledJobs()) next.add(item.id);
      return next;
    });
  };

  const durationText = (job: UnifiedJobItem) => {
    if (job.durationMs !== undefined) {
      return formatJobDuration(job.durationMs, t);
    }
    if (job.status === "running" && job.startedAt) {
      return formatJobDuration(Math.max(0, now() - job.startedAt), t);
    }
    if (job.startedAt && job.finishedAt) {
      return formatJobDuration(Math.max(0, job.finishedAt - job.startedAt), t);
    }
    return "";
  };

  return (
    <Show when={jobs().length > 0}>
      <div ref={rootRef} class={styles.wrap}>
        <button
          type="button"
          class={styles.trigger}
          data-open={open()}
          onClick={() => setOpen((v) => !v)}
        >
          <span
            class={styles.dot}
            data-status={liveJobs().length > 0 ? "running" : "completed"}
          />
          <span>{t("jobs.triggerCount", { count: jobs().length })}</span>
          <svg
            width="12"
            height="12"
            viewBox="0 0 16 16"
            fill="none"
            class={styles.triggerChevron}
          >
            <path
              d="M4 6l4 4 4-4"
              stroke="currentColor"
              stroke-width="1.4"
              stroke-linecap="round"
              stroke-linejoin="round"
            />
          </svg>
        </button>

        <Show when={open()}>
          <div
            class={styles.popover}
            role="dialog"
            aria-label={t("jobs.title")}
          >
            <Show when={settledJobs().length > 0 && liveJobs().length > 0}>
              <div class={styles.sectionHeader}>
                <span>{t("jobs.runningSection")}</span>
              </div>
            </Show>

            <ul class={styles.list}>
              <For each={jobs()}>
                {(job) => {
                  const isExpanded = () => expandedID() === job.id;
                  const isArmed = () => armedKillID() === job.id;
                  return (
                    <li class={styles.item}>
                      <div
                        class={styles.rowLine}
                        data-live={job.status === "running"}
                      >
                        <button
                          type="button"
                          class={styles.rowBtn}
                          onClick={() =>
                            setExpandedID((prev) =>
                              prev === job.id ? null : job.id,
                            )
                          }
                        >
                          <span class={styles.dot} data-status={job.status} />
                          <span class={styles.kindBadge}>{job.kindBadge}</span>
                          <span class={styles.label} title={job.label}>
                            {job.label}
                          </span>
                          <span class={styles.detail}>{job.detail}</span>
                          <Show when={durationText(job)}>
                            <span class={styles.duration}>
                              {durationText(job)}
                            </span>
                          </Show>
                        </button>

                        <Show
                          when={
                            job.category === "terminal" && props.onOpenTerminal
                          }
                        >
                          <button
                            type="button"
                            class={styles.iconAction}
                            title={t("jobs.openTerminal")}
                            onClick={() => {
                              setOpen(false);
                              props.onOpenTerminal?.(job.rawID);
                            }}
                          >
                            ↗
                          </button>
                        </Show>

                        <Show
                          when={
                            job.status === "running" &&
                            job.category === "terminal"
                          }
                        >
                          <button
                            type="button"
                            class={styles.stopBtn}
                            data-armed={isArmed()}
                            title={
                              isArmed() ? t("jobs.confirmStop") : t("jobs.stop")
                            }
                            onClick={() => void handleStopJob(job)}
                          >
                            ■
                            <Show when={isArmed()}>
                              <span>{t("jobs.confirmStopShort")}</span>
                            </Show>
                          </button>
                        </Show>
                      </div>

                      <Show when={isExpanded() && job.output}>
                        <div class={styles.outputPanel}>
                          <pre class={styles.outputPre}>{job.output}</pre>
                        </div>
                      </Show>
                    </li>
                  );
                }}
              </For>
            </ul>

            <Show when={settledJobs().length > 0}>
              <div class={styles.footerBar}>
                <button
                  type="button"
                  class={styles.clearBtn}
                  onClick={clearSettled}
                >
                  {t("jobs.clearSettled")}
                </button>
              </div>
            </Show>
          </div>
        </Show>
      </div>
    </Show>
  );
}
