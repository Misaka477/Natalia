import { Show } from "solid-js";

export interface ContextUsageView {
  used: number;
  max?: number;
  /**
   * The conservative full-request estimate (header + message surface), which
   * tracks what is actually about to be sent.
   *
   * `used` may be a PROVIDER sample, and a sample goes stale the moment a request
   * fails or a step appends without a fresh report: measured on a real session,
   * the ring read 12% while the next request was over a million tokens and
   * compaction fired. The ring therefore shows the LARGER of the two — a staleness
   * can then only under-report, never over-report.
   */
  requestTokens?: number;
  source?: string;
  thresholdPercent?: number;
  reserved?: number;
  trigger?: string;
  pressureTokens?: number;
  projectedTokens?: number;
  contextWindow?: number;
}

/**
 * The figure the ring draws: the provider sample or the local estimate, whichever
 * is larger. Pure so the choice is testable.
 */
export function effectiveContextUsed(usage: {
  used: number;
  requestTokens?: number;
}): number {
  const estimate = usage.requestTokens ?? 0;
  return Math.max(0, usage.used, estimate);
}

/** Whether the ring is showing the estimate because the sample is behind it. */
export function usedIsEstimate(usage: {
  used: number;
  requestTokens?: number;
}): boolean {
  return (usage.requestTokens ?? 0) > usage.used;
}

function formatTokens(value: number): string {
  if (!Number.isFinite(value) || value < 0) return "—";
  if (value >= 1_000_000) return `${Number((value / 1_000_000).toFixed(1))}M`;
  if (value >= 1_000) return `${Number((value / 1_000).toFixed(1))}k`;
  return String(Math.round(value));
}

function titleFor(usage: ContextUsageView): string {
  const capacity = usage.max ?? usage.contextWindow;
  return [
    `Context ${effectiveContextUsed(usage)}${capacity === undefined ? "" : ` / ${capacity}`}`,
    `Source ${usage.source ?? "estimate"}`,
    usedIsEstimate(usage)
      ? `Showing the local estimate ${formatTokens(usage.requestTokens ?? 0)} — the provider sample (${formatTokens(usage.used)}) is behind it`
      : undefined,
    usage.reserved === undefined ? undefined : `Reserved ${usage.reserved}`,
    usage.thresholdPercent === undefined
      ? undefined
      : `Compact threshold ${usage.thresholdPercent}%`,
    usage.trigger ? `Trigger ${usage.trigger}` : undefined,
  ]
    .filter((line): line is string => line !== undefined)
    .join("\n");
}

export function ContextMeter(props: {
  usage?: ContextUsageView;
  compact?: boolean;
}) {
  const capacity = () => props.usage?.max ?? props.usage?.contextWindow;
  const available = () =>
    props.usage !== undefined &&
    capacity() !== undefined &&
    Number.isFinite(capacity()) &&
    (capacity() ?? 0) > 0;
  const percent = () => {
    const usage = props.usage;
    const max = capacity();
    if (!usage || max === undefined || max <= 0) return 0;
    return Math.max(0, Math.round((effectiveContextUsed(usage) / max) * 100));
  };
  const status = () => {
    const usage = props.usage;
    if (!usage) return "normal";
    if (usage.trigger) return "compacting";
    const threshold = usage.thresholdPercent ?? 85;
    if (percent() >= threshold) return "critical";
    if (percent() >= threshold * 0.8) return "warning";
    return "normal";
  };

  return (
    <Show when={available()}>
      <span
        class="natalia-context-meter"
        data-status={status()}
        title={titleFor(props.usage!)}
        style={{ "--context-percent": `${Math.min(100, percent())}%` }}
      >
        <span class="natalia-context-meter-ring" aria-hidden="true" />
        <span class="natalia-context-meter-label">
          {props.compact
            ? `${percent()}%`
            : `${percent()}% · ${formatTokens(props.usage!.used)}/${formatTokens(capacity()!)}`}
        </span>
      </span>
    </Show>
  );
}
