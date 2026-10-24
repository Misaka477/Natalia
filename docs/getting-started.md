# Natalia Getting Started

[中文](#中文) | [English](#english)

<a id="english"></a>

## English

Natalia is a coding agent runtime. This guide covers installing the workspace, configuring a provider, and using the shipped front ends:

- **CLI** (`apps/cli`)
- **Web shell** (`apps/web`, package `@natalia/web-shell`), whose interface ships as the UI plugin `packages/plugins/ui/next`
- **Window host** (`apps/cef-desktop`) — a CEF window around the same web shell, not a separate interface

There is no legacy TUI application in the current tree.

## 1. Prerequisites

- Bun 1.3+
- A provider credential for live model turns
- Git for Windows when using shell/workspace automation on Windows
- The managed WezTerm fork when using interactive terminal tools

## 2. Install

```bash
bun install
```

The workspace uses Bun workspaces. On Windows, if `node_modules` uses the isolated layout and `@natalia/*` links are not visible, run:

```bash
bun install --linker=hoisted
```

## 3. Configure a provider

Environment variables take effect immediately:

```bash
export NATALIA_PROVIDER="openai-compatible"
export NATALIA_API_KEY="sk-..."
export NATALIA_MODEL="your-model-id"
```

Or write `.natalia/config.json` in the workspace:

```json
{
  "version": 3,
  "providers": {
    "my-provider": {
      "type": "openai-compatible",
      "baseURL": "https://api.example.com/v1",
      "apiKey": "sk-...",
      "enabled": true
    }
  },
  "defaultModel": "your-model-id"
}
```

Never commit API keys.

## 4. CLI

Run a single turn:

```bash
npm run ts:cli -- run "List the repository files"
npm run ts:cli -- run --json "List the repository files"
```

Stream JSON Lines statements through stdin:

```bash
printf '%s\n' '{"prompt":"List the repository files"}' | npm run ts:cli -- eval
```

Inspect runtime state:

```bash
npm run ts:cli -- status
npm run ts:cli -- doctor
npm run ts:cli -- diagnose
```

Manage sessions and workspaces:

```bash
npm run ts:cli -- session list
npm run ts:cli -- session show <id>
npm run ts:cli -- fs list --path src --limit 100
```

See `docs/commands.md` for the full CLI command reference.

## 5. Web shell

Start the web shell development environment:

```bash
npm run ts:ui
```

This starts a local runtime and the Vite dev server for `@natalia/web-shell`. The web UI includes a workspace tree, a session tree, approval/question panels, plugin management, terminal panes, and checkpoint UI.

Production build:

```bash
npm run build:web
```

**This step is not optional.** No other script builds it — `ts:build`,
`build:everything` and `release:build` all skip `apps/web/dist`, and it is
exactly what the runtime's web server and the CEF desktop serve. A checkout
without it renders a blank page.

The full set a source checkout needs before anything can run:

```bash
npm run build:distribution   # dist/ts: the CLI bundle, the plugins, the plugin UI bundles
npm run build:web            # apps/web/dist: the web shell
```

## 6. Multi-workspace

Natalia supports multiple workspaces in one host process. Each workspace has its own runtime client and session store; they share the same global config path and plugin store.

- Add a workspace through the web shell workspace panel.
- Activate a workspace to make it the active runtime.
- Use `NATALIA_WORKSPACES_FILE` to point at a workspace registry JSON when embedding the runtime.

The web shell renders a workspace tree and the workspace -> session tree from the same projected state.

## 7. Multi-session

A workspace can run multiple sessions concurrently. The web shell shows sessions in a tree and allows attaching, resuming, and switching between them.

CLI session commands operate on session records:

```bash
npm run ts:cli -- session list
npm run ts:cli -- session show <id>
npm run ts:cli -- session rename <id> "New title"
npm run ts:cli -- session pin <id>
npm run ts:cli -- session delete <id>
```

## 8. Where data lives

| Data                                    | Location                |
| --------------------------------------- | ----------------------- |
| Workspace config, sessions, checkpoints | `<workspace>/.natalia/` |
| Everything global                       | `~/.natalia/`           |

The global home is ONE directory: `$HOME/.natalia` on Linux and macOS,
`%USERPROFILE%\.natalia\` on Windows. It holds the global `config.json`, the
workspace registry (`workspaces.json`), TUI state, skills, the plugin store,
caches, operation logs and the object store — which is why an uninstall that
keeps it and a reinstall afterwards come back to the same state.

Relocate the whole home with `NATALIA_HOME`; override single files with
`NATALIA_CONFIG` and `NATALIA_WORKSPACES_FILE`. The locations older releases
used (`~/.config/natalia/`, `%APPDATA%\natalia\`, a `.natalia/` beside the
install) are still READ as a fallback, so an existing install keeps its
settings — nothing writes them any more.

## 9. Troubleshooting

- `provider: not configured` — set `NATALIA_PROVIDER` / `NATALIA_API_KEY` / `NATALIA_MODEL` or fill `.natalia/config.json`.
- `No real provider configured` — restart the runtime after changing provider config.
- Browser tools missing extension — see `packages/plugins/browser/README.md`.

<a id="chinese"></a>

## 中文

Natalia 是一个 coding agent runtime。本指南覆盖安装工作区、配置 provider，以及使用已提供的前端：

- **CLI**（`apps/cli`）
- **Web shell**（`apps/web`，包名 `@natalia/web-shell`），其界面由 UI 插件 `packages/plugins/ui/next` 提供
- **窗口宿主**（`apps/cef-desktop`）—— 给同一个 web shell 套的 CEF 窗口，不是另一个界面

当前代码树中没有旧的 TUI 应用。

## 1. 环境要求

- Bun 1.3+
- 真实模型对话需要 provider 凭据
- Windows 上使用 shell/workspace 自动化时需要 Git for Windows
- 使用交互式终端工具时需要 managed WezTerm fork

## 2. 安装

```bash
bun install
```

项目使用 Bun workspaces。Windows 上如果 `node_modules` 使用 isolated layout 导致看不到 `@natalia/*` 链接，运行：

```bash
bun install --linker=hoisted
```

## 3. 配置 provider

环境变量立即生效：

```bash
export NATALIA_PROVIDER="openai-compatible"
export NATALIA_API_KEY="sk-..."
export NATALIA_MODEL="your-model-id"
```

或者在 workspace 中写 `.natalia/config.json`：

```json
{
  "version": 3,
  "providers": {
    "my-provider": {
      "type": "openai-compatible",
      "baseURL": "https://api.example.com/v1",
      "apiKey": "sk-...",
      "enabled": true
    }
  },
  "defaultModel": "your-model-id"
}
```

不要把 API key 提交到仓库。

## 4. CLI

执行单轮任务：

```bash
npm run ts:cli -- run "List the repository files"
npm run ts:cli -- run --json "List the repository files"
```

通过 stdin 流式传入 JSON Lines：

```bash
printf '%s\n' '{"prompt":"List the repository files"}' | npm run ts:cli -- eval
```

查看运行时状态：

```bash
npm run ts:cli -- status
npm run ts:cli -- doctor
npm run ts:cli -- diagnose
```

管理 session 与 workspace：

```bash
npm run ts:cli -- session list
npm run ts:cli -- session show <id>
npm run ts:cli -- fs list --path src --limit 100
```

完整 CLI 命令见 `docs/commands.md`。

## 5. Web shell

启动 Web shell 开发环境：

```bash
npm run ts:ui
```

这会启动本地 runtime 和 `@natalia/web-shell` 的 Vite dev server。Web UI 包含 workspace 树、session 树、审批/提问面板、插件管理、终端面板和 checkpoint UI。

生产构建：

```bash
npm --workspace @natalia/web-shell run build
```

## 6. 多 Workspace

Natalia 支持在一个 host 进程里同时管理多个 workspace。每个 workspace 有独立的 runtime client 和 session store；它们共享同一个 global config 路径和 plugin store。

- 通过 Web shell 的 workspace 面板添加 workspace。
- 激活 workspace 后它成为 active runtime。
- 嵌入 runtime 时可用 `NATALIA_WORKSPACES_FILE` 指定 workspace registry JSON。

Web shell 从同一份 projection 渲染 workspace 树和 workspace -> session 树。

## 7. 多 Session

同一个 workspace 可以并发运行多个 session。Web shell 用 session 树展示它们，并支持附加、恢复和切换。

CLI session 命令操作 session 记录：

```bash
npm run ts:cli -- session list
npm run ts:cli -- session show <id>
npm run ts:cli -- session rename <id> "New title"
npm run ts:cli -- session pin <id>
npm run ts:cli -- session delete <id>
```

## 8. 数据存放位置

| 数据                                | 位置                    |
| ----------------------------------- | ----------------------- |
| workspace 配置、session、checkpoint | `<workspace>/.natalia/` |
| 所有全局数据                        | `~/.natalia/`           |

全局主目录只有**一个**：Linux 与 macOS 为 `$HOME/.natalia`，Windows 为
`%USERPROFILE%\.natalia\`。全局 `config.json`、workspace 注册表
（`workspaces.json`）、TUI 状态、技能、插件店、缓存、操作日志与对象存储都在
里面——这也是为什么卸载时选择保留、之后重新安装就能回到原来的状态。

用 `NATALIA_HOME` 可以整体迁移主目录；用 `NATALIA_CONFIG` /
`NATALIA_WORKSPACES_FILE` 覆盖单个文件。旧版本用过的位置
（`~/.config/natalia/`、`%APPDATA%\natalia\`、安装目录旁的 `.natalia/`）
**仍会被读取**作为回退，已有安装的设置不会丢——但不会再写入这些位置。

## 9. 故障排查

- `provider: not configured`：设置 `NATALIA_PROVIDER` / `NATALIA_API_KEY` / `NATALIA_MODEL`，或填写 `.natalia/config.json`。
- `No real provider configured`：修改 provider 配置后重启 runtime。
- 浏览器工具缺少扩展：见 `packages/plugins/browser/README.md`。
