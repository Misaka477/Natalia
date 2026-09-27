# Natalia CLI

[中文](#中文) | [English](#english)

<a id="english"></a>

## English

Natalia is a local-first coding-agent runtime built with TypeScript and Bun. It ships two front ends:

- **CLI** (`apps/cli`)
- **Web shell** (`apps/web`, package `@natalia/web-shell`)

Both use the same `RuntimeClient`, event model, and plugin registry.

### Highlights

- Durable local sessions backed by JSON or SQLite, with history, context compaction, recovery, and session forks.
- Multi-workspace support in one host process; each workspace owns its own runtime and session store.
- Multiple concurrent sessions per workspace, presented as a workspace -> session tree in the web shell.
- Streaming provider adapters for OpenAI-compatible APIs, Anthropic, and Gemini.
- Typed tool execution through schema validation, policy, conditional approval, audit, and secret-redaction boundaries.
- Checkpoint creation, preview, dry-run rollback, and confirmed rollback with safety checkpoints.
- Managed processes and PTYs, sandboxes, MCP servers, skills, workflows, and trusted in-process plugins.
- One plugin registry and lifecycle for tools, commands, events, services, resources, projections, workflows, settings, adapters, and scheduler jobs.
- Authenticated local HTTP/RPC, SSE, WebSocket, Unix-socket, and TLS transports, plus a typed SDK and daemon controls.

Natalia is local-first. It does not provide cloud accounts, organization management, billing, browser login, OAuth login, or hosted synchronization.

### Architecture

Natalia has three layers: **kernel + framework + plugin**.

- The kernel provides generic registry, lifecycle, ownership, event, and storage mechanisms.
- The framework composes product internals: sessions, providers, policy, checkpoints, workspaces, and runtime composition.
- Product features use one trusted in-process plugin system; official plugins and user-installed packages have the same permissions and lifecycle.
- The CLI is the authoritative maintenance entry point.
- The CLI and the web shell are entry points over the same `RuntimeClient`, event stream, workspace manager, and command catalog.

### Requirements

- Bun and Node-compatible npm tooling.
- A configured provider credential for live model turns.
- The Natalia Browser Bridge extension for browser tools (see `packages/plugins/browser/README.md`).
- On Windows, Git for Windows and the Windows build of the managed WezTerm fork for interactive terminals.

### Quick Start

#### CLI

```bash
export NATALIA_API_KEY="..."
export NATALIA_MODEL="your-model-id"
npm run ts:cli -- run "List the repository files"
npm run ts:cli -- run --json "List the repository files"
```

Configure a provider through environment variables or `.natalia/config.json`.

Never commit API keys.

#### Web shell

```bash
npm run ts:ui
```

This starts a local runtime and the Vite dev server for `@natalia/web-shell`.

### Documentation

Every doc below is bilingual in a single file (English + Chinese).

- [Getting started](docs/getting-started.md) — install, provider setup, CLI/web shell, workspaces and sessions.
- [API reference](docs/api-reference.md) — the stable HTTP/RPC protocol: auth, failure kinds, events, the write surface.
- [Types reference](docs/types-reference.md) — complete field shapes of every result type, nested objects expanded.
- [Config reference](docs/config-reference.md) — the full `.natalia/config.json` shape (types, optionality, defaults).
- [Plugin guide](docs/plugin-guide.md) — from-zero plugin authoring, installation, diagnostics, publishing, and plugin API.
- [UI guide](docs/ui-guide.md) — building and mounting UI adapter plugins.
- [Provider guide](docs/provider-guide.md) — writing a provider adapter.
- [CLI commands](docs/commands.md) — runtime, session, filesystem, plugin, UI, daemon, diagnostics, and recording commands.

### CLI And Local Transport

```bash
npm run ts:cli -- run "Reply exactly: pong"
npm run ts:cli -- run --json "Reply exactly: pong"
printf '%s\n' '{"prompt":"Reply exactly: pong"}' | npm run ts:cli -- eval

NATALIA_TRANSPORT_TOKEN="local-token" npm run ts:cli -- serve 8787
npm run ts:cli -- daemon 8787
npm run ts:cli -- daemon-status
npm run ts:cli -- daemon-stop

npm run ts:cli -- plugin create ./my-plugin --id yourco.plugin --package @yourco/natalia-plugin
npm run ts:cli -- plugin create ./my-ui --id yourco.web --template ui
npm run ts:cli -- plugin create ./my-ts --id yourco.ts --language ts
npm run ts:cli -- plugin install ./my-plugin
npm run ts:cli -- ui ui.yourco.web
npm run ts:cli -- plugin list
npm run ts:cli -- plugin disable yourco.plugin
npm run ts:cli -- plugin enable yourco.plugin
npm run ts:cli -- plugin doctor
npm run ts:cli -- plugin reconcile
npm run ts:cli -- plugin uninstall yourco.plugin
```

The local transport supports authenticated HTTP/RPC/SSE, WebSocket, Unix sockets, and TLS. Keep transport tokens and certificates outside the repository.

### Sessions And Workspaces

Sessions persist under `<workspace>/.natalia/sessions/`. Context checkpoints, settled tool results, approvals/questions, and workspace state allow a user to reopen a session and continue.

The host supports multiple workspaces in one process. Each workspace has its own runtime client and session store; the web shell renders a workspace -> session tree from projected runtime state.

CLI session commands:

```bash
npm run ts:cli -- session list
npm run ts:cli -- session show <id>
npm run ts:cli -- session rename <id> "New title"
npm run ts:cli -- session pin <id>
npm run ts:cli -- session delete <id>
```

### Configuration

Configuration lives in `.natalia/config.json` per workspace, with global config at `~/.config/natalia/config.json`. Use `NATALIA_CONFIG` and `NATALIA_WORKSPACES_FILE` to override paths.

### Safety Notes

- Never commit API keys or place them in prompts, diagnostics, screenshots, or session files.
- Browser tools require the Natalia Browser Bridge extension; they only connect to `127.0.0.1:18765`.
- Local transport tokens and certificates are secret.
- Plugins are trusted in-process code; install only packages you wrote or audited.

### Development

Repository checks:

```bash
npm run format
npm run typecheck
npm run test
npm run guard:imports
npm run licenses:check
npx bun scripts/ts-build.ts
```

<a id="chinese"></a>

## 中文

Natalia 是使用 TypeScript 和 Bun 构建的 local-first coding-agent runtime。它提供三个前端：

- **CLI**（`apps/cli`）
- **Web shell**（`apps/web`，包名 `@natalia/web-shell`）

两者共用同一套 `RuntimeClient`、事件模型和插件注册表。

### 主要能力

- 基于 JSON 或 SQLite 的持久化会话，支持历史、上下文压缩、恢复和会话分支。
- 一个 host 进程内支持多 workspace；每个 workspace 有自己的 runtime 和 session store。
- 每个 workspace 支持多个并发 session，Web shell 以 workspace -> session 树展示。
- 支持 OpenAI-compatible、Anthropic、Gemini 的流式 provider adapter。
- 类型化工具执行，带 schema 校验、策略、条件审批、审计和 secret 脱敏边界。
- Checkpoint 创建、预览、dry-run 回滚、确认回滚与安全 checkpoint。
- 托管进程与 PTY、sandbox、MCP server、skill、workflow 和可信进程内插件。
- 统一插件注册表与生命周期，覆盖 tools、commands、events、services、resources、projections、workflows、settings、adapters、scheduler jobs。
- 本地鉴权 HTTP/RPC、SSE、WebSocket、Unix socket、TLS transport，以及类型化 SDK 和 daemon 控制。

Natalia 是 local-first，不提供云账号、组织管理、账单、browser login、OAuth login 或 hosted synchronization。

### 架构

Natalia 分三层：**kernel + framework + plugin**。

- kernel 提供通用 registry、lifecycle、ownership、event、storage。
- framework 组合产品内部能力：session、provider、policy、checkpoint、workspace、runtime composition。
- 产品能力走同一套可信进程内插件系统；官方插件与用户安装包权限和生命周期相同。
- CLI 是权威维护入口。
- CLI 和 Web shell 是基于同一 `RuntimeClient`、事件流、workspace manager 和 command catalog 的入口。

### 环境要求

- Bun 与兼容 Node 的 npm 工具链。
- live model turn 需要 provider credential。
- 浏览器工具需要 Natalia Browser Bridge 扩展（见 `packages/plugins/browser/README.md`）。
- Windows 上需要 Git for Windows 与 Windows 版 managed WezTerm fork（使用交互式终端时）。

### 快速开始

#### CLI

```bash
export NATALIA_API_KEY="..."
export NATALIA_MODEL="your-model-id"
npm run ts:cli -- run "List the repository files"
npm run ts:cli -- run --json "List the repository files"
```

可以通过环境变量或 `.natalia/config.json` 配置 provider。

不要把 API key 提交到仓库。

#### Web shell

```bash
npm run ts:ui
```

这会启动本地 runtime 和 `@natalia/web-shell` 的 Vite dev server。

### 文档

以下每份文档都是单文件双语（English + 中文）。

- [快速开始](docs/getting-started.md) — 安装、provider 配置、CLI/Web shell、workspace 与 session。
- [API 参考](docs/api-reference.md) — 稳定 HTTP/RPC 协议：鉴权、失败分类、事件流、写面。
- [类型参考](docs/types-reference.md) — 每个结果类型的完整字段形状，嵌套对象已展开。
- [配置参考](docs/config-reference.md) — `.natalia/config.json` 的完整形状（类型、可选性、默认值）。
- [插件指南](docs/plugin-guide.md) — 从零开发插件，以及打包、安装、诊断与发布。
- [UI 指南](docs/ui-guide.md) — 构建与挂载 UI adapter 插件。
- [Provider 指南](docs/provider-guide.md) — 编写 provider adapter。
- [CLI 命令参考](docs/commands.md) — runtime、session、filesystem、plugin、UI、daemon、diagnostics 与 recording 命令。

### CLI 与本地 Transport

```bash
npm run ts:cli -- run "Reply exactly: pong"
npm run ts:cli -- run --json "Reply exactly: pong"
printf '%s\n' '{"prompt":"Reply exactly: pong"}' | npm run ts:cli -- eval

NATALIA_TRANSPORT_TOKEN="local-token" npm run ts:cli -- serve 8787
npm run ts:cli -- daemon 8787
npm run ts:cli -- daemon-status
npm run ts:cli -- daemon-stop

npm run ts:cli -- plugin create ./my-plugin --id yourco.plugin --package @yourco/natalia-plugin
npm run ts:cli -- plugin create ./my-ui --id yourco.web --template ui
npm run ts:cli -- plugin create ./my-ts --id yourco.ts --language ts
npm run ts:cli -- plugin install ./my-plugin
npm run ts:cli -- ui ui.yourco.web
npm run ts:cli -- plugin list
npm run ts:cli -- plugin disable yourco.plugin
npm run ts:cli -- plugin enable yourco.plugin
npm run ts:cli -- plugin doctor
npm run ts:cli -- plugin reconcile
npm run ts:cli -- plugin uninstall yourco.plugin
```

本地 transport 支持鉴权 HTTP/RPC/SSE、WebSocket、Unix socket 和 TLS。transport token 和证书不要放进仓库。

### 会话与 Workspace

Session 保存在 `<workspace>/.natalia/sessions/`。checkpoint、已结算工具结果、审批/提问和 workspace 状态允许用户重新打开会话继续。

宿主支持一个进程内多 workspace。每个 workspace 有自己的 runtime client 和 session store；Web shell 从同一份 projection 渲染 workspace -> session 树。

CLI session 命令：

```bash
npm run ts:cli -- session list
npm run ts:cli -- session show <id>
npm run ts:cli -- session rename <id> "New title"
npm run ts:cli -- session pin <id>
npm run ts:cli -- session delete <id>
```

### 配置

workspace 配置在 `.natalia/config.json`，global 配置在 `~/.config/natalia/config.json`。可用 `NATALIA_CONFIG` 和 `NATALIA_WORKSPACES_FILE` 覆盖路径。

### 安全说明

- 不要把 API key 写入仓库、prompt、diagnostic fixture、截图或 session 文件。
- 浏览器工具需要 Natalia Browser Bridge 扩展，只连接 `127.0.0.1:18765`。
- 本地 transport token 和证书是秘密。
- 插件是可信进程内代码；只安装自己编写或审计过的包。

### 开发

仓库检查命令：

```bash
npm run format
npm run typecheck
npm run test
npm run guard:imports
npm run licenses:check
npx bun scripts/ts-build.ts
```

## License / 许可

Apache-2.0

## Contact / 联系方式

See the repository history and issue tracker.
