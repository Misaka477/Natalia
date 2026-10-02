import type { RuntimeEvent } from "@anthelia/contracts";

export function compactionDisplayLine(event: RuntimeEvent) {
  if (event.type === "context.status") {
    return `Context ${event.used}/${event.max} source=${event.source} threshold=${event.thresholdPercent}% reserved=${event.reserved}`;
  }
  if (event.type === "compaction.begin") {
    return `Compacting after ${event.trigger}: ${event.beforeTokens}/${event.maxTokens}, reserved ${event.reservedTokens}`;
  }
  if (event.type === "compaction.end") {
    return event.success
      ? `Compaction complete: ${event.beforeTokens} -> ${event.afterTokens} tokens in ${event.durationMs}ms`
      : `Compaction failed atomically: ${event.error ?? "unknown"}`;
  }
  if (event.type === "context.limit.recovery") {
    return event.compacted
      ? "Context-limit recovery compacted once; retrying original step"
      : "Context-limit recovery requested";
  }
  return undefined;
}
