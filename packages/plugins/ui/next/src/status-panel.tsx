import styles from "./styles/status-panel.module.css";
import {
  createMemo,
  createSignal,
  For,
  onCleanup,
  onMount,
  Show,
} from "solid-js";
import type { AppState } from "@natalia/view-store";
import type {
  OperationLogLocation,
  OperationRecord,
  RuntimeClient,
} from "@anthelia/contracts";

type DomainFilter = "all" | "kernel" | "framework" | "plugin";
type LevelFilter = "all" | "error" | "warn" | "info" | "debug";

const KERNEL_COMPONENTS = new Set([
  "kernel",
  "runtime",
  "session",
  "session-store",
  "sqlite-store",
  "checkpoint",
  "memory-trace",
  "providers",
  "context-ledger",
  "rina",
  "event-window",
  "session-full-events",
]);

export function resolveRecordDomain(
  record: OperationRecord,
): "kernel" | "framework" | "plugin" {
  if (record.domain) return record.domain;
  if (
    record.pluginId ||
    record.component.startsWith("plugin:") ||
    record.component.startsWith("natalia.ui.")
  ) {
    return "plugin";
  }
  const clean = record.component.replace(/^\[|\]$/gu, "");
  if (KERNEL_COMPONENTS.has(clean)) return "kernel";
  return "framework";
}

export function resolveRecordLocation(
  record: OperationRecord,
): OperationLogLocation | undefined {
  return record.error?.location ?? record.location;
}

export function formatShortLocation(loc: OperationLogLocation): string {
  const norm = loc.file.replace(/\\/gu, "/");
  const base = norm.slice(norm.lastIndexOf("/") + 1) || norm;
  const cleanFn = loc.fn?.replace(/^async\s+/u, "").trim();
  if (cleanFn && cleanFn !== "<anonymous>") {
    return `${cleanFn} (${base}:${loc.line})`;
  }
  return `${base}:${loc.line}`;
}

export function formatTimeClock(iso: string): string {
  const d = new Date(iso);
  if (Number.isNaN(d.getTime())) return iso;
  const hh = String(d.getHours()).padStart(2, "0");
  const mm = String(d.getMinutes()).padStart(2, "0");
  const ss = String(d.getSeconds()).padStart(2, "0");
  const ms = String(d.getMilliseconds()).padStart(3, "0");
  return `${hh}:${mm}:${ss}.${ms}`;
}

/**
 * Format an OperationRecord in Chromium's canonical header format:
 * `[PID:domain:MMDD/HHMMSS.mmm:LEVEL:file.ts(line)] [component] message`
 */
export function formatChromiumRecordLine(record: OperationRecord): string {
  const d = new Date(record.at);
  const mm = Number.isNaN(d.getTime())
    ? "00"
    : String(d.getMonth() + 1).padStart(2, "0");
  const dd = Number.isNaN(d.getTime())
    ? "00"
    : String(d.getDate()).padStart(2, "0");
  const clock = formatTimeClock(record.at).replace(/:/gu, "");
  const pid = record.pid ?? 0;
  const domain = resolveRecordDomain(record);
  const sev = record.level.toUpperCase();
  const loc = resolveRecordLocation(record);
  const filePart = loc
    ? `:${loc.file.replace(/\\/gu, "/").slice(loc.file.replace(/\\/gu, "/").lastIndexOf("/") + 1)}(${loc.line})`
    : "";
  const errCode =
    record.error?.code ??
    (typeof record.fields?.code === "string" ? record.fields.code : undefined);
  const codeSuffix = errCode ? ` [code=${errCode}]` : "";
  return `[${pid}:${domain}:${mm}${dd}/${clock}:${sev}${filePart}] [${record.component}] ${record.message}${codeSuffix}`;
}

function isProjectFrame(frame: string): boolean {
  return (
    (frame.includes("packages/") || frame.includes("apps/")) &&
    !frame.includes("node_modules")
  );
}

export function StatusSectionContent(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  state: AppState;
  runtime?: RuntimeClient;
}) {
  const t = props.t;
  const [records, setRecords] = createSignal<OperationRecord[]>([]);
  const [domainFilter, setDomainFilter] = createSignal<DomainFilter>("all");
  const [levelFilter, setLevelFilter] = createSignal<LevelFilter>("all");
  const [searchQuery, setSearchQuery] = createSignal("");
  const [expandedKey, setExpandedKey] = createSignal<string | null>(null);
  const [copiedKey, setCopiedKey] = createSignal<string | null>(null);
  const [verbosityMode, setVerbosityMode] = createSignal<"error" | "debug">(
    "error",
  );

  async function refreshLogs() {
    if (!props.runtime?.operationRecords) return;
    try {
      const list = await props.runtime.operationRecords({ limit: 300 });
      if (list) {
        const cleaned = list.filter((item) => {
          if (
            item.level === "warn" &&
            ((item.component === "usage-snapshot" &&
              item.message === "attach") ||
              (item.component === "context-restore" &&
                (item.message === "session-recovery" ||
                  item.message === "ensureExecution")))
          ) {
            return false;
          }
          return !JSON.stringify(item).includes("__hero_draft__");
        });
        setRecords(cleaned.slice().reverse());
      }
    } catch {
      // ignore transient read errors
    }
  }

  onMount(() => {
    void refreshLogs();
    const timer = setInterval(() => void refreshLogs(), 3000);
    onCleanup(() => clearInterval(timer));
  });

  async function toggleVerbosity() {
    const next = verbosityMode() === "error" ? "debug" : "error";
    setVerbosityMode(next);
    await props.runtime?.setLogVerbosity?.(next).catch(() => undefined);
    await refreshLogs();
  }

  const domainScopedRecords = createMemo(() => {
    const dom = domainFilter();
    return records().filter((r) => {
      if (dom === "all") return true;
      return resolveRecordDomain(r) === dom;
    });
  });

  const countsByLevel = createMemo(() => {
    let error = 0;
    let warn = 0;
    let info = 0;
    let debug = 0;
    for (const r of domainScopedRecords()) {
      if (r.level === "error") error += 1;
      else if (r.level === "warn") warn += 1;
      else if (r.level === "info") info += 1;
      else debug += 1;
    }
    return {
      all: domainScopedRecords().length,
      error,
      warn,
      info,
      debug,
    };
  });

  const filteredRecords = createMemo(() => {
    const lvl = levelFilter();
    const q = searchQuery().trim().toLowerCase();
    return domainScopedRecords().filter((r) => {
      if (lvl !== "all") {
        if (lvl === "debug") {
          if (r.level !== "debug" && r.level !== "trace") return false;
        } else if (r.level !== lvl) {
          return false;
        }
      }
      if (!q) return true;
      const loc = resolveRecordLocation(r);
      const haystack = [
        r.component,
        r.message,
        r.pluginId ?? "",
        loc ? `${loc.file}:${loc.line} ${loc.fn ?? ""}` : "",
        r.error
          ? `${r.error.name} ${r.error.code ?? ""} ${r.error.message}`
          : "",
        r.corr ? JSON.stringify(r.corr) : "",
        r.fields ? JSON.stringify(r.fields) : "",
      ]
        .join(" ")
        .toLowerCase();
      return haystack.includes(q);
    });
  });

  function copyText(text: string, key: string) {
    void navigator.clipboard?.writeText(text);
    setCopiedKey(key);
    setTimeout(() => {
      if (copiedKey() === key) setCopiedKey(null);
    }, 1500);
  }

  function handleOpenLocation(
    event: MouseEvent,
    loc: OperationLogLocation,
  ): void {
    event.stopPropagation();
    window.dispatchEvent(
      new CustomEvent("natalia:open-file", {
        detail: { path: loc.file, line: loc.line },
      }),
    );
  }

  return (
    <>
      <div class={styles.toolbar}>
        <div class={styles.filterRow}>
          <div class={styles.pillGroup} role="group" aria-label="Log Domain">
            <button
              type="button"
              class={styles.filterPill}
              data-active={domainFilter() === "all"}
              onClick={() => setDomainFilter("all")}
            >
              {t("logs.domainAll")}
            </button>
            <button
              type="button"
              class={styles.filterPill}
              data-active={domainFilter() === "kernel"}
              onClick={() => setDomainFilter("kernel")}
            >
              {t("logs.domainKernel")}
            </button>
            <button
              type="button"
              class={styles.filterPill}
              data-active={domainFilter() === "framework"}
              onClick={() => setDomainFilter("framework")}
            >
              {t("logs.domainFramework")}
            </button>
            <button
              type="button"
              class={styles.filterPill}
              data-active={domainFilter() === "plugin"}
              onClick={() => setDomainFilter("plugin")}
            >
              {t("logs.domainPlugin")}
            </button>
          </div>

          <div class={styles.pillGroup} role="group" aria-label="Log Severity">
            <button
              type="button"
              class={styles.filterPill}
              data-active={levelFilter() === "all"}
              onClick={() => setLevelFilter("all")}
            >
              <span>ALL</span>
              <span class={styles.pillCount}>{countsByLevel().all}</span>
            </button>
            <button
              type="button"
              class={styles.filterPill}
              data-tone="error"
              data-active={levelFilter() === "error"}
              onClick={() => setLevelFilter("error")}
            >
              <span>ERROR</span>
              <span class={styles.pillCount}>{countsByLevel().error}</span>
            </button>
            <button
              type="button"
              class={styles.filterPill}
              data-tone="warn"
              data-active={levelFilter() === "warn"}
              onClick={() => setLevelFilter("warn")}
            >
              <span>WARN</span>
              <span class={styles.pillCount}>{countsByLevel().warn}</span>
            </button>
            <button
              type="button"
              class={styles.filterPill}
              data-active={levelFilter() === "info"}
              onClick={() => setLevelFilter("info")}
            >
              <span>INFO</span>
              <span class={styles.pillCount}>{countsByLevel().info}</span>
            </button>
            <button
              type="button"
              class={styles.filterPill}
              data-active={levelFilter() === "debug"}
              onClick={() => setLevelFilter("debug")}
            >
              <span>DEBUG</span>
              <span class={styles.pillCount}>{countsByLevel().debug}</span>
            </button>
          </div>
        </div>

        <div class={styles.searchRow}>
          <input
            type="text"
            class={styles.searchInput}
            placeholder={t("logs.searchPlaceholder")}
            value={searchQuery()}
            onInput={(e) => setSearchQuery(e.currentTarget.value)}
          />
          <button
            type="button"
            class={styles.actionBtn}
            onClick={() => void toggleVerbosity()}
          >
            {verbosityMode() === "error"
              ? t("logs.verbosityError")
              : t("logs.verbosityDebug")}
          </button>
          <button
            type="button"
            class={styles.actionBtn}
            onClick={() => void refreshLogs()}
          >
            {t("logs.refresh")}
          </button>
          <button
            type="button"
            class={styles.actionBtn}
            onClick={() => {
              const allText = filteredRecords()
                .map((r) => formatChromiumRecordLine(r))
                .join("\n");
              copyText(allText, "__all__");
            }}
          >
            {copiedKey() === "__all__" ? t("logs.copied") : t("logs.copyAll")}
          </button>
        </div>
      </div>

      <div class={styles.content}>
        <Show
          when={filteredRecords().length > 0}
          fallback={<div class={styles.emptyState}>{t("logs.empty")}</div>}
        >
          <div class={styles.logList}>
            <For each={filteredRecords()}>
              {(record, idx) => {
                const rowKey = () =>
                  `${record.at}:${record.component}:${idx()}`;
                const expanded = () => expandedKey() === rowKey();
                const domain = () => resolveRecordDomain(record);
                const loc = () => resolveRecordLocation(record);
                const errCode = () =>
                  record.error?.code ??
                  (typeof record.fields?.code === "string"
                    ? record.fields.code
                    : typeof record.fields?.rule === "string"
                      ? record.fields.rule
                      : undefined);
                const chromiumLine = () => formatChromiumRecordLine(record);

                return (
                  <div
                    class={styles.logCard}
                    data-level={record.level}
                    data-expanded={expanded()}
                  >
                    <button
                      type="button"
                      class={styles.logHeader}
                      onClick={() =>
                        setExpandedKey((prev) =>
                          prev === rowKey() ? null : rowKey(),
                        )
                      }
                    >
                      <span class={styles.levelBadge} data-level={record.level}>
                        {record.level}
                      </span>
                      <span class={styles.timeText}>
                        {formatTimeClock(record.at)}
                      </span>
                      <span class={styles.domainBadge} data-domain={domain()}>
                        {domain()}:{record.component.replace(/^\[|\]$/gu, "")}
                      </span>
                      <Show when={loc()}>
                        {(location) => (
                          <span
                            class={styles.locationBadge}
                            title={`${location().file}:${location().line}${location().fn ? ` (${location().fn})` : ""} — ${t("logs.openInEditor")}`}
                            onClick={(e) => handleOpenLocation(e, location())}
                          >
                            {formatShortLocation(location())}
                          </span>
                        )}
                      </Show>
                      <Show when={errCode()}>
                        {(code) => (
                          <span class={styles.errorCodeBadge}>{code()}</span>
                        )}
                      </Show>
                      <span class={styles.messagePreview}>
                        {record.error?.message ||
                          (typeof record.fields?.error === "string"
                            ? `${record.message}: ${record.fields.error}`
                            : record.message)}
                      </span>
                      <span class={styles.chevron}>
                        {expanded() ? "▾" : "▸"}
                      </span>
                    </button>

                    <Show when={expanded()}>
                      <div class={styles.forensicBody}>
                        <div class={styles.forensicSection}>
                          <div class={styles.forensicLabelRow}>
                            <span class={styles.forensicLabel}>
                              {t("logs.chromiumLine")}
                            </span>
                            <button
                              type="button"
                              class={styles.actionBtn}
                              onClick={() => copyText(chromiumLine(), rowKey())}
                            >
                              {copiedKey() === rowKey()
                                ? t("logs.copied")
                                : "Copy"}
                            </button>
                          </div>
                          <div class={styles.chromiumBox}>{chromiumLine()}</div>
                        </div>

                        <Show when={loc()}>
                          {(location) => (
                            <div class={styles.forensicSection}>
                              <span class={styles.forensicLabel}>
                                {t("logs.sourceLocation")}
                              </span>
                              <div class={styles.chromiumBox}>
                                {location().file}:{location().line}
                                {location().column
                                  ? `:${location().column}`
                                  : ""}
                                {location().fn ? `  in ${location().fn}()` : ""}
                              </div>
                            </div>
                          )}
                        </Show>

                        <Show
                          when={
                            record.corr && Object.keys(record.corr).length > 0
                          }
                        >
                          <div class={styles.forensicSection}>
                            <span class={styles.forensicLabel}>
                              {t("logs.correlation")}
                            </span>
                            <div class={styles.corrList}>
                              <For each={Object.entries(record.corr ?? {})}>
                                {([k, v]) => (
                                  <span class={styles.corrPill}>
                                    {k}: {v}
                                  </span>
                                )}
                              </For>
                            </div>
                          </div>
                        </Show>

                        <Show
                          when={
                            record.fields &&
                            Object.keys(record.fields).length > 0
                          }
                        >
                          <div class={styles.forensicSection}>
                            <span class={styles.forensicLabel}>
                              {t("logs.structuredFields")}
                            </span>
                            <div class={styles.fieldsGrid}>
                              <For each={Object.entries(record.fields ?? {})}>
                                {([k, v]) => (
                                  <>
                                    <span class={styles.fieldKey}>{k}</span>
                                    <span class={styles.fieldVal}>
                                      {typeof v === "string"
                                        ? v
                                        : JSON.stringify(v, null, 2)}
                                    </span>
                                  </>
                                )}
                              </For>
                            </div>
                          </div>
                        </Show>

                        <Show when={record.error}>
                          {(err) => (
                            <div class={styles.forensicSection}>
                              <span class={styles.forensicLabel}>
                                {t("logs.errorStack")}
                              </span>
                              <div class={styles.stackBox}>
                                <div class={styles.stackErrorTitle}>
                                  {err().name}
                                  {err().code ? ` [${err().code}]` : ""}:{" "}
                                  {err().message}
                                </div>
                                <For each={err().stack ?? []}>
                                  {(frame) => (
                                    <div
                                      class={styles.stackFrame}
                                      data-project={isProjectFrame(frame)}
                                    >
                                      {frame}
                                    </div>
                                  )}
                                </For>
                                <For each={err().causes ?? []}>
                                  {(cause) => (
                                    <div class={styles.causeBlock}>
                                      <div class={styles.stackErrorTitle}>
                                        Caused by: {cause.name}
                                        {cause.code
                                          ? ` [${cause.code}]`
                                          : ""}: {cause.message}
                                      </div>
                                      <For each={cause.stack ?? []}>
                                        {(frame) => (
                                          <div
                                            class={styles.stackFrame}
                                            data-project={isProjectFrame(frame)}
                                          >
                                            {frame}
                                          </div>
                                        )}
                                      </For>
                                    </div>
                                  )}
                                </For>
                              </div>
                            </div>
                          )}
                        </Show>
                      </div>
                    </Show>
                  </div>
                );
              }}
            </For>
          </div>
        </Show>
      </div>
    </>
  );
}

export function StatusPanel(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  open: boolean;
  onClose: () => void;
  state: AppState;
  runtime?: RuntimeClient;
}) {
  const t = props.t;
  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") props.onClose();
    };
    window.addEventListener("keydown", handleKeydown);
    onCleanup(() => window.removeEventListener("keydown", handleKeydown));
  });

  return (
    <Show when={props.open}>
      <div class="neu-settings-backdrop" onClick={props.onClose}>
        <div class={styles.window} onClick={(event) => event.stopPropagation()}>
          <div class="neu-settings-header">
            <span class="neu-settings-title">{t("settings.cat.status")}</span>
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
          <StatusSectionContent
            t={t}
            state={props.state}
            runtime={props.runtime}
          />
        </div>
      </div>
    </Show>
  );
}
