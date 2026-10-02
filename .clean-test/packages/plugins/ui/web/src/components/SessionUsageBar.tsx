import { Show, createMemo } from "solid-js";
import * as viewStore from "@natalia/view-store";
import type {
  AppState,
  SessionUsageStats,
  SessionUsageView,
} from "@natalia/view-store";

function formatCount(value: number): string {
  if (value >= 1_000_000) return `${(value / 1_000_000).toFixed(2)}M`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  return String(value);
}

function formatMs(ms: number): string {
  if (ms >= 60_000) return `${(ms / 60_000).toFixed(1)}m`;
  if (ms >= 1_000) return `${(ms / 1_000).toFixed(1)}s`;
  return `${Math.round(ms)}ms`;
}

/**
 * Session token / latency dashboard bar (the data-interface consumer): renders
 * the per-session `deriveSessionUsageView` figures — steps, input/output/cache
 * tokens, cache hit rate, model/tool wall time, average first-token latency and
 * decode throughput. Session-scoped like the Work Graph: it reads the currently
 * active session's state, so switching sessions switches the figures. Cost is
 * intentionally absent (the user computes it).
 */
export function SessionUsageBar(props: {
  state?: AppState;
  usage?: SessionUsageStats;
}) {
  // Always present: a usage meter is a standing readout, not a popup. With no
  // steps yet the figures are all zero, which is the honest "nothing spent
  // yet" state — the bar still shows so the slot never flickers in and out.
  const view = createMemo<SessionUsageView>(() =>
    viewStore.deriveSessionUsageView(
      props.usage ??
        props.state?.usageByChannel?.main ??
        props.state?.sessionUsage ??
        viewStore.emptySessionUsageStats(),
    ),
  );

  return (
    <div class="session-usage-bar">
      <span
        class="session-usage-seg"
        title="Turns / provider steps this session"
      >
        {view().turns} 轮 · {view().steps} 步
      </span>
      <span class="session-usage-sep">·</span>
      <span
        class="session-usage-seg"
        title={`Input ${view().inputTokens} · cache read ${view().cacheReadInputTokens} · cache write ${view().cacheCreationInputTokens}`}
      >
        In {formatCount(view().inputTokens)} · Out{" "}
        {formatCount(view().outputTokens)}
      </span>
      <span class="session-usage-sep">·</span>
      <span
        class="session-usage-seg"
        title={`Cache read ${view().cacheReadInputTokens} · write ${view().cacheCreationInputTokens}`}
      >
        Cache R {formatCount(view().cacheReadInputTokens)} · W{" "}
        {formatCount(view().cacheCreationInputTokens)}
      </span>
      <span class="session-usage-sep">·</span>
      <span class="session-usage-seg" title="Cache read / total input">
        命中 {(view().cacheHitRate * 100).toFixed(1)}%
      </span>
      <span class="session-usage-sep">·</span>
      <span class="session-usage-seg" title="Model / tool wall time">
        LLM {formatMs(view().llmMs)} · 工具 {formatMs(view().toolMs)}
      </span>
      <Show when={view().ttftSteps > 0}>
        <span class="session-usage-sep">·</span>
        <span class="session-usage-seg" title="Average first-token latency">
          首 token {formatMs(view().avgTtftMs)}
        </span>
      </Show>
      <Show when={view().tokensPerSecond > 0}>
        <span class="session-usage-sep">·</span>
        <span class="session-usage-seg" title="Decode throughput">
          {view().tokensPerSecond.toFixed(0)} tok/s
        </span>
      </Show>
    </div>
  );
}
