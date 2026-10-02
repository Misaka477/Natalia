import { Show } from "solid-js";

export interface ContextUsageView {
  used: number;
  max?: number;
  source?: string;
  thresholdPercent?: number;
  reserved?: number;
  trigger?: string;
  pressureTokens?: number;
  projectedTokens?: number;
  contextWindow?: number;
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
    `Context ${usage.used}${capacity === undefined ? "" : ` / ${capacity}`}`,
    `Source ${usage.source ?? "estimate"}`,
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
    return Math.max(0, Math.round((usage.used / max) * 100));
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
