import { createSignal, For, Show, onCleanup, onMount } from "solid-js";
import type { MCPServerConfig, RuntimeClient } from "@anthelia/contracts";
import type { UiProjection } from "@natalia/ui-host";
import { bindMcpLocale } from "./locales";

type MCPType = "stdio" | "http";

export function McpSettings(props: {
  runtime: RuntimeClient;
  projection: UiProjection;
  extra?: unknown;
}) {
  const t = bindMcpLocale(props.extra);
  const [servers, setServers] = createSignal<Record<string, unknown>>({});
  const [adding, setAdding] = createSignal(false);
  const [type, setType] = createSignal<MCPType>("stdio");
  const [name, setName] = createSignal("");
  const [command, setCommand] = createSignal("");
  const [args, setArgs] = createSignal("");
  const [url, setUrl] = createSignal("");

  function refresh() {
    setServers(props.projection.getState().mcp ?? {});
  }

  onMount(() => {
    refresh();
    const off = props.projection.subscribe(() => refresh());
    onCleanup(off);
  });

  function resetForm() {
    setAdding(false);
    setName("");
    setCommand("");
    setArgs("");
    setUrl("");
  }

  async function addMcp() {
    const inputName = name().trim();
    if (type() === "stdio" && !command().trim()) return;
    if (type() === "http" && !url().trim()) return;
    if (!inputName) return;
    await props.runtime.mcpServerAdd?.({
      name: inputName,
      config: {
        type: type(),
        ...(type() === "stdio"
          ? {
              command: command().trim().split(/\s+/)[0],
              args: args().trim().split(/\s+/).filter(Boolean),
            }
          : { url: url().trim() }),
        enabled: true,
        headers: {},
        environment: {},
        timeoutSec: 30,
        allowedTools: [],
        excludedTools: [],
        readOnly: false,
      } as MCPServerConfig,
    });
    resetForm();
  }

  async function removeMcp(serverName: string) {
    await props.runtime.mcpServerRemove?.(serverName);
    setServers((prev) => {
      const next = { ...prev };
      delete next[serverName];
      return next;
    });
  }

  const rows = () =>
    Object.entries(servers()).map(([id, server]) => {
      const view = server as {
        status?: string;
        tools?: number;
        message?: string;
      };
      return {
        id,
        name: id,
        description: view.message ?? `${view.tools ?? 0} tools`,
        enabled: view.status === "connected",
      };
    });

  return (
    <div>
      <div class="neu-settings-content-title">{t("mcp.title")}</div>
      <Show
        when={rows().length}
        fallback={
          <div class="neu-settings-item">
            <div class="neu-settings-item-main">
              <span class="neu-settings-item-label">{t("mcp.empty")}</span>
              <span class="neu-settings-item-description">
                {t("mcp.emptyHint")}
              </span>
            </div>
          </div>
        }
      >
        <For each={rows()}>
          {(row) => (
            <div class="neu-extension-row">
              <span class="neu-extension-name">{row.name}</span>
              <span class="neu-extension-description">{row.description}</span>
              <span class="neu-extension-toggle" data-enabled={row.enabled}>
                {row.enabled ? t("mcp.connected") : t("mcp.disconnected")}
              </span>
              <button
                type="button"
                class="neu-extension-btn neu-extension-remove"
                onClick={() => void removeMcp(row.name)}
              >
                {t("mcp.delete")}
              </button>
            </div>
          )}
        </For>
      </Show>

      <Show when={adding()}>
        <div class="neu-extension-form">
          <select
            class="neu-form-input"
            value={type()}
            onChange={(event) => setType(event.currentTarget.value as MCPType)}
          >
            <option value="stdio">stdio</option>
            <option value="http">http</option>
          </select>
          <input
            class="neu-form-input"
            value={name()}
            placeholder={t("mcp.namePlaceholder")}
            onInput={(event) => setName(event.currentTarget.value)}
          />
          <Show
            when={type() === "stdio"}
            fallback={
              <input
                class="neu-form-input"
                value={url()}
                placeholder={t("mcp.urlPlaceholder")}
                onInput={(event) => setUrl(event.currentTarget.value)}
              />
            }
          >
            <input
              class="neu-form-input"
              value={command()}
              placeholder={t("mcp.commandPlaceholder")}
              onInput={(event) => setCommand(event.currentTarget.value)}
            />
            <input
              class="neu-form-input"
              value={args()}
              placeholder={t("mcp.argsPlaceholder")}
              onInput={(event) => setArgs(event.currentTarget.value)}
            />
          </Show>
          <div class="neu-extension-form-actions">
            <button type="button" class="neu-extension-btn" onClick={resetForm}>
              {t("mcp.cancel")}
            </button>
            <button
              type="button"
              class="neu-extension-btn neu-extension-primary-btn"
              onClick={() => void addMcp()}
            >
              {t("mcp.add")}
            </button>
          </div>
        </div>
      </Show>

      <div class="neu-extension-actions">
        <button
          type="button"
          class="neu-extension-add"
          onClick={() => setAdding(!adding())}
        >
          {t("mcp.addServer")}
        </button>
      </div>
    </div>
  );
}
