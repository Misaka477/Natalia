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

type Tab = "status" | "diagnostics" | "tools";

function formatToolDetail(tool: ToolBlock): string {
  const raw = tool.result ?? tool.summary ?? tool.argumentsRaw ?? "";
  try {
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
      const parts: string[] = [];
      if (typeof parsed.id === "string") parts.push(`id: ${parsed.id}`);
      if (typeof parsed.terminalID === "string")
        parts.push(`terminal: ${parsed.terminalID}`);
      if (typeof parsed.writtenBytes === "number")
        parts.push(`写入 ${parsed.writtenBytes} 字节`);
      if (typeof parsed.delivery === "string")
        parts.push(`delivery: ${parsed.delivery}`);
      if ("submitted" in parsed)
        parts.push(`submitted: ${String(parsed.submitted)}`);
      if (typeof parsed.terminalKey === "string")
        parts.push(`按键: ${parsed.terminalKey}`);
      if (typeof parsed.path === "string") parts.push(`路径: ${parsed.path}`);
      if (typeof parsed.text === "string" && parsed.text)
        parts.push(parsed.text);
      if (typeof parsed.command === "string" && parsed.command)
        parts.push(parsed.command);
      if (parts.length) return parts.join("\n");
      return Object.entries(parsed)
        .map(
          ([key, value]) =>
            `${key}: ${typeof value === "object" ? JSON.stringify(value) : String(value)}`,
        )
        .join("\n");
    }
  } catch {
    // not JSON; show raw below
  }
  return raw.length > 2000 ? `${raw.slice(0, 2000)}\n…` : raw;
}

function needsRawDetail(tool: ToolBlock): boolean {
  const raw = tool.result ?? tool.summary ?? tool.argumentsRaw ?? "";
  return formatToolDetail(tool).trim() !== raw.trim();
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
  open: boolean;
  onClose: () => void;
  state: AppState;
  runtime?: RuntimeClient;
}) {
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
    if (!total) return { text: "无查询", title: "尚无读查询经过缓存" };
    const percent = Math.round((cache.hits / total) * 1000) / 10;
    const perKind = Object.entries(cache.byKind)
      .map(
        ([kind, metrics]) =>
          `${kind}: ${metrics.hits}/${metrics.misses + metrics.hits}`,
      )
      .join(" · ");
    return {
      text: `命中 ${percent}%（${cache.hits}/${total}）`,
      title: perKind || "无分类计数",
    };
  };
  // The provider prefix-cache tier (RINA Phase 5): the share of the
  // session's billed input the provider served from its prefix cache.
  const providerCacheLine = () => {
    const provider = props.state.intelligence?.cache?.provider;
    if (!provider) return undefined;
    const percent = Math.round(provider.hitShare * 1000) / 10;
    return {
      text: `命中 ${percent}%（${provider.cacheReadTokens}/${provider.inputTokens}）`,
      title: `${provider.steps} 步的 provider 前缀缓存（静态前缀稳定是其命中前提）`,
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
        <div
          class="neu-status-window"
          onClick={(event) => event.stopPropagation()}
        >
          <div class="neu-settings-header">
            <span class="neu-settings-title">状态与诊断</span>
            <button
              type="button"
              class="neu-settings-close"
              onClick={props.onClose}
              aria-label="关闭状态与诊断"
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
          <div class="neu-status-tabs">
            <button
              type="button"
              class="neu-settings-category"
              data-active={tab() === "status"}
              onClick={() => setTab("status")}
            >
              运行时状态
            </button>
            <button
              type="button"
              class="neu-settings-category"
              data-active={tab() === "diagnostics"}
              onClick={() => setTab("diagnostics")}
            >
              诊断
            </button>
            <button
              type="button"
              class="neu-settings-category"
              data-active={tab() === "tools"}
              onClick={() => setTab("tools")}
            >
              工具与能力
            </button>
          </div>
          <div class="neu-status-content">
            <Show when={tab() === "status"}>
              <div class="neu-status-grid">
                <div class="neu-status-card">
                  <span class="neu-status-card-label">Runtime</span>
                  <span class="neu-status-card-value">
                    {props.state.status}
                  </span>
                </div>
                <div class="neu-status-card">
                  <span class="neu-status-card-label">当前模型</span>
                  <span class="neu-status-card-value">
                    {statusData()?.model ??
                      props.state.modelSelection?.modelID ??
                      "未选择"}
                  </span>
                </div>
                <div class="neu-status-card">
                  <span class="neu-status-card-label">Provider</span>
                  <span class="neu-status-card-value">
                    {statusData()?.provider ?? "未选择"}
                  </span>
                </div>
                <div class="neu-status-card">
                  <span class="neu-status-card-label">工作区</span>
                  <span class="neu-status-card-value">
                    {statusData()?.cwd ?? "unknown"}
                  </span>
                </div>
                <div class="neu-status-card">
                  <span class="neu-status-card-label">会话</span>
                  <span class="neu-status-card-value">
                    {props.state.sessionID ?? "无"}
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
                    <div class="neu-status-card">
                      <span class="neu-status-card-label">读缓存 L1</span>
                      <span class="neu-status-card-value" title={line().title}>
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
                    <div class="neu-status-card">
                      <span class="neu-status-card-label">前缀缓存</span>
                      <span class="neu-status-card-value" title={line().title}>
                        {line().text}
                      </span>
                    </div>
                  )}
                </Show>
                <div class="neu-status-card">
                  <span class="neu-status-card-label">上下文</span>
                  <span class="neu-status-card-value">
                    {statusData()?.context ?? "—"}
                  </span>
                </div>
              </div>
            </Show>
            <Show when={tab() === "diagnostics"}>
              <div class="neu-status-diagnostics">
                <For each={diagRows()}>
                  {(item) => (
                    <div class="neu-diagnostic-row" data-level={item.level}>
                      <span class="neu-diagnostic-level">{item.level}</span>
                      <span class="neu-diagnostic-message">{item.message}</span>
                      <span class="neu-diagnostic-time">{item.at ?? ""}</span>
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
                <div class="neu-status-section-title">操作日志</div>
                <div class="neu-status-diagnostics">
                  <For each={newestOperationRecords(opRows())}>
                    {(record) => {
                      const line = operationRecordLine(record);
                      return (
                        <div
                          class="neu-diagnostic-row"
                          data-level={line.level}
                          title={line.title}
                        >
                          <span class="neu-diagnostic-level">{line.level}</span>
                          <span class="neu-diagnostic-message">
                            {line.component} · {line.message}
                          </span>
                          <span class="neu-diagnostic-time">{line.at}</span>
                        </div>
                      );
                    }}
                  </For>
                </div>
              </Show>
            </Show>
            <Show when={tab() === "tools"}>
              <div class="neu-status-tools">
                <div class="neu-status-section-title">工具</div>
                <For each={Object.values(props.state.tools).slice(-60)}>
                  {(tool: ToolBlock) => (
                    <div>
                      <button
                        type="button"
                        class="neu-status-tool-row"
                        data-active={expandedTool() === tool.name + tool.callID}
                        onClick={() =>
                          setExpandedTool((value) =>
                            value === tool.name + tool.callID
                              ? undefined
                              : tool.name + tool.callID,
                          )
                        }
                      >
                        <span class="neu-status-tool-name">{tool.name}</span>
                        <span class="neu-status-tool-arrow">
                          {expandedTool() === tool.name + tool.callID
                            ? "▾"
                            : "▸"}
                        </span>
                        <span class="neu-status-tool-status">
                          {tool.status}
                        </span>
                      </button>
                      <Show when={expandedTool() === tool.name + tool.callID}>
                        <div class="neu-status-tool-detail">
                          <div class="neu-status-tool-detail-summary">
                            {formatToolDetail(tool)}
                          </div>
                          <Show when={needsRawDetail(tool)}>
                            <pre class="neu-status-tool-detail-raw">
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
                <div class="neu-status-section-title">能力</div>
                <For each={Object.values(props.state.capabilities)}>
                  {(cap: CapabilityView) => (
                    <div class="neu-status-cap-row">
                      <span class="neu-status-cap-name">
                        {cap.name ?? cap.id}
                      </span>
                      <span class="neu-status-cap-version">v{cap.version}</span>
                      <span class="neu-status-cap-grants">
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
