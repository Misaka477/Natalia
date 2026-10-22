import {
  createSignal,
  createEffect,
  Show,
  onCleanup,
  onMount,
  For,
  Index,
} from "solid-js";
import type {
  ConfigV4,
  RuntimeModelCatalogEntry,
  RuntimeModelSelection,
} from "@anthelia/contracts";
import { NeuSelect } from "./components/NeuSelect";
import { useConfirmDialog } from "./components/ConfirmDialog";

type ModelView = "tree" | "edit-provider";

type EditableModel = {
  id: string;
  name: string;
  reasoning: boolean;
  image: boolean;
  contextWindow?: number;
  /**
   * The model's maximum OUTPUT tokens, beside the window it is carved out of.
   *
   * Separate on purpose: a 1M-token window with a 32k reply cap reserves 32k, it
   * does not earn a 1M reply budget. The runtime's context budget reserves this
   * number, so leaving it unset means the reserve comes from a formula the
   * operator never chose.
   */
  maxOutputTokens?: number;
};

type ModelRow = EditableModel;

function mergeDiscoveredModels(
  current: ModelRow[],
  discoveredIDs: string[],
): ModelRow[] {
  const configured = new Map<string, ModelRow>();
  for (const model of current) {
    const id = model.id.trim();
    if (id && !configured.has(id)) configured.set(id, model);
  }

  const discovered = new Set<string>();
  for (const rawID of discoveredIDs) {
    const id = rawID.trim();
    if (id) discovered.add(id);
  }

  return [...discovered]
    .map((id) => {
      const existing = configured.get(id);
      return existing
        ? { ...existing, id }
        : { id, name: id, reasoning: true, image: false };
    })
    .sort((left, right) => left.id.localeCompare(right.id));
}

type HeaderRow = {
  name: string;
  value: string;
};

const providerApis = [
  { value: "openai", title: "OpenAI" },
  { value: "anthropic", title: "Anthropic" },
  { value: "gemini", title: "Gemini" },
  { value: "openai-compatible", title: "OpenAI Compatible" },
  { value: "anthropic-compatible", title: "Anthropic Compatible" },
];

export function ModelPanel(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  open: boolean;
  onClose: () => void;
  catalog?: RuntimeModelCatalogEntry[];
  selection?: RuntimeModelSelection;
  providers?: ConfigV4["providers"];
  config?: ConfigV4;
  onSetDefault?: (modelID: string) => unknown;
  onAddProvider?: (input: {
    name: string;
    type: string;
    baseURL?: string;
    apiKey: string;
    label?: string;
    previousName?: string;
    headers?: Record<string, string>;
    models?: Array<{
      id: string;
      name?: string;
      reasoning?: boolean;
      image?: boolean;
      contextWindow?: number;
    }>;
  }) => unknown;
  onDiscoverModels?: (input: {
    type: string;
    baseURL: string;
    apiKey: string;
    headers?: Record<string, string>;
  }) => Promise<{ models: string[] }>;
  onRemoveProvider?: (name: string) => Promise<{
    removed: boolean;
    reason?: string;
    defaultModel?: string;
  }>;
}) {
  const t = props.t;
  const { confirm, dialog } = useConfirmDialog();
  const [editingProvider, setEditingProvider] = createSignal<
    string | undefined
  >();
  const [originalProviderName, setOriginalProviderName] = createSignal<
    string | undefined
  >();
  const [view, setView] = createSignal<ModelView>("tree");
  const providers = () => {
    const groups = new Map<string, RuntimeModelCatalogEntry[]>();
    for (const providerName of Object.keys(props.providers ?? {})) {
      groups.set(providerName, []);
    }
    for (const entry of props.catalog ?? []) {
      const list = groups.get(entry.provider) ?? [];
      list.push(entry);
      groups.set(entry.provider, list);
    }
    return [...groups.entries()].map(([providerName, models]) => ({
      name: providerName,
      label: props.providers?.[providerName]?.name ?? providerName,
      status:
        props.providers?.[providerName]?.enabled === false
          ? t("model.disabled")
          : t("model.connected"),
      models: models.map((entry) => ({
        name: entry.id,
        // The 默认 tag is the CONFIG's default model (what a fresh boot
        // resolves to), not the session's live selection — the settings face
        // is about the persistent default, and reading the selection here made
        // the tag follow every per-session pick.
        default: props.config?.defaultModel
          ? `${props.config.defaultModel.provider}/${props.config.defaultModel.model}` ===
            entry.id
          : false,
      })),
    }));
  };
  const [expanded, setExpanded] = createSignal<Set<string>>(new Set<string>());
  const [providerName, setProviderName] = createSignal("");
  const [providerLabel, setProviderLabel] = createSignal("");
  const [providerApi, setProviderApi] = createSignal("openai-compatible");
  const providerOptions = () => [
    ...(providerApis.some((api) => api.value === providerApi())
      ? []
      : [{ value: providerApi(), label: providerApi() }]),
    ...providerApis.map((api) => ({ value: api.value, label: api.title })),
  ];
  const [baseUrl, setBaseUrl] = createSignal("");
  const [apiKey, setApiKey] = createSignal("");
  const [discoveryStatus, setDiscoveryStatus] = createSignal<string>();
  const [discoveryStatusError, setDiscoveryStatusError] = createSignal(false);
  const [discoveryInProgress, setDiscoveryInProgress] = createSignal(false);
  const [providerAction, setProviderAction] = createSignal<string>();
  const [providerActionInProgress, setProviderActionInProgress] =
    createSignal(false);
  const [providerSaveStatus, setProviderSaveStatus] = createSignal<string>();
  const [providerSaveInProgress, setProviderSaveInProgress] =
    createSignal(false);
  let discoveryGeneration = 0;
  let discoveryRequestID = 0;
  // One empty row, the same shape openAddProvider resets to. The initial
  // value used to name a model ("glm-5.3-flash") that was never the
  // user's: both form paths overwrite this before it renders, so it was
  // a dead state that read like a shipped default.
  const [models, setModels] = createSignal<ModelRow[]>([
    { id: "", name: "", reasoning: true, image: false },
  ]);
  const [headers, setHeaders] = createSignal<HeaderRow[]>([
    { name: "", value: "" },
  ]);

  function headerRecord(rows = headers()) {
    const record: Record<string, string> = {};
    for (const header of rows) {
      const name = header.name.trim();
      if (name) record[name] = header.value;
    }
    return record;
  }

  function invalidateDiscovery() {
    discoveryGeneration += 1;
    setDiscoveryStatus(undefined);
    setDiscoveryStatusError(false);
  }

  function hasAuthHeader(record: Record<string, string>) {
    return Object.values(record).some((value) => value.trim());
  }

  function discoverySnapshot() {
    return {
      generation: discoveryGeneration,
      editingProvider: editingProvider(),
      providerName: providerName(),
      providerApi: providerApi(),
      baseURL: baseUrl().trim(),
      apiKey: apiKey(),
      headers: JSON.stringify(headers()),
    };
  }

  function isCurrentDiscovery(snapshot: ReturnType<typeof discoverySnapshot>) {
    return (
      snapshot.generation === discoveryGeneration &&
      view() === "edit-provider" &&
      snapshot.editingProvider === editingProvider() &&
      snapshot.providerName === providerName() &&
      snapshot.providerApi === providerApi() &&
      snapshot.baseURL === baseUrl().trim() &&
      snapshot.apiKey === apiKey() &&
      snapshot.headers === JSON.stringify(headers())
    );
  }

  const setProviderNameFromInput = (value: string) => {
    invalidateDiscovery();
    setProviderName(value);
  };
  const setProviderLabelFromInput = (value: string) => {
    invalidateDiscovery();
    setProviderLabel(value);
  };
  const setProviderApiFromInput = (value: string) => {
    invalidateDiscovery();
    setProviderApi(value);
  };
  const setBaseUrlFromInput = (value: string) => {
    invalidateDiscovery();
    setBaseUrl(value);
  };
  const setApiKeyFromInput = (value: string) => {
    invalidateDiscovery();
    setApiKey(value);
  };

  function toggle(name: string) {
    setExpanded((prev) => {
      const next = new Set(prev);
      if (next.has(name)) next.delete(name);
      else next.add(name);
      return next;
    });
  }

  function addModelRow() {
    invalidateDiscovery();
    setModels((prev) => [
      ...prev,
      { id: "", name: "", reasoning: true, image: false },
    ]);
  }

  function updateModel(index: number, patch: Partial<ModelRow>) {
    invalidateDiscovery();
    setModels((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  function removeModel(index: number) {
    invalidateDiscovery();
    setModels((prev) => prev.filter((_, i) => i !== index));
  }

  function addHeaderRow() {
    invalidateDiscovery();
    setHeaders((prev) => [...prev, { name: "", value: "" }]);
  }

  function updateHeader(index: number, patch: Partial<HeaderRow>) {
    invalidateDiscovery();
    setHeaders((prev) =>
      prev.map((row, i) => (i === index ? { ...row, ...patch } : row)),
    );
  }

  function removeHeaderRow(index: number) {
    invalidateDiscovery();
    setHeaders((prev) => prev.filter((_, i) => i !== index));
  }

  function backToTree() {
    invalidateDiscovery();
    setView("tree");
  }

  function closePanel() {
    invalidateDiscovery();
    props.onClose();
  }

  function openEditProvider(providerName: string) {
    const provider = props.providers?.[providerName];
    if (!provider) return;
    const rawModels =
      props.config?.catalog?.providers?.[providerName]?.models ?? {};
    const rawModelRows = Object.entries(rawModels).map(([id, model]) => ({
      id,
      name: model.name || id,
      reasoning: Boolean(model.capabilities?.reasoning),
      image: Boolean(model.capabilities?.imageInput),
      contextWindow:
        typeof model.limits?.contextWindow === "number"
          ? model.limits.contextWindow
          : undefined,
      maxOutputTokens:
        typeof model.limits?.maxOutputTokens === "number"
          ? model.limits.maxOutputTokens
          : undefined,
    }));
    const providerModels = rawModelRows.length
      ? rawModelRows
      : (props.catalog ?? [])
          .filter((entry) => entry.provider === providerName)
          .map((entry) => {
            const id = entry.id.startsWith(`${providerName}/`)
              ? entry.id.slice(providerName.length + 1)
              : entry.id;
            return {
              id,
              name: entry.name || id,
              reasoning: false,
              image: false,
              contextWindow:
                typeof entry.limits?.contextWindow === "number"
                  ? entry.limits.contextWindow
                  : undefined,
              maxOutputTokens:
                typeof entry.limits?.maxOutputTokens === "number"
                  ? entry.limits.maxOutputTokens
                  : undefined,
            };
          });
    const realHeaders = Object.entries(
      provider.requestDefaults?.headers ?? {},
    ).map(([name, value]) => ({ name, value: String(value) }));
    invalidateDiscovery();
    setEditingProvider(providerName);
    setOriginalProviderName(providerName);
    setProviderName(providerName);
    setProviderLabel(provider.name ?? providerName);
    setProviderApi(provider.driver);
    setBaseUrl(provider.connection?.baseURL ?? "");
    setApiKey(provider.connection?.apiKey ?? "");
    setModels(
      providerModels.length
        ? providerModels
        : [{ id: "", name: "", reasoning: true, image: false }],
    );
    setHeaders(realHeaders.length ? realHeaders : [{ name: "", value: "" }]);
    setDiscoveryStatus(undefined);
    setDiscoveryStatusError(false);
    setProviderSaveStatus(undefined);
    setView("edit-provider");
  }

  function openAddProvider() {
    invalidateDiscovery();
    setEditingProvider(undefined);
    setOriginalProviderName(undefined);
    setProviderName("");
    setProviderLabel("");
    setProviderApi("openai-compatible");
    setBaseUrl("");
    setApiKey("");
    setModels([{ id: "", name: "", reasoning: true, image: false }]);
    setHeaders([{ name: "", value: "" }]);
    setDiscoveryStatus(undefined);
    setDiscoveryStatusError(false);
    setProviderSaveStatus(undefined);
    setView("edit-provider");
  }

  async function discoverModels() {
    const url = baseUrl().trim();
    const key = apiKey();
    const discoveryHeaders = headerRecord();
    if (
      !url ||
      (!key.trim() && !hasAuthHeader(discoveryHeaders)) ||
      discoveryInProgress()
    )
      return;
    if (!props.onDiscoverModels) {
      setDiscoveryStatusError(true);
      setDiscoveryStatus(t("model.discoveryUnavailable"));
      return;
    }
    const snapshot = discoverySnapshot();
    const requestID = ++discoveryRequestID;
    setDiscoveryInProgress(true);
    setDiscoveryStatusError(false);
    setDiscoveryStatus(t("model.discovering"));
    try {
      const result = await props.onDiscoverModels({
        type: providerApi(),
        baseURL: url,
        apiKey: key,
        headers: Object.keys(discoveryHeaders).length
          ? discoveryHeaders
          : undefined,
      });
      if (!isCurrentDiscovery(snapshot)) return;
      const discoveredIDs = result.models.filter((id) => id.trim());
      setModels((current) => mergeDiscoveredModels(current, discoveredIDs));
      setDiscoveryStatusError(false);
      setDiscoveryStatus(
        t("model.discoverySuccess", {
          count: new Set(discoveredIDs.map((id) => id.trim())).size,
        }),
      );
    } catch (error: unknown) {
      if (!isCurrentDiscovery(snapshot)) return;
      setDiscoveryStatusError(true);
      setDiscoveryStatus(
        t("model.discoveryFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      if (requestID === discoveryRequestID) {
        setDiscoveryInProgress(false);
      }
    }
  }

  async function removeProvider(provider: { name: string; label: string }) {
    if (providerActionInProgress()) return;
    if (!props.onRemoveProvider) {
      setProviderAction(t("model.removeUnavailable"));
      return;
    }
    if (
      !(await confirm({
        title: t("model.deleteTitle"),
        message: t("model.deleteBody", {
          label: provider.label,
          name: provider.name,
        }),
        confirmLabel: t("settingsDlg.confirm"),
        cancelLabel: t("model.cancel"),
        danger: true,
      }))
    )
      return;
    setProviderActionInProgress(true);
    setProviderAction(undefined);
    try {
      const result = await props.onRemoveProvider(provider.name);
      if (!result.removed) {
        setProviderAction(
          t("model.deleteFailedReason", {
            reason: result.reason || t("settingsDlg.auto"),
          }),
        );
      } else {
        setProviderAction(
          result.defaultModel
            ? t("model.deletedSwitched", { model: result.defaultModel })
            : t("model.deleted"),
        );
      }
    } catch (error: unknown) {
      setProviderAction(
        t("model.deleteFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setProviderActionInProgress(false);
    }
  }

  async function submitProvider() {
    if (providerSaveInProgress() || discoveryInProgress()) return;
    if (!props.onAddProvider) {
      setProviderSaveStatus(t("model.submitUnavailable"));
      return;
    }
    const headerRecordValue = headerRecord();
    const modelRows = models()
      .filter((model) => model.id.trim())
      .map((model) => ({
        id: model.id.trim(),
        name: model.name.trim() || model.id.trim(),
        reasoning: model.reasoning,
        image: model.image,
        contextWindow:
          typeof model.contextWindow === "number" &&
          Number.isFinite(model.contextWindow) &&
          model.contextWindow > 0
            ? model.contextWindow
            : undefined,
        maxOutputTokens:
          typeof model.maxOutputTokens === "number" &&
          Number.isFinite(model.maxOutputTokens) &&
          model.maxOutputTokens > 0
            ? model.maxOutputTokens
            : undefined,
      }));
    const targetID = providerName().trim() || editingProvider() || "";
    const providerInput = {
      name: targetID,
      type: providerApi(),
      label: providerLabel().trim() || undefined,
      previousName:
        originalProviderName() && originalProviderName() !== targetID
          ? originalProviderName()
          : undefined,
      baseURL: baseUrl().trim() || undefined,
      apiKey: apiKey(),
      headers: Object.keys(headerRecordValue).length
        ? headerRecordValue
        : undefined,
      models: modelRows,
    };
    setProviderSaveInProgress(true);
    setProviderSaveStatus(undefined);
    try {
      await props.onAddProvider(providerInput);
      setEditingProvider(undefined);
      backToTree();
    } catch (error: unknown) {
      setProviderSaveStatus(
        t("model.submitFailed", {
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    } finally {
      setProviderSaveInProgress(false);
    }
  }

  createEffect(() => {
    if (props.open) {
      invalidateDiscovery();
      setView("tree");
      setEditingProvider(undefined);
      setOriginalProviderName(undefined);
      setExpanded(new Set<string>());
      setProviderAction(undefined);
    } else {
      invalidateDiscovery();
    }
  });

  onMount(() => {
    const handleKeydown = (event: KeyboardEvent) => {
      if (event.key === "Escape") closePanel();
    };
    window.addEventListener("keydown", handleKeydown);
    onCleanup(() => window.removeEventListener("keydown", handleKeydown));
  });

  return (
    <Show when={props.open}>
      <div class="neu-settings-backdrop" onClick={closePanel}>
        <div
          class="neu-model-window"
          onClick={(event) => event.stopPropagation()}
        >
          <style>{`
            .neu-form-section-title-actions { display: flex; align-items: center; justify-content: space-between; gap: 10px; }
            .neu-form-section-title-actions > span { min-width: 0; }
            .neu-form-status { padding: 7px 10px; border-radius: 8px; color: var(--neu-muted); background: var(--neu-bg-light); font-size: 12px; line-height: 1.4; }
            .neu-form-status-error { color: var(--neu-error); background: var(--neu-error-soft); }
            .neu-model-edit:disabled, .neu-model-add:disabled, .neu-form-btn:disabled { opacity: 0.45; cursor: not-allowed; box-shadow: none; }
            @media (max-width: 560px) { .neu-form-section-title-actions { align-items: stretch; flex-direction: column; } .neu-form-section-title-actions .neu-model-add { margin-left: 0; } }
          `}</style>
          <div class="neu-settings-header">
            <span class="neu-settings-title">
              {view() === "edit-provider"
                ? t("model.editProvider")
                : t("model.panelTitle")}
            </span>
            <button
              type="button"
              class="neu-settings-close"
              onClick={closePanel}
              aria-label={t("model.closeAria")}
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

          <Show when={view() === "tree"}>
            <div class="neu-model-tree">
              <Show when={providerAction()}>
                <div
                  class="neu-form-status neu-form-status-error"
                  role="alert"
                  aria-live="assertive"
                >
                  {providerAction()}
                </div>
              </Show>
              <For each={providers()}>
                {(provider) => (
                  <div class="neu-model-provider">
                    <div
                      class="neu-model-provider-header"
                      role="button"
                      tabIndex="0"
                      onClick={() => toggle(provider.name)}
                      onKeyDown={(event) => {
                        if (event.target !== event.currentTarget) return;
                        if (event.key === "Enter" || event.key === " ") {
                          event.preventDefault();
                          toggle(provider.name);
                        }
                      }}
                    >
                      <svg
                        class="neu-model-chevron"
                        data-expanded={expanded().has(provider.name)}
                        viewBox="0 0 16 16"
                        fill="none"
                      >
                        <path
                          d="M6 4l4 4-4 4"
                          stroke="currentColor"
                          stroke-width="1.4"
                          stroke-linecap="round"
                          stroke-linejoin="round"
                        />
                      </svg>
                      <span class="neu-model-provider-name">
                        {provider.label}
                      </span>
                      <span
                        class="neu-model-status"
                        data-connected={
                          provider.status === t("model.connected")
                        }
                      >
                        {provider.status}
                      </span>
                      <button
                        type="button"
                        class="neu-model-edit"
                        onClick={(event) => {
                          event.stopPropagation();
                          openEditProvider(provider.name);
                        }}
                      >
                        {t("model.edit")}
                      </button>
                      <button
                        type="button"
                        class="neu-model-edit"
                        disabled={providerActionInProgress()}
                        onClick={(event) => {
                          event.stopPropagation();
                          void removeProvider(provider);
                        }}
                      >
                        {t("model.delete")}
                      </button>
                    </div>
                    <Show when={expanded().has(provider.name)}>
                      <div class="neu-model-children">
                        <For each={provider.models}>
                          {(model) => (
                            <div class="neu-model-row">
                              <span class="neu-model-name">{model.name}</span>
                              <Show when={model.default}>
                                <span class="neu-model-default">
                                  {t("model.default")}
                                </span>
                              </Show>
                              <button
                                type="button"
                                class="neu-model-set-default"
                                disabled={model.default}
                                onClick={() => props.onSetDefault?.(model.name)}
                              >
                                {t("model.setDefault")}
                              </button>
                            </div>
                          )}
                        </For>
                      </div>
                    </Show>
                  </div>
                )}
              </For>
              <div class="neu-model-actions">
                <button
                  type="button"
                  class="neu-model-add"
                  onClick={openAddProvider}
                >
                  {t("model.addProvider")}
                </button>
              </div>
            </div>
          </Show>

          <Show when={view() === "edit-provider"}>
            <div class="neu-form">
              <Show when={providerSaveStatus()}>
                <div
                  class="neu-form-status neu-form-status-error"
                  role="alert"
                  aria-live="assertive"
                >
                  {providerSaveStatus()}
                </div>
              </Show>
              <div class="neu-form-field">
                <label class="neu-form-label" for="provider-name">
                  {t("model.providerID")}
                </label>
                <input
                  id="provider-name"
                  class="neu-form-input"
                  value={providerName()}
                  placeholder={t("model.providerIDPh")}
                  onInput={(event) =>
                    setProviderNameFromInput(event.currentTarget.value)
                  }
                />
              </div>
              <div class="neu-form-field">
                <label class="neu-form-label" for="provider-label">
                  {t("model.providerName")}
                </label>
                <input
                  id="provider-label"
                  class="neu-form-input"
                  value={providerLabel()}
                  placeholder={t("model.providerNamePh")}
                  onInput={(event) =>
                    setProviderLabelFromInput(event.currentTarget.value)
                  }
                />
              </div>
              <div class="neu-form-field">
                <label class="neu-form-label" for="provider-api">
                  Provider API
                </label>
                <NeuSelect
                  value={providerApi()}
                  options={providerOptions()}
                  onChange={setProviderApiFromInput}
                />
              </div>
              <div class="neu-form-field">
                <label class="neu-form-label" for="provider-url">
                  {t("model.baseURL")}
                </label>
                <input
                  id="provider-url"
                  class="neu-form-input"
                  value={baseUrl()}
                  placeholder="https://api.example.com/v1"
                  onInput={(event) =>
                    setBaseUrlFromInput(event.currentTarget.value)
                  }
                />
              </div>
              <div class="neu-form-field">
                <label class="neu-form-label" for="provider-key">
                  {t("model.apiKey")}
                </label>
                <input
                  id="provider-key"
                  class="neu-form-input"
                  type="password"
                  value={apiKey()}
                  placeholder={t("model.apiKeyPh")}
                  onInput={(event) =>
                    setApiKeyFromInput(event.currentTarget.value)
                  }
                />
              </div>

              <div class="neu-form-section-title neu-form-section-title-actions">
                <span>{t("model.modelsSection")}</span>
                <button
                  type="button"
                  class="neu-model-add neu-model-add-secondary"
                  disabled={
                    !baseUrl().trim() ||
                    (!apiKey().trim() && !hasAuthHeader(headerRecord())) ||
                    discoveryInProgress()
                  }
                  onClick={() => void discoverModels()}
                >
                  {t("model.discover")}
                </button>
              </div>
              <Show when={discoveryStatus()}>
                <div
                  class="neu-form-status"
                  classList={{
                    "neu-form-status-error": discoveryStatusError(),
                  }}
                  aria-live="polite"
                  role={discoveryStatusError() ? "alert" : undefined}
                >
                  {discoveryStatus()}
                </div>
              </Show>
              {/* <Index> keeps the input DOM per row index, so editing a model
                  id or context window cannot re-create the row and drop focus. */}
              <Index each={models()}>
                {(model, index) => (
                  <div class="neu-model-edit-row">
                    <input
                      class="neu-form-input"
                      value={model().id}
                      placeholder="ID"
                      onInput={(event) =>
                        updateModel(index, { id: event.currentTarget.value })
                      }
                    />
                    <input
                      class="neu-form-input"
                      type="number"
                      min="1"
                      placeholder={t("model.contextWindowPh")}
                      title={t("model.contextWindowTitle")}
                      value={model().contextWindow ?? ""}
                      onInput={(event) => {
                        const value = Number(event.currentTarget.value);
                        updateModel(index, {
                          contextWindow:
                            Number.isFinite(value) && value > 0
                              ? value
                              : undefined,
                        });
                      }}
                    />
                    {/* The reply cap sits beside the window it comes out of: the
                        runtime reserves this many tokens, so a model with a 1M
                        window and a 32k cap reserves 32k. */}
                    <input
                      class="neu-form-input"
                      type="number"
                      min="1"
                      placeholder={t("model.maxOutputPh")}
                      title={t("model.maxOutputTitle")}
                      value={model().maxOutputTokens ?? ""}
                      onInput={(event) => {
                        const value = Number(event.currentTarget.value);
                        updateModel(index, {
                          maxOutputTokens:
                            Number.isFinite(value) && value > 0
                              ? value
                              : undefined,
                        });
                      }}
                    />
                    <label class="neu-form-checkbox">
                      <input
                        type="checkbox"
                        checked={model().reasoning}
                        onChange={() =>
                          updateModel(index, {
                            reasoning: !model().reasoning,
                          })
                        }
                      />
                      <span>{t("model.reasoning")}</span>
                    </label>
                    <label class="neu-form-checkbox">
                      <input
                        type="checkbox"
                        checked={model().image}
                        onChange={() =>
                          updateModel(index, { image: !model().image })
                        }
                      />
                      <span>{t("model.image")}</span>
                    </label>
                    <button
                      type="button"
                      class="neu-model-remove"
                      onClick={() => removeModel(index)}
                    >
                      {t("model.delete")}
                    </button>
                  </div>
                )}
              </Index>
              <button
                type="button"
                class="neu-model-add neu-model-add-secondary neu-model-add-full"
                onClick={addModelRow}
              >
                {t("model.addModel")}
              </button>

              <div class="neu-form-section-title">{t("model.headers")}</div>
              <Index each={headers()}>
                {(header, index) => (
                  <div class="neu-model-edit-row">
                    <input
                      class="neu-form-input"
                      value={header().name}
                      placeholder="Header Name"
                      onInput={(event) =>
                        updateHeader(index, {
                          name: event.currentTarget.value,
                        })
                      }
                    />
                    <input
                      class="neu-form-input"
                      value={header().value}
                      placeholder="Value"
                      onInput={(event) =>
                        updateHeader(index, {
                          value: event.currentTarget.value,
                        })
                      }
                    />
                    <button
                      type="button"
                      class="neu-model-remove"
                      onClick={() => removeHeaderRow(index)}
                    >
                      {t("model.delete")}
                    </button>
                  </div>
                )}
              </Index>
              <button
                type="button"
                class="neu-model-add neu-model-add-secondary neu-model-add-full"
                onClick={addHeaderRow}
              >
                {t("model.addHeader")}
              </button>

              <div class="neu-form-actions">
                <button
                  type="button"
                  class="neu-form-btn neu-form-cancel"
                  onClick={backToTree}
                >
                  {t("model.cancel")}
                </button>
                <button
                  type="button"
                  class="neu-form-btn neu-form-primary"
                  disabled={providerSaveInProgress() || discoveryInProgress()}
                  onClick={() => void submitProvider()}
                >
                  {providerSaveInProgress()
                    ? t("model.submitting")
                    : t("model.submit")}
                </button>
              </div>
            </div>
          </Show>
        </div>
      </div>
      {dialog}
    </Show>
  );
}
