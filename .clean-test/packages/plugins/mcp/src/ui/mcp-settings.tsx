import { createSignal, For, Show, onCleanup, onMount } from "solid-js";
import type { MCPServerConfig, RuntimeClient } from "@anthelia/contracts";
import type { UiProjection } from "@natalia/ui-host";

type MCPType = "stdio" | "http";

export function McpSettings(props: {
  runtime: RuntimeClient;
  projection: UiProjection;
}) {
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
      <div class="neu-settings-content-title">MCP 配置</div>
      <Show
        when={rows().length}
        fallback={
          <div class="neu-settings-item">
            <div class="neu-settings-item-main">
              <span class="neu-settings-item-label">暂无 MCP 服务器</span>
              <span class="neu-settings-item-description">
                点击下方添加 MCP
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
                {row.enabled ? "已连接" : "未连接"}
              </span>
              <button
                type="button"
                class="neu-extension-btn neu-extension-remove"
                onClick={() => void removeMcp(row.name)}
              >
                删除
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
            placeholder="名称（例如 my-mcp）"
            onInput={(event) => setName(event.currentTarget.value)}
          />
          <Show
            when={type() === "stdio"}
            fallback={
              <input
                class="neu-form-input"
                value={url()}
                placeholder="MCP URL（例如 https://example.com/mcp）"
                onInput={(event) => setUrl(event.currentTarget.value)}
              />
            }
          >
            <input
              class="neu-form-input"
              value={command()}
              placeholder="command（例如 npx）"
              onInput={(event) => setCommand(event.currentTarget.value)}
            />
            <input
              class="neu-form-input"
              value={args()}
              placeholder="args（空格分隔）"
              onInput={(event) => setArgs(event.currentTarget.value)}
            />
          </Show>
          <div class="neu-extension-form-actions">
            <button type="button" class="neu-extension-btn" onClick={resetForm}>
              取消
            </button>
            <button
              type="button"
              class="neu-extension-btn neu-extension-primary-btn"
              onClick={() => void addMcp()}
            >
              添加
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
          添加 MCP
        </button>
      </div>
    </div>
  );
}
