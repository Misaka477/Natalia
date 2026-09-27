# Natalia CLI Command Reference

[中文](#中文) | [English](#english)

<a id="english"></a>

## English

Natalia CLI runs on Bun. The examples below use the workspace entrypoint:

```bash
npm run ts:cli -- <command>
```

Installed release builds can replace that prefix with `natalia-ts`.

Runtime configuration defaults to `.natalia/config.json`. Override it with `NATALIA_CONFIG`. Commands that accept `--workspace` otherwise use the current working directory.

## Run And Evaluate

```bash
npm run ts:cli -- run "List the repository files"
npm run ts:cli -- run --json "List the repository files"
npm run ts:cli -- run "Review this file" --attach src/index.ts
printf '%s\n' '{"prompt":"List the repository files"}' | npm run ts:cli -- eval
```

- `run <prompt>` executes one model turn.
- `run --json <prompt>` streams runtime events as JSON Lines.
- `run ... --attach <path>` adds workspace attachments and may be repeated.
- `eval` accepts JSON Lines on stdin. Requests may contain `prompt`, `delivery`, `attachments`, `cancel`, `pause`, or `resume`.

## Status And Diagnostics

```bash
npm run ts:cli -- status
npm run ts:cli -- doctor
npm run ts:cli -- doctor --json
npm run ts:cli -- doctor --workspace /path/to/project
npm run ts:cli -- diagnose
```

- `status` prints the current provider/model and runtime status.
- `doctor` checks configuration, model selection, migration state, and sessions.
  On Windows it also reports which bash the runtime resolved for shell
  calls — the path configured in Settings, a discovered Git for Windows,
  or nothing (an actionable line, not a stack trace).
- `diagnose` prints startup diagnostics as JSON.

## Runtime Services

```bash
NATALIA_TRANSPORT_TOKEN="local-token" npm run ts:cli -- serve 8787
npm run ts:cli -- daemon 8787
npm run ts:cli -- daemon-status
npm run ts:cli -- daemon-stop
```

- `serve [port]` runs the HTTP/RPC/SSE/WebSocket transport in the foreground.
- `daemon [port]` registers a local authenticated daemon and waits for signals.
- `daemon-status` inspects the registered daemon.
- `daemon-stop` stops the registered daemon.
- `--daemon-dir <path>` overrides daemon state storage.

## Sessions

```bash
npm run ts:cli -- session list
npm run ts:cli -- session list --json
npm run ts:cli -- session show <id>
npm run ts:cli -- session rename <id> "New title"
npm run ts:cli -- session pin <id>
npm run ts:cli -- session unpin <id>
npm run ts:cli -- session duplicate <id> --title "Copy" --id <new-id>
npm run ts:cli -- session export <id>
npm run ts:cli -- session import '<metadata-json>' --id <new-id>
npm run ts:cli -- session delete <id>
```

All session actions accept `--workspace <path>`.

## Workspace Filesystem

```bash
npm run ts:cli -- fs list --path src --limit 100
npm run ts:cli -- fs read src/index.ts --offset 1 --limit 200
npm run ts:cli -- fs glob 'src/**/*.ts' --limit 100
npm run ts:cli -- fs search 'createRuntime' --include '*.ts' --limit 100
```

The `fs` commands stay within the selected workspace and return JSON.

## Plugins

```bash
npm run ts:cli -- plugin create ./my-plugin --id yourco.demo
npm run ts:cli -- plugin create ./my-plugin --id yourco.demo --package @yourco/demo
npm run ts:cli -- plugin create ./my-tool --id yourco.echo --template tool
npm run ts:cli -- plugin create ./my-ui --id yourco.web --template ui
npm run ts:cli -- plugin create ./my-ts --id yourco.ts --language ts
npm run ts:cli -- plugin list
npm run ts:cli -- plugin install <spec>
npm run ts:cli -- plugin uninstall <id>
npm run ts:cli -- plugin enable <id>
npm run ts:cli -- plugin disable <id>
npm run ts:cli -- plugin doctor
npm run ts:cli -- plugin reconcile
```

`plugin create` writes a publishable starter package and refuses to overwrite
an existing directory. It requires exactly one directory and `--id <plugin-id>`;
`--package <npm-name>` is optional and defaults to the directory basename.
`--template command|tool|ui` selects the starter implementation (`command` is
the default). `--language js|ts` selects the source language (`js` is the
default). A TypeScript scaffold still publishes `src/index.js` as the install
entry; edit `src/index.ts` and keep the JavaScript entry in sync before
`plugin install`. The directory is resolved from the current process working
directory; `--workspace` does not relocate scaffold output. A UI template is a
normal plugin that registers an adapter kind.

`plugin list` reports installed packages through one catalogue. Install,
uninstall, enable, and disable each perform the complete lifecycle operation in
one command. `doctor` audits the installed state and `reconcile` repairs the
desired package closure. UI adapters use this same catalogue and lifecycle.
Natalia has exactly one plugin installation store. `uninstall`, `doctor`,
`reconcile`, and `reinstall` always operate on that store and have no
installation scope. `--workspace <path>` selects the project configuration used
by `install` (to enable the new plugin there), `enable`, `disable`, and the
enablement state shown by `list`.

`install <spec>` accepts npm registry specs, local directories, Git specs, and
local or remote tarballs. It installs the package into the Natalia instance's
single `plugin-store`, updates that store's `natalia.lock`, and enables the
plugin in the selected workspace. A failed install rolls the store closure back
and does not write a lock entry. No package is installed beneath a workspace.
The durable enable/disable state is read when a runtime starts or reconciles
configuration; these commands do not mutate another process's live registry.
See the [plugin guide](plugin-guide.md#2-from-zero-a-new-plugin-and-a-new-ui)
for the from-zero plugin and UI tutorials, then the later sections for API
contracts, output shapes, diagnostics, and built-in plugin IDs.

## Transport Recording

```bash
npm run ts:cli -- record /tmp/natalia-cassette.json 8787
npm run ts:cli -- replay /tmp/natalia-cassette.json
```

- `record <cassette> [port]` runs a transport server with recorded fetch traffic.
- `replay <cassette>` replays recorded interactions for diagnostics and tests.

## Web Shell

```bash
npm run ts:ui
```

- Starts a local runtime and the `@natalia/web-shell` Vite dev server.
- The web UI includes workspace/session trees, approvals, plugin management, terminal panes, and checkpoints.

Production build:

```bash
npm --workspace @natalia/web-shell run build
```

## UI

```bash
npm run ts:cli -- ui
npm run ts:cli -- ui <kind>
```

- `ui` lists the UI adapter kinds contributed by enabled installed and path plugins.
- `ui <kind>` mounts that UI adapter in-process against a real runtime and waits for `SIGINT`/`SIGTERM`, then closes the adapter, the plugin registry, and the runtime.

Every UI — the web shell or a freshly installed package — is launched through the same generic UI host (`createUiAdapterHost` in `@natalia/client`); see the [plugin guide](plugin-guide.md#6-ui-adapters).

## Current Help Behavior

The current CLI does not yet implement a generated `--help` command. Until that is added, this file is the canonical command-line reference. Running the CLI without a command prints plain status; unknown commands fail explicitly.

<a id="chinese"></a>

## 中文

Natalia CLI 基于 Bun 运行。以下示例使用 workspace 入口：

```bash
npm run ts:cli -- <command>
```

已安装的 release 构建可以把前缀替换为 `natalia-ts`。

默认运行配置在 `.natalia/config.json`，可用 `NATALIA_CONFIG` 覆盖。接受 `--workspace` 的命令默认使用当前工作目录。

## 运行与评估

```bash
npm run ts:cli -- run "List the repository files"
npm run ts:cli -- run --json "List the repository files"
npm run ts:cli -- run "Review this file" --attach src/index.ts
printf '%s\n' '{"prompt":"List the repository files"}' | npm run ts:cli -- eval
```

- `run <prompt>` 执行单轮模型任务。
- `run --json <prompt>` 以 JSON Lines 流式输出 runtime events。
- `run ... --attach <path>` 添加 workspace 附件，可重复使用。
- `eval` 从 stdin 读取 JSON Lines。请求可包含 `prompt`、`delivery`、`attachments`、`cancel`、`pause` 或 `resume`。

## 状态与诊断

```bash
npm run ts:cli -- status
npm run ts:cli -- doctor
npm run ts:cli -- doctor --json
npm run ts:cli -- doctor --workspace /path/to/project
npm run ts:cli -- diagnose
```

- `status` 输出当前 provider/model 与 runtime 状态。
- `doctor` 检查配置、模型选择、迁移状态和 sessions。
- `diagnose` 以 JSON 输出启动诊断信息。

## 运行时服务

```bash
NATALIA_TRANSPORT_TOKEN="local-token" npm run ts:cli -- serve 8787
npm run ts:cli -- daemon 8787
npm run ts:cli -- daemon-status
npm run ts:cli -- daemon-stop
```

- `serve [port]` 前台运行 HTTP/RPC/SSE/WebSocket transport。
- `daemon [port]` 注册本地鉴权 daemon 并等待信号。
- `daemon-status` 检查已注册的 daemon。
- `daemon-stop` 停止已注册的 daemon。
- `--daemon-dir <path>` 覆盖 daemon 状态存储目录。

## Sessions

```bash
npm run ts:cli -- session list
npm run ts:cli -- session list --json
npm run ts:cli -- session show <id>
npm run ts:cli -- session rename <id> "New title"
npm run ts:cli -- session pin <id>
npm run ts:cli -- session unpin <id>
npm run ts:cli -- session duplicate <id> --title "Copy" --id <new-id>
npm run ts:cli -- session export <id>
npm run ts:cli -- session import '<metadata-json>' --id <new-id>
npm run ts:cli -- session delete <id>
```

所有 session 命令都接受 `--workspace <path>`。

## Workspace 文件系统

```bash
npm run ts:cli -- fs list --path src --limit 100
npm run ts:cli -- fs read src/index.ts --offset 1 --limit 200
npm run ts:cli -- fs glob 'src/**/*.ts' --limit 100
npm run ts:cli -- fs search 'createRuntime' --include '*.ts' --limit 100
```

`fs` 命令会限制在所选 workspace 内，并返回 JSON。

## 插件

```bash
npm run ts:cli -- plugin create ./my-plugin --id yourco.demo
npm run ts:cli -- plugin create ./my-plugin --id yourco.demo --package @yourco/demo
npm run ts:cli -- plugin create ./my-tool --id yourco.echo --template tool
npm run ts:cli -- plugin create ./my-ui --id yourco.web --template ui
npm run ts:cli -- plugin create ./my-ts --id yourco.ts --language ts
npm run ts:cli -- plugin list
npm run ts:cli -- plugin install <spec>
npm run ts:cli -- plugin uninstall <id>
npm run ts:cli -- plugin enable <id>
npm run ts:cli -- plugin disable <id>
npm run ts:cli -- plugin doctor
npm run ts:cli -- plugin reconcile
```

`plugin create` 会写一个可发布的 starter package，并拒绝覆盖已存在目录。它要求恰好一个目录参数和 `--id <plugin-id>`；`--package <npm-name>` 可选，默认使用目录名。`--template command|tool|ui` 选择 starter 实现（默认 `command`）；`--language js|ts` 选择源码语言（默认 `js`）。TypeScript 脚手架仍以 `src/index.js` 作为安装入口；在 `plugin install` 前需要先编辑 `src/index.ts` 并同步 JavaScript 入口。目录从当前进程工作目录解析，`--workspace` 不改变 scaffold 输出位置。UI 模板仍是注册 adapter kind 的普通插件。

`plugin list` 通过一张 catalog 报告已安装包。install、uninstall、enable、disable 各自在一个命令内完成完整生命周期操作。`doctor` 审计安装状态，`reconcile` 修复期望的 package closure。UI adapter 使用同一 catalog 和生命周期。Natalia 只有一个插件安装 store。`uninstall`、`doctor`、`reconcile` 和 `reinstall` 都操作同一个 store，没有安装 scope。`--workspace <path>` 用于选择 `install` 启用新插件的项目配置，以及 `enable`、`disable` 和 `list` 显示的启用状态。

`install <spec>` 接受 npm registry spec、本地目录、Git spec、本地/远程 tarball。它会安装到 Natalia 实例唯一的 `plugin-store`，更新该 store 的 `natalia.lock`，并在所选 workspace 启用插件。安装失败会回滚 store closure，不写 lock entry。不会在某个 workspace 下安装包。持久化的 enable/disable 状态在 runtime 启动或 reconcile 配置时读取；这些命令不直接修改另一个进程的 live registry。从零创建插件和 UI 的教程见 [plugin guide](plugin-guide.md#2-from-zero-a-new-plugin-and-a-new-ui)。

## Transport 录制

```bash
npm run ts:cli -- record /tmp/natalia-cassette.json 8787
npm run ts:cli -- replay /tmp/natalia-cassette.json
```

- `record <cassette> [port]` 运行带录制 fetch 流量的 transport server。
- `replay <cassette>` 重放录制的交互，用于诊断和测试。

## Web Shell

```bash
npm run ts:ui
```

- 启动本地 runtime 和 `@natalia/web-shell` 的 Vite dev server。
- Web UI 包含 workspace/session 树、审批、插件管理、终端面板和 checkpoint。

生产构建：

```bash
npm --workspace @natalia/web-shell run build
```

## UI

```bash
npm run ts:cli -- ui
npm run ts:cli -- ui <kind>
```

- `ui` 列出已启用 installed/path 插件贡献的 UI adapter kinds。
- `ui <kind>` 在进程内对真实 runtime 挂载该 UI，并等待 `SIGINT`/`SIGTERM`，然后关闭 adapter、plugin registry 和 runtime。

每个 UI——Web shell 或新安装的包——都通过同一个通用 UI host（`@natalia/client` 的 `createUiAdapterHost`）启动；详见 [plugin guide](plugin-guide.md#6-ui-adapters)。

## 当前 Help 行为

当前 CLI 还没有生成 `--help` 命令。在该功能加入前，本文件是 canonical command-line reference。不带命令运行 CLI 会输出纯 status；未知命令会显式失败。
