# Natalia

[中文](#中文) | [English](#english)

<a id="english"></a>

## English

**The coding agent that can't lose your work: every turn journaled, every
change checkpointed, every rollback previewable before you commit.**

That sentence is the design constraint, not the tagline. Everything below is a
mechanism that makes one of its three clauses true — or a consequence of
already having it.

### What is actually different

Six mechanisms. Each one is a claim you can check against the code.

#### 1. A session is a transaction, not a chat log

Every event a turn produces is appended to a durable journal (SQLite or JSON)
with a session sequence number. A checkpoint can be previewed, dry-run, and
then rolled back — and the rollback runs through a safety checkpoint created
first, so undoing an undo is possible. A process killed mid-turn settles the
interrupted turn into an explicit failure instead of leaving a row that claims
to be running forever.

_Check: `packages/framework/checkpoint`, `packages/framework/session`._

#### 2. The terminal is shared, and the keyboard has an owner

`inputOwner` is `model` or `human` as durable state, not an implicit
assumption. Input ownership is separate from geometry ownership, so resizing
the pane while the agent is typing in it is not a conflict. Secure input hides
what is typed from the model. Handing control back resumes the turn; taking it
pauses it. The PTY is real — a self-built ConPTY bridge on Windows, a
self-built bridge on POSIX.

_Check: `packages/plugins/native-terminal`, `packages/hosts/transport/src/terminal-ws.ts`._

#### 3. Tool access is a ladder, not a switch

`read-only → workspace-write → danger-full-access`, with the escalation
relation written down once as a table instead of scattered across call sites.
A missing or unusable sandbox backend fails closed: the runtime reports and
refuses, it never degrades silently into unconstrained execution.

_Check: `packages/hosts/confinement/src/escalation.ts`._

#### 4. The running runtime can be replaced without dropping your session

A configuration change is staged as a content-addressed candidate, passes a
verification gate, switches at an epoch boundary, and is health-checked
afterwards. A failed check rolls back automatically and leaves the incident
evidence in the journal. Deferred by default, so a switch lands between turns
rather than in the middle of one.

The gate has four faces — constitution, architecture guards, sandbox smoke,
and an independent audit — and all four are required. A gate missing a face
would pass exactly the candidates it was built to stop, which is worse than
having no gate.

_Check: `packages/core/composition/src/switch.ts`, `.../verification.ts`._

A consequence we did not set out to build: because a change is staged, gated
and revertible, the agent can work on **Natalia's own source**. The installed
baseline is read-only to a session; an iteration starts from a copy at a path
the model chooses (a bad iteration is deleted, not repaired), the goal transfers
rather than duplicates, and the parent session's goal is closed as `handed_off`
so two sessions never chase the same objective. We treat that as a stress test,
not a headline: if the change machinery cannot survive the agent editing its own
product, it has no business being used on your code.

_Check: `packages/framework/substrate/src/iterate-branch.ts`, `packages/plugins/iterate`._

#### 5. Extension is total: the interface is a plugin too

The UI host owns mount points, event fan-out, projection and lifecycle — and
renders no business panel of its own. The official interface ships as
`packages/plugins/ui/next`, a UI plugin like any other, so an official panel and
a third-party panel go through the same registration, permission and lifecycle
path. The event projection beneath it (`packages/hosts/view-store`) is
framework-free: no Solid, no DOM, no renderer — it executes no tools, holds no
credentials, and decides no policy.

#### 6. When it breaks, it tells you exactly where

An error or warning record carries the caller's own source location
(`file:line:column` plus function name) extracted from the stack, and the full
`Error.cause` chain unwrapped into a structured payload. Records are separated
into three domains — kernel, framework, plugin — and a plugin registers its own
logger into the central one rather than writing wherever it likes. Settings has
a log inspector with domain and severity filters and a copy-out of the canonical
one-line form.

#### The storage underneath all of it

Checkpoints and sandbox snapshots share one content-addressed object store:
sha256 objects in git-style two-character shards (so a directory listing never
scans a flat pile of files), a zip pack with a resident index daemon that
answers _where_ an object lives while the bytes always come from the local pack
(so a missing daemon is a slower store, never a wrong one), an optional
zero-dependency Rust core behind the same paths, and owner-relative garbage
collection where each owner declares its own reachable set — one owner's
collection can never prune another owner's live objects.

_Check: `packages/framework/object-store`._

### What this is not

- **Not a cloud service.** No account, no organization, no billing, no OAuth, no
  hosted sync. The runtime, the journal and the plugin store are a directory you
  can copy, move or delete.
- **Not a model, and not a gateway.** Three built-in provider families —
  Anthropic, Gemini, and OpenAI-compatible — plus a custom adapter module for
  anything else. If you need a dozen gateways out of the box, this is the wrong
  tool.
- **Not a chat interface.** A session is a revertible transaction, not a message
  log.
- **"Four agents" is not an AGI team.** They are four execution bodies on one
  runtime with separate prompt stacks, separate journal channels and an explicit
  collaboration protocol (mailbox, wake, audit). The auditor is read-only, its
  findings are independent of the actor it audits, and each finding records how
  many times it has been reopened — a rising count is a signal that the rule
  needs tuning.
- **Test count is not a selling point.** It is the reason a change is unlikely
  to break something: 12 architecture guards (imports, contract producers,
  dependency cycles, suppressions, event publishers, console use, foreign names,
  orphan modules, timeouts, memory budgets, test workspaces) run before the
  suite.

### Three front ends, one runtime

- **CLI** (`apps/cli`) — the authoritative maintenance surface: sessions, plugin
  store, diagnostics, install/uninstall/purge, replay, doctor.
- **Web shell** (`apps/web`) — serves the interface plugin on `127.0.0.1:8791`
  and talks to the runtime on `127.0.0.1:8790`.
- **Window host** (`apps/cef-desktop`) — a CEF window around that same web
  shell. Not a separate interface; the same one, native.

`natalia.exe` with no arguments starts all of it, in one process, and spawns
only the window host as a child. If CEF cannot start, the default browser opens
the same URL.

### Install

Windows: run the installer. It asks where the program goes **and where the data
goes**, defaulting to `%USERPROFILE%\.natalia` and letting you pick another disk
(the choice is written to `NATALIA_HOME` and to the uninstall entry). The
uninstaller reads that same path back and asks whether to delete your data or
keep it.

Linux and macOS:

```bash
bash install.sh
# or, to choose the data directory:
bash install.sh --data-dir /opt/natalia-data
```

### Requirements

- **Bun 1.4.0 exactly.** Other 1.4.x minors break the build or the suite.
- A provider credential for live model turns.
- Windows: Git for Windows. Interactive terminals use `natalia-conpty-bridge.exe`,
  shipped prebuilt under `packages/plugins/native-terminal/prebuilt/windows-x64/`.
- Native components (confinement backend, object store core) need a Rust
  toolchain; see `npm run native:all`.

### Quick start

```bash
export NATALIA_API_KEY="..."
export NATALIA_MODEL="your-model-id"
npm run ts:cli -- run "List the repository files"
```

Never commit API keys.

A source checkout needs two builds before anything renders — no other script
produces them:

```bash
npm run build:distribution   # dist/ts: the CLI bundle and the official plugins
npm run build:web            # apps/web/dist: the web shell
```

Then the full application:

```powershell
npm run package:windows      # release tree plus the Inno Setup installer
```

### Where data lives

Configuration is per workspace (`.natalia/config.json`); all user data lives in
one home, `~/.natalia/` by default. `NATALIA_HOME` relocates it as a whole,
`NATALIA_CONFIG` and `NATALIA_WORKSPACES_FILE` override single files, and the
older roots (`~/.config/natalia/`, `%APPDATA%\natalia\`) are still read, never
written.

### Documentation

- [Getting started](docs/getting-started.md)
- [API reference](docs/api-reference.md) — the stable HTTP/RPC protocol.
- [Types reference](docs/types-reference.md) — every result type's fields.
- [Config reference](docs/config-reference.md) — the full `config.json` shape.
- [Plugin guide](docs/plugin-guide.md) — authoring, installing, diagnosing.
- [UI guide](docs/ui-guide.md) — building and mounting interface plugins.
- [Provider guide](docs/provider-guide.md) — writing an adapter.
- [CLI commands](docs/commands.md)
- [Build and install](docs/build-and-install.zh-CN.md)
- [Reverse verification](docs/reverse-verification.zh-CN.md) — how fixes were
  verified against the running product.

New documentation is bilingual in a single file: English first, then Chinese.

### Working on this repository

- [CONTRIBUTING.md](CONTRIBUTING.md) — the engineering standards.
- [AGENTS.md](AGENTS.md) — the rules for AI agents working here.

`npm run verify` is the definition of done. CI runs exactly that command.

### Safety notes

- Never commit API keys, and never put them in prompts, diagnostics,
  screenshots or session files.
- Browser tools require the Natalia Browser Bridge extension and only connect to
  `127.0.0.1:18765`.
- Local transport tokens and certificates are secret.
- Plugins are trusted in-process code. Install only packages you wrote or
  audited.

### License

Apache-2.0.

<a id="中文"></a>

## 中文

**一个不会弄丢你工作的 coding agent：每一轮都落 journal，每一次变更都挂在
checkpoint 上，每一个回滚在你确认之前就能先预览。**

这句话是设计约束，不是标语。下面每一条，都是让它的某个分句成立的具体机制，
或者是拥有这条约束之后自然带来的结果。

### 真正的差异在哪

六个机制。每一条你都可以指着代码验证。

#### 1. 一个 session 是事务，不是聊天记录

每一轮产生的每个事件都追加进 durable journal（SQLite 或 JSON），带 session
序列号。checkpoint 可以先 preview、再 dry-run、最后才回滚 —— 而且回滚本身会
先自动建一个 safety checkpoint，所以「撤销一次撤销」是可能的。进程在一轮中途
被杀，中断的 turn 会被 settle 成明确的失败态，而不是留一行永远显示 running。

_可查：`packages/framework/checkpoint`、`packages/framework/session`。_

#### 2. 终端是共享的，而键盘有明确的主人

`inputOwner` 是 `model` 或 `human`，是 durable 状态，不是隐含假设。输入所有权
与几何所有权分离，所以「agent 正在终端里打字，你在拖窗口大小」不是冲突。安全
输入会把键入内容对模型屏蔽。把控制权交回去会续跑这一轮，收回来会暂停。PTY 是
真的 —— Windows 上是自己写的 ConPTY 桥，POSIX 上也是自己写的桥。

_可查：`packages/plugins/native-terminal`、`packages/hosts/transport/src/terminal-ws.ts`。_

#### 3. 工具权限是阶梯，不是开关

`read-only → workspace-write → danger-full-access`，升级关系只写一次、写成一张
表，而不是散落在各个调用点。沙箱后端缺失或不可用时**fail closed**：runtime 报错
并拒绝，绝不静默降级成不受限制的执行。

_可查：`packages/hosts/confinement/src/escalation.ts`。_

#### 4. 运行中的 runtime 可以在不丢你 session 的前提下换掉

一次配置变更会先被 stage 成内容寻址的候选，过一道验证门，在 epoch 边界切换，
然后做健康检查。检查失败会**自动回滚**，并把事故证据留在 journal 里。默认延迟
生效，所以切换落在两轮之间，而不是某一轮的中间。

验证门有四个面 —— 宪法、架构 guard、沙箱冒烟、独立审计 —— **四个全部必需**。
少一个面的门，恰好会放过它本来该挡下的候选，那比没有门更糟。

_可查：`packages/core/composition/src/switch.ts`、`.../verification.ts`。_

一个我们并非刻意设计的后果：正因为变更是 staged、有门、可回滚的，agent 可以
在 **Natalia 自己的源码**上工作。安装的 baseline 对会话只读；一次迭代从模型选定
路径上的**副本**开始（坏迭代删掉即可，不需要修），目标迁移而不是复制，父会话的
目标以 `handed_off` 关闭，所以两个会话永远不会追同一个目标。我们把它当**压力
测试**，不当卖点：如果这套变更机制扛不住 agent 改自己的产品，它就不配用在你的
代码上。

_可查：`packages/framework/substrate/src/iterate-branch.ts`、`packages/plugins/iterate`。_

#### 5. 扩展是彻底的：界面本身也是插件

UI host 只管挂载点、事件扇出、投影和生命周期，自己一行业务面板都不画。官方
界面就是 `packages/plugins/ui/next`，一个和第三方完全同类的 UI 插件 —— 官方面板
和第三方面板走同一套注册、权限与生命周期。它下面的投影层
（`packages/hosts/view-store`）是 framework-free 的：不依赖 Solid、不碰 DOM、
不依赖任何渲染器，也不执行工具、不持有凭据、不决定策略。

#### 6. 坏掉的时候，它告诉你坏在哪一行

error 与 warn 记录会带上调用方自己的源码位置（`file:line:column` 加函数名，
从栈里提取），并把完整的 `Error.cause` 链拆成结构化字段。记录分成三个域 ——
kernel、framework、plugin —— 插件把**自己的 logger 注册进总日志**，而不是想往
哪写往哪写。设置里有日志检查器，能按域和级别过滤，也能把规范的单行格式整段
复制走。

#### 这一切下面的存储

checkpoint 与 sandbox 快照共用同一个内容寻址对象存储：sha256 对象按 git 式的
两字符分片存放（列目录时不用扫一堆平铺文件），一个 zip pack 加一个常驻索引
daemon —— daemon 只回答对象**在哪**，字节永远从本地 pack 读（所以 daemon 缺席
只是更慢的存储，绝不是更错的存储），可选零依赖 Rust 核心走同一套路径，GC 是
owner-relative 的：每个 owner 自己声明可达集，一个 owner 的回收永远删不掉另一个
owner 的活对象。

_可查：`packages/framework/object-store`。_

### 这个项目不是什么

- **不是云服务。** 没有账号、没有组织、没有账单、没有 OAuth、没有托管同步。
  runtime、journal、插件店就是你磁盘上的一个目录，能复制、能挪走、能删掉。
- **不是模型，也不是网关。** 内置三个 provider 家族 —— Anthropic、Gemini、
  OpenAI 兼容 —— 其余走自定义 adapter 模块。如果你要开箱即用十几个网关，
  这不是你在找的工具。
- **不是聊天界面。** 一个 session 是可回滚的事务，不是消息记录。
- **「四个 agent」不是 AGI 团队。** 它们是同一个 runtime 上的四个执行体，各有
  独立的 prompt 栈、独立的 journal 通道，以及一套显式的协作协议（mailbox、
  wake、审计）。审计员是只读的，它的结论与被审计者独立，每条结论还记录被
  **翻案**过几次 —— 次数上升就是规则需要调整的信号。
- **测试数量不是卖点。** 它只是「改动不太可能弄坏东西」的原因：12 道架构
  guard（imports、contract、依赖环、类型抑制、事件发布、console 用法、外来
  项目名、孤儿模块、超时预算、内存预算、测试工作区）在测试套件之前跑完。

### 三个入口，一个 runtime

- **CLI**（`apps/cli`）—— 权威维护面：session、插件店、诊断、安装/卸载/purge、
  replay、doctor。
- **Web shell**（`apps/web`）—— 在 `127.0.0.1:8791` 上提供界面插件，并访问
  `127.0.0.1:8790` 上的 runtime。
- **窗口宿主**（`apps/cef-desktop`）—— 给同一个 web shell 套的 CEF 窗口。它不是
  另一个界面；它是同一个界面的原生形态。

`natalia.exe` 不带参数就启动以上全部（同一进程内），只把窗口宿主作为子进程
spawn。CEF 起不来时，用默认浏览器打开同一个 URL。

### 安装

Windows：直接跑安装器。它会问你程序装哪里，**也会问数据放哪里** —— 默认
`%USERPROFILE%\.natalia`，可以换到别的盘（选择会写进 `NATALIA_HOME`，同时写进
卸载注册表项）。卸载器会把同一个路径读回来，再问你是删除数据还是保留。

Linux / macOS：

```bash
bash install.sh
# 或者指定数据目录：
bash install.sh --data-dir /opt/natalia-data
```

### 环境要求

- **Bun 必须恰好是 1.4.0。** 其他 1.4.x 小版本会破坏构建或测试套件。
- live model turn 需要 provider credential。
- Windows：Git for Windows。交互式终端用 `natalia-conpty-bridge.exe`，预编译产物
  位于 `packages/plugins/native-terminal/prebuilt/windows-x64/`。
- 原生组件（confinement 后端、object store 核心）需要 Rust 工具链，见
  `npm run native:all`。

### 快速开始

```bash
export NATALIA_API_KEY="..."
export NATALIA_MODEL="your-model-id"
npm run ts:cli -- run "List the repository files"
```

不要把 API key 提交进仓库。

源码 checkout 在能渲染之前需要两次构建 —— 没有别的脚本会产出它们：

```bash
npm run build:distribution   # dist/ts：CLI bundle 与官方插件
npm run build:web            # apps/web/dist：web shell
```

然后是完整应用：

```powershell
npm run package:windows      # release 树加 Inno Setup 安装包
```

### 数据在哪

配置按 workspace 存放（`.natalia/config.json`）；全部用户数据都在一个主目录里，
默认是 `~/.natalia/`。用 `NATALIA_HOME` 整体迁移，用 `NATALIA_CONFIG` 与
`NATALIA_WORKSPACES_FILE` 覆盖单个文件；旧根（`~/.config/natalia/`、
`%APPDATA%\natalia\`）**仍会被读取，但不再写入**。

### 文档

- [快速开始](docs/getting-started.md)
- [API 参考](docs/api-reference.md) —— 稳定的 HTTP/RPC 协议。
- [类型参考](docs/types-reference.md) —— 每个结果类型的完整字段。
- [配置参考](docs/config-reference.md) —— `config.json` 的完整形状。
- [插件指南](docs/plugin-guide.md) —— 开发、安装、诊断。
- [UI 指南](docs/ui-guide.md) —— 构建与挂载界面插件。
- [Provider 指南](docs/provider-guide.md) —— 编写 adapter。
- [CLI 命令](docs/commands.md)
- [构建与安装](docs/build-and-install.zh-CN.md)
- [反向验证](docs/reverse-verification.zh-CN.md) —— 修复是如何对着运行中的产品
  验证的。

新文档一律双语合在一个文件里：英文段在前，中文段在后。

### 参与本仓库开发

- [CONTRIBUTING.md](CONTRIBUTING.md) —— 工程标准。
- [AGENTS.md](AGENTS.md) —— AI agent 在本仓库工作的规则。

`npm run verify` 就是「这个改动做完了」的定义。CI 跑的就是这一条命令。

### 安全说明

- 不要把 API key 提交进仓库，也不要写进 prompt、diagnostic fixture、截图或
  session 文件。
- 浏览器工具需要 Natalia Browser Bridge 扩展，且只连接 `127.0.0.1:18765`。
- 本地 transport token 和证书是秘密。
- 插件是可信的进程内代码，只安装自己编写或审计过的包。

### 许可

Apache-2.0。
