# Natalia

[中文](#中文) | [English](#english)

<a id="english"></a>

## English

Natalia is a local-first coding-agent runtime written in TypeScript and Bun.
Three front ends share one runtime:

- **CLI** (`apps/cli`)
- **Web shell** (`apps/web`, package `@natalia/web-shell`)
- **Desktop app** (`apps/cef-desktop`), the CEF shell the packaged
  application opens

### What the desktop app starts

`natalia.exe` with no arguments starts the application:

1. `natalia serve --port 8790` — the runtime API, in the same process.
2. `natalia serve-web --root <install>/web --port 8791` — the web shell, in
   the same process.
3. `natalia-cef-desktop.exe --url=http://127.0.0.1:8791/` — the only child
   process it spawns.
4. If CEF cannot start, the default browser opens instead.

The ports are fixed. The web shell bakes `http://127.0.0.1:8790` in at build
time, so an additional front end connects to the runtime that is already
running instead of starting a second one.

### Highlights

- Durable local sessions on JSON or SQLite: history, context compaction,
  recovery, and session forks.
- Multiple workspaces in one host process; each workspace owns its runtime
  and session store.
- Three agents with distinct jobs: **Natalia** works in the workspace,
  **Navi** is the live-chat collaborator, and **Nia** is the read-only
  auditor whose findings are independent.
- Streaming provider adapters for OpenAI-compatible APIs, Anthropic, and
  Gemini.
- Typed tool execution through schema validation, policy, conditional
  approval, audit, and secret redaction.
- Checkpoints: create, preview, dry-run rollback, and confirmed rollback
  with safety checkpoints.
- Managed processes and PTYs (ConPTY on Windows), sandboxes, MCP servers,
  skills, workflows, and trusted in-process plugins.
- One plugin registry and lifecycle for tools, commands, events, services,
  resources, projections, workflows, settings, adapters, and scheduler jobs.
- Authenticated local HTTP/RPC, SSE, WebSocket, Unix-socket, and TLS
  transports, with a typed SDK and daemon controls.

Natalia is local-first. It provides no cloud accounts, organization
management, billing, browser login, OAuth login, or hosted synchronization.

### Architecture

Three layers: kernel, framework, plugin.

- The kernel provides the generic registry, lifecycle, ownership, event, and
  storage mechanisms.
- The framework composes product internals: sessions, providers, policy,
  checkpoints, workspaces, and runtime composition.
- Product features are trusted in-process plugins. Official plugins and
  user-installed packages share one permission model and lifecycle.
- The CLI is the authoritative maintenance entry point.
- Every front end is an entry point over the same `RuntimeClient`, event
  stream, workspace manager, and command catalog.

### Requirements

- Bun 1.4.0 exactly. Other 1.4.x minors break the build or the test suite.
- Node-compatible npm tooling.
- A configured provider credential for live model turns.
- Windows: Git for Windows. Interactive terminals use the ConPTY bridge
  (`natalia-conpty-bridge.exe`), which ships prebuilt under
  `packages/plugins/native-terminal/prebuilt/windows-x64/`.
- Native components (confinement, object store) need the Rust toolchain; see
  `npm run native:all`.

### Quick start

CLI:

```bash
export NATALIA_API_KEY="..."
export NATALIA_MODEL="your-model-id"
npm run ts:cli -- run "List the repository files"
```

Never commit API keys.

Web shell in development:

```bash
npm run ts:ui
```

Windows package (release tree plus Inno Setup installer):

```powershell
npm run package:windows
```

### CLI and local transport

```bash
npm run ts:cli -- run --json "Reply exactly: pong"
printf '%s\n' '{"prompt":"Reply exactly: pong"}' | npm run ts:cli -- eval

NATALIA_TRANSPORT_TOKEN="local-token" npm run ts:cli -- serve 8787
npm run ts:cli -- daemon 8787
npm run ts:cli -- daemon-status
npm run ts:cli -- daemon-stop
```

The local transport supports authenticated HTTP/RPC/SSE, WebSocket, Unix
sockets, and TLS. Keep transport tokens and certificates outside the
repository. The full command list is in
[docs/commands.md](docs/commands.md).

### Sessions and workspaces

Sessions persist under `<workspace>/.natalia/sessions/`. Context
checkpoints, settled tool results, approvals and questions, and workspace
state let a user reopen a session and continue.

The host runs multiple workspaces in one process. Each workspace has its own
runtime client and session store; the web shell renders a workspace to
session tree from projected runtime state.

```bash
npm run ts:cli -- session list
npm run ts:cli -- session show <id>
```

Configuration lives in `.natalia/config.json` per workspace, with all user data
in ONE global home: `~/.natalia/` — `$HOME/.natalia` on Linux and macOS,
`%USERPROFILE%\.natalia\` on Windows. That folder holds the global
`config.json`, the workspace registry, TUI state, skills, the plugin store,
caches, operation logs and the object store. Use `NATALIA_HOME` to relocate it
and `NATALIA_CONFIG` / `NATALIA_WORKSPACES_FILE` to override single files;
older locations (`~/.config/natalia/`, `%APPDATA%\natalia\`) are still read,
never written.

### Documentation

- [Getting started](docs/getting-started.md) — install, provider setup,
  front ends, workspaces, and sessions.
- [API reference](docs/api-reference.md) — the stable HTTP/RPC protocol:
  auth, failure kinds, events, the write surface.
- [Types reference](docs/types-reference.md) — the field shapes of every
  result type.
- [Config reference](docs/config-reference.md) — the full
  `.natalia/config.json` shape.
- [Plugin guide](docs/plugin-guide.md) — plugin authoring, installation,
  diagnostics, and publishing.
- [UI guide](docs/ui-guide.md) — building and mounting UI adapter plugins.
- [Provider guide](docs/provider-guide.md) — writing a provider adapter.
- [CLI commands](docs/commands.md) — every command group.
- [Build and install](docs/build-and-install.zh-CN.md) — the Windows build,
  the installer, and uninstall behavior.
- [Reverse verification](docs/reverse-verification.zh-CN.md) — how fixes
  were verified against the running product.

New documentation is bilingual in a single file: the English section first,
then the Chinese section. The three generated references above ship as
separate `.zh-CN.md` files until their generator changes.

### Working on this repository

- [CONTRIBUTING.md](CONTRIBUTING.md) — the engineering standards, including
  the commit message format.
- [AGENTS.md](AGENTS.md) — the rules for AI agents working in this
  repository.

`npm run verify` is the definition of "this change is done". CI runs
exactly that command.

### Safety notes

- Never commit API keys or place them in prompts, diagnostics, screenshots,
  or session files.
- Browser tools require the Natalia Browser Bridge extension and only
  connect to `127.0.0.1:18765`.
- Local transport tokens and certificates are secret.
- Plugins are trusted in-process code. Install only packages you wrote or
  audited.

### License

Apache-2.0.

<a id="chinese"></a>

## 中文

Natalia 是一个用 TypeScript 和 Bun 编写的 local-first coding-agent runtime。
三个前端共用同一份 runtime：

- **CLI**（`apps/cli`）
- **Web shell**（`apps/web`，包名 `@natalia/web-shell`）
- **桌面端**（`apps/cef-desktop`），打包后的应用打开的 CEF 外壳

### 桌面端启动链

`natalia.exe` 不带参数启动应用：

1. `natalia serve --port 8790` —— runtime API，同进程。
2. `natalia serve-web --root <install>/web --port 8791` —— web shell，同进程。
3. `natalia-cef-desktop.exe --url=http://127.0.0.1:8791/` —— 唯一 spawn 的子进程。
4. CEF 起不来时 fallback 到默认浏览器。

端口固定：web shell 在编译期把 `http://127.0.0.1:8790` 写死，因此新增的前端会
直连已在运行的 runtime，不会再起第二个。

### 主要能力

- 基于 JSON 或 SQLite 的持久化会话：历史、上下文压缩、恢复、会话分支。
- 一个宿主进程内多个 workspace；每个 workspace 有自己的 runtime 和 session store。
- 三个 agent 分工明确：**Natalia** 在 workspace 里干活，**Navi** 是实时对话协作者，
  **Nia** 是只读审计员，其结论独立。
- 流式 provider adapter：OpenAI 兼容接口、Anthropic、Gemini。
- 类型化工具执行：schema 校验、策略、条件审批、审计、secret 脱敏。
- Checkpoint：创建、预览、dry-run 回滚、带安全 checkpoint 的确认回滚。
- 托管进程与 PTY（Windows 上为 ConPTY）、sandbox、MCP server、skill、workflow，
  以及可信的进程内插件。
- 一套插件注册表与生命周期，覆盖 tools、commands、events、services、resources、
  projections、workflows、settings、adapters、scheduler jobs。
- 带鉴权的本地 HTTP/RPC、SSE、WebSocket、Unix socket、TLS transport，以及类型化
  SDK 和 daemon 控制。

Natalia 是 local-first，不提供云账号、组织管理、账单、浏览器登录、OAuth 登录或
托管同步。

### 架构

三层：kernel、framework、plugin。

- kernel 提供通用的 registry、lifecycle、ownership、event、storage 机制。
- framework 组合产品内部能力：session、provider、policy、checkpoint、workspace、
  runtime composition。
- 产品能力是可信的进程内插件；官方插件与用户安装的包共用同一套权限模型和生命周期。
- CLI 是权威的维护入口。
- 每个前端都是同一份 `RuntimeClient`、事件流、workspace manager 和 command
  catalog 之上的入口。

### 环境要求

- Bun 必须恰好是 1.4.0。其他 1.4.x 小版本会破坏构建或测试套件。
- 兼容 Node 的 npm 工具链。
- live model turn 需要已配置的 provider credential。
- Windows：Git for Windows。交互式终端使用 ConPTY 桥
  （`natalia-conpty-bridge.exe`），预编译产物位于
  `packages/plugins/native-terminal/prebuilt/windows-x64/`。
- 原生组件（confinement、object store）需要 Rust 工具链，见 `npm run native:all`。

### 快速开始

CLI：

```bash
export NATALIA_API_KEY="..."
export NATALIA_MODEL="your-model-id"
npm run ts:cli -- run "List the repository files"
```

不要把 API key 提交进仓库。

Web shell 开发模式：

```bash
npm run ts:ui
```

Windows 打包（release 树加 Inno Setup 安装包）：

```powershell
npm run package:windows
```

### CLI 与本地 transport

```bash
npm run ts:cli -- run --json "Reply exactly: pong"
printf '%s\n' '{"prompt":"Reply exactly: pong"}' | npm run ts:cli -- eval

NATALIA_TRANSPORT_TOKEN="local-token" npm run ts:cli -- serve 8787
npm run ts:cli -- daemon 8787
npm run ts:cli -- daemon-status
npm run ts:cli -- daemon-stop
```

本地 transport 支持带鉴权的 HTTP/RPC/SSE、WebSocket、Unix socket 和 TLS。
transport token 和证书不要放进仓库。完整命令列表见
[docs/commands.md](docs/commands.md)。

### 会话与 workspace

Session 持久化在 `<workspace>/.natalia/sessions/`。上下文 checkpoint、已结算的
工具结果、审批与提问、workspace 状态，让用户可以重新打开会话继续。

宿主在一个进程内运行多个 workspace。每个 workspace 有自己的 runtime client 和
session store；web shell 从投影出的 runtime 状态渲染 workspace 到 session 的树。

```bash
npm run ts:cli -- session list
npm run ts:cli -- session show <id>
```

workspace 级配置在 `.natalia/config.json`，**所有用户数据只有一个全局主目录**：
`~/.natalia/` —— Linux 与 macOS 为 `$HOME/.natalia`，Windows 为
`%USERPROFILE%\.natalia\`。全局 `config.json`、workspace 注册表、TUI 状态、
技能、插件店、缓存、操作日志与对象存储都在这个目录里。用 `NATALIA_HOME`
可以整体迁移它，用 `NATALIA_CONFIG` / `NATALIA_WORKSPACES_FILE` 覆盖单个文件；
旧位置（`~/.config/natalia/`、`%APPDATA%\natalia\`）**仍会被读取，但不再写入**。

### 文档

- [快速开始](docs/getting-started.md) — 安装、provider 配置、前端、workspace 与 session。
- [API 参考](docs/api-reference.md) — 稳定的 HTTP/RPC 协议：鉴权、失败分类、事件流、写面。
- [类型参考](docs/types-reference.md) — 每个结果类型的完整字段形状。
- [配置参考](docs/config-reference.md) — `.natalia/config.json` 的完整形状。
- [插件指南](docs/plugin-guide.md) — 插件开发、安装、诊断与发布。
- [UI 指南](docs/ui-guide.md) — 构建与挂载 UI adapter 插件。
- [Provider 指南](docs/provider-guide.md) — 编写 provider adapter。
- [CLI 命令](docs/commands.md) — 所有命令组。
- [构建与安装](docs/build-and-install.zh-CN.md) — Windows 构建、安装包与卸载行为。
- [反向验证](docs/reverse-verification.zh-CN.md) — 修复是如何对着运行中的产品验证的。

新文档一律双语合在一个文件里：英文段在前，中文段在后。上面三份生成出来的参考文档
在其生成器支持之前，仍是独立的 `.zh-CN.md` 文件。

### 参与本仓库开发

- [CONTRIBUTING.md](CONTRIBUTING.md) — 工程标准，含 commit 信息格式。
- [AGENTS.md](AGENTS.md) — AI agent 在本仓库工作的规则。

`npm run verify` 即「这个改动做完了」的定义。CI 跑的就是这一条命令。

### 安全说明

- 不要把 API key 提交进仓库，也不要写进 prompt、diagnostic fixture、截图或 session 文件。
- 浏览器工具需要 Natalia Browser Bridge 扩展，且只连接 `127.0.0.1:18765`。
- 本地 transport token 和证书是秘密。
- 插件是可信的进程内代码，只安装自己编写或审计过的包。

### 许可

Apache-2.0。
