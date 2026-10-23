import styles from "./styles/status-panel.module.css";
import { createSignal, Show, onCleanup, onMount, For } from "solid-js";
import type { AppState, CapabilityView, ToolBlock } from "@natalia/view-store";
import {
  newestOperationRecords,
  operationRecordLine,
} from "./operation-records";
import type {
  RuntimeClient,
  RuntimeDiagnostic,
  RuntimeStatusSnapshot,
} from "@anthelia/contracts";
import { humanizeToolResult } from "@natalia/ui-model";

type Tab = "status" | "diagnostics" | "tools";

function formatToolDetail(
  tool: ToolBlock,
  t: (key: string, params?: Record<string, unknown>) => string,
): string {
  const raw = tool.result ?? tool.summary ?? tool.argumentsRaw ?? "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parts: string[] = [];
      if (typeof parsed.id === "string") parts.push(`id: ${parsed.id}`);
      if (typeof parsed.terminalID === "string")
        parts.push(`terminal: ${parsed.terminalID}`);
      if (typeof parsed.writtenBytes === "number")
        parts.push(t("status.writeBytes", { bytes: parsed.writtenBytes }));
      if (typeof parsed.delivery === "string")
        parts.push(`delivery: ${parsed.delivery}`);
      if ("submitted" in parsed)
        parts.push(`submitted: ${String(parsed.submitted)}`);
      if (typeof parsed.terminalKey === "string")
        parts.push(t("status.key", { key: parsed.terminalKey }));
      if (typeof parsed.path === "string")
        parts.push(t("status.path", { path: parsed.path }));
      if (typeof parsed.text === "string" && parsed.text)
        parts.push(parsed.text);
      if (typeof parsed.command === "string" && parsed.command)
        parts.push(parsed.command);
      if (parts.length) return parts.join("\n");
      // No known field matched: the model layer's flattener is the floor,
      // the same one the transcript uses — a bespoke entry-dump here is how
      // this panel used to show raw JSON for every tool outside the five
      // hand-written keys above.
      return humanizeToolResult(raw, tool.name);
    }
  } catch {
    // not JSON; show raw below
  }
  return raw.length > 2000 ? `${raw.slice(0, 2000)}\n…` : raw;
}

function needsRawDetail(
  tool: ToolBlock,
  t: (key: string, params?: Record<string, unknown>) => string,
): boolean {
  const raw = tool.result ?? tool.summary ?? tool.argumentsRaw ?? "";
  return formatToolDetail(tool, t).trim() !== raw.trim();
}

function shortToolLabel(tool: ToolBlock): string {
  const raw = tool.argumentsRaw || "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    const candidate =
      typeof parsed.path === "string"
        ? parsed.path
        : typeof parsed.text === "string"
          ? parsed.text
          : typeof parsed.command === "string"
            ? parsed.command
            : JSON.stringify(parsed);
    return candidate.length > 96 ? `${candidate.slice(0, 96)}…` : candidate;
  } catch {
    const fallback = raw || tool.summary || "";
    return fallback.length > 96 ? `${fallback.slice(0, 96)}…` : fallback;
  }
}

export function StatusPanel(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  open: boolean;
  onClose: () => void;
  state: AppState;
  runtime?: RuntimeClient;
}) {
  const t = props.t;
  const [tab, setTab] = createSignal<Tab>("status");
  const [statusData, setStatusData] = createSignal<
    RuntimeStatusSnapshot | undefined
  >();
  const [diagRows, setDiagRows] = createSignal<RuntimeDiagnostic[]>([]);
  // The L1 cache card's line (pure beside the panel's other helpers):
  // the aggregate hits/misses, per-kind in the title.
  const cacheLine = () => {
    const cache = props.state.intelligence?.cache;
    if (!cache) return undefined;
    const total = cache.hits + cache.misses;
    if (!total)
      return { text: t("status.noQuery"), title: t("status.noQueryTitle") };
    const percent = Math.round((cache.hits / total) * 1000) / 10;
    const perKind = Object.entries(cache.byKind)
      .map(
        ([kind, metrics]) =>
          `${kind}: ${metrics.hits}/${metrics.misses + metrics.hits}`,
      )
      .join(" · ");
    return {
      text: t("status.cacheHit", { percent, hits: cache.hits, total }),
      title: perKind || t("status.noKindCounts"),
    };
  };
  // The provider prefix-cache tier (RINA Phase 5): the share of the
  // session's billed input the provider served from its prefix cache.
  const providerCacheLine = () => {
    const provider = props.state.intelligence?.cache?.provider;
    if (!provider) return undefined;
    const percent = Math.round(provider.hitShare * 1000) / 10;
    return {
      text: `命中 ${percent}%（${provider.cacheReadTokens}/${provider.inputTokens + provider.cacheReadTokens}）`,
      title: t("status.providerCacheTitle", { steps: provider.steps }),
    };
  };
  const [opRows, setOpRows] = createSignal<
    import("@anthelia/contracts").OperationRecord[]
  >([]);
  const [expandedTool, setExpandedTool] = createSignal<string | undefined>(
    undefined,
  );

  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", handleKeydown);
    onCleanup(() => window.removeEventListener("keydown", handleKeydown));

    if (props.runtime) {
      void props.runtime
        .runtimeStatus?.(props.state.sessionID)
        .then((value) => setStatusData(value));
      void props.runtime
        .diagnostics?.(undefined, props.state.sessionID)
        .then((value) => {
          if (value) setDiagRows(value);
        });
      // T3/T4: the operation log's records — the telemetry zone beside the
      // journal's diagnostics. The runtime face owns the directory.
      void props.runtime.operationRecords?.({ limit: 60 }).then((value) => {
        if (value) setOpRows(value);
      });
    }
  });

  return (
    <Show when={props.open}>
      <div class="neu-settings-backdrop" onClick={props.onClose}>
        <div class={styles.window} onClick={(event) => event.stopPropagation()}>
          <div class="neu-settings-header">
            <span class="neu-settings-title">{t("status.title")}</span>
            <button
              type="button"
              class="neu-settings-close"
              onClick={props.onClose}
              aria-label={t("status.closeAria")}
            >
              <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                <path
                  d="M3 3l10 10M13 3L3 13"
                  stroke="currentColor"
                  stroke-width="1.4"
                  stroke-linecap="round"
                />
              </svg>
            </button>
          </div>
          <div class={styles.tabs}>
            <button
              type="button"
              class="neu-settings-category"
              data-active={tab() === "status"}
              onClick={() => setTab("status")}
            >
              {t("status.runtimeState")}
            </button>
            <button
              type="button"
              class="neu-settings-category"
              data-active={tab() === "diagnostics"}
              onClick={() => setTab("diagnostics")}
            >
              {t("status.diagnostics")}
            </button>
            <button
              type="button"
              class="neu-settings-category"
              data-active={tab() === "tools"}
              onClick={() => setTab("tools")}
            >
              {t("status.toolsCapabilities")}
            </button>
          </div>
          <div class={styles.content}>
            <Show when={tab() === "status"}>
              <div class={styles.grid}>
                <div class={styles.card}>
                  <span class={styles.cardLabel}>Runtime</span>
                  <span class={styles.cardValue}>{props.state.status}</span>
                </div>
                <div class={styles.card}>
                  <span class={styles.cardLabel}>
                    {t("status.currentModel")}
                  </span>
                  <span class={styles.cardValue}>
                    {statusData()?.model ??
                      props.state.modelSelection?.modelID ??
                      t("status.unselected")}
                  </span>
                </div>
                <div class={styles.card}>
                  <span class={styles.cardLabel}>Provider</span>
                  <span class={styles.cardValue}>
                    {statusData()?.provider ?? t("status.unselected")}
                  </span>
                </div>
                <div class={styles.card}>
                  <span class={styles.cardLabel}>{t("status.workspace")}</span>
                  <span class={styles.cardValue}>
                    {statusData()?.cwd ?? "unknown"}
                  </span>
                </div>
                <div class={styles.card}>
                  <span class={styles.cardLabel}>{t("status.session")}</span>
                  <span class={styles.cardValue}>
                    {props.state.sessionID ?? t("status.none")}
                  </span>
                </div>
                {/*
                  The L1 read fabric's earning (DoD #3's "命中", now
                  observable): the aggregate over the snapshot's per-kind
                  counters. Absent on a snapshot without the posture (an
                  older build's event) renders nothing.
                */}
                <Show when={cacheLine()}>
                  {(line) => (
                    <div class={styles.card}>
                      <span class={styles.cardLabel}>
                        {t("status.readCacheL1")}
                      </span>
                      <span class={styles.cardValue} title={line().title}>
                        {line().text}
                      </span>
                    </div>
                  )}
                </Show>
                {/* The provider's own prefix cache (Phase 5): a tier
                    independent of the fabric — present whenever the
                    session has run steps, with or without an L1. */}
                <Show when={providerCacheLine()}>
                  {(line) => (
                    <div class={styles.card}>
                      <span class={styles.cardLabel}>
                        {t("status.prefixCache")}
                      </span>
                      <span class={styles.cardValue} title={line().title}>
                        {line().text}
                      </span>
                    </div>
                  )}
                </Show>
                <div class={styles.card}>
                  <span class={styles.cardLabel}>{t("status.context")}</span>
                  <span class={styles.cardValue}>
                    {statusData()?.context ?? "—"}
                  </span>
                </div>
                {/* Provider steps, the same figure the session usage bar
                      counts — one per `runtime.step_usage`. The runtime's
                      `step` field is the journal's entry count, a different
                      measure that used to be printed as "steps" and made one
                      run read as 422 here and 140 on the usage bar. */}
                <div class={styles.card}>
                  <span class={styles.cardLabel}>{t("status.steps")}</span>
                  <span class={styles.cardValue} title={t("status.stepsTitle")}>
                    {statusData()?.steps ?? "—"}
                  </span>
                </div>
              </div>
            </Show>
            <Show when={tab() === "diagnostics"}>
              <div class={styles.diagnostics}>
                <For each={diagRows()}>
                  {(item) => (
                    <div class={styles.diagnosticRow} data-level={item.level}>
                      <span class={styles.diagnosticLevel}>{item.level}</span>
                      <span class={styles.diagnosticMessage}>
                        {item.message}
                      </span>
                      <span class={styles.diagnosticTime}>{item.at ?? ""}</span>
                    </div>
                  )}
                </For>
              </div>
              {/*
                The operation log's records (T3/T4): the telemetry zone
                beside the journal's diagnostics, read through the runtime
                face — the same records the debug bundle reads.
              */}
              <Show when={opRows().length > 0}>
                <div class={styles.sectionTitle}>{t("status.opLog")}</div>
                <div class={styles.diagnostics}>
                  <For each={newestOperationRecords(opRows())}>
                    {(record) => {
                      const line = operationRecordLine(record);
                      return (
                        <div
                          class={styles.diagnosticRow}
                          data-level={line.level}
                          title={line.title}
                        >
                          <span class={styles.diagnosticLevel}>
                            {line.level}
                          </span>
                          <span class={styles.diagnosticMessage}>
                            {line.component} · {line.message}
                          </span>
                          <span class={styles.diagnosticTime}>{line.at}</span>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </Show>
            <Show when={tab() === "tools"}>
              <div class={styles.tools}>
                <div class={styles.sectionTitle}>{t("status.tools")}</div>
                <For each={Object.values(props.state.tools).slice(-60)}>
                  {(tool: ToolBlock) => (
                    <div>
                      <button
                        type="button"
                        class={styles.toolRow}
                        data-active={expandedTool() === tool.name + tool.callID}
                        onClick={() =>
                          setExpandedTool((value) =>
                            value === tool.name + tool.callID
                              ? undefined
                              : tool.name + tool.callID,
                          )
                        }
                      >
                        <span class={styles.toolName}>{tool.name}</span>
                        <span class={styles.toolArrow}>
                          {expandedTool() === tool.name + tool.callID
                            ? "▾"
                            : "▸"}
                        </span>
                        <span class={styles.toolStatus}>{tool.status}</span>
                      </button>
                      <Show when={expandedTool() === tool.name + tool.callID}>
                        <div class={styles.toolDetail}>
                          <div class={styles.toolDetailSummary}>
                            {formatToolDetail(tool, t)}
                          </div>
                          <Show when={needsRawDetail(tool, t)}>
                            <pre class={styles.toolDetailRaw}>
                              {tool.result ??
                                tool.summary ??
                                tool.argumentsRaw ??
                                ""}
                            </pre>
                          </Show>
                        </div>
                      </Show>
                    </div>
                  )}
                </For>
                <div class={styles.sectionTitle}>
                  {t("status.capabilities")}
                </div>
                <For each={Object.values(props.state.capabilities)}>
                  {(cap: CapabilityView) => (
                    <div class={styles.capRow}>
                      <span class={styles.capName}>{cap.name ?? cap.id}</span>
                      <span class={styles.capVersion}>v{cap.version}</span>
                      <span class={styles.capGrants}>
                        {(cap.grants ?? []).join(" · ")}
                      </span>
                    </div>
                  )}
                </For>
              </div>
            </Show>
          </div>
        </div>
      </div>
    </Show>
  );
}
