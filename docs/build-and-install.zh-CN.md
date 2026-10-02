# Natalia 构建、投放与安装

[English](#english) | [中文](#中文)
<a id="中文"></a>

三种用法，各取所需：

| 你是…                              | 读哪节                                                               |
| ---------------------------------- | -------------------------------------------------------------------- |
| 下载了 release 的用户              | [§1 安装](#1-安装) → [§2 Git Bash 仅-windows](#2-git-bash仅-windows) |
| 想知道数据存在哪的人               | [§1 末尾的"安装位置 ≠ 状态位置"](#1-安装)                            |
| 拿到了源码想自己编译               | [§3 一次性全编译](#3-一次性全编译)                                   |
| 只有终端可执行文件（下载来的 exe） | [§4 终端可执行文件投放](#4-终端可执行文件投放prebuilt)               |

`natalia doctor` 随时回答“我这台机器现在解析成什么样”：模型、会话、
以及 Windows 上的 shell 解析结果。

---

## 1. 安装

### Linux / macOS

```bash
bash install.sh
```

默认安装到 `~/.natalia`（可执行文件在 `~/.natalia/bin/natalia`，
版本快照在 `~/.natalia/versions/<版本>/`）。指定别处：

```bash
bash install.sh --from <release目录> --home /opt/natalia
```

验证：

```bash
/opt/natalia/bin/natalia --version
natalia doctor          # 首跑体检
```

卸载（只删这个安装、不动你的数据）：

```bash
/opt/natalia/bin/natalia uninstall
```

**安装位置 ≠ 状态位置。** 上一步装的是程序本身。你的状态在**两个**根下，
卸载都不动它们：

| 根     | POSIX                | Windows                   | 装什么                                                      |
| ------ | -------------------- | ------------------------- | ----------------------------------------------------------- |
| 配置根 | `~/.config/natalia/` | `%APPDATA%\natalia\`      | config、workspace 注册表、技能、UI 状态                     |
| 状态根 | `~/.natalia/`        | `%USERPROFILE%\.natalia\` | `logs/`（操作日志）、`stores/`（SQLite 会话日志）、`vault/` |

**状态根是大的那个**——会话日志按工作区哈希分库，长年累月可以到 GB 级。
换机器/迁移数据时，两个根都要带走。

### Windows

在 PowerShell 里：

```powershell
pwsh -NoProfile -File scripts\\install.ps1 -From <release目录>
```

同样落到 `~/.natalia`（`bin\\natalia.exe` + `versions\\`）。
**注意**：安装器参数是 `-NataliaHome`（不是 `-Home`——那是 PowerShell
的只读自动变量，写它会直接失败）。

卸载：`natalia.exe uninstall`。

## 2b. 原生构件的前置（Windows）

要一个功能完整的分发，宿主需要：

| 工具                                  | 用途                                                        |
| ------------------------------------- | ----------------------------------------------------------- |
| Rust 稳定版（rustup）+ 你用的 target  | confinement 后端、object-store crate                        |
| target `wasm32-unknown-unknown`       | text-diff wasm                                              |
| target `wasm32-wasip1` + **WASI SDK** | 44 个 AST wasm 包（`build-ast-packs.ts` 通过它的 clang 编） |

WASI SDK 默认按平台找安装根（`/opt/wasi-sdk` / `C:\wasi-sdk`），可用
`WASI_SDK=<路径>` 覆盖。**它是真外部依赖，不是路径风格问题**——没有它，
AST 工具（`ast.diff` / `ast.refactor`）不可用。

这三个产物（`diff-wasm/ast/`、`natalia_diff_wasm.wasm`）都是 **gitignore 的构建产物**，
干净 clone 里没有，必须在宿主上编。

## 2. Git Bash（仅 Windows）

Linux 和 macOS 的 shell 就是 `bash`，**不需要任何设置**。

Windows 上 Natalia 的 shell 调用走 Git for Windows 的 bash（保持与
POSIX 完全一致的引号/重定向语义）。解析顺序：

1. **你在设置里填的路径**（推荐——固化的配置，不是环境变量）
2. 环境变量 `NATALIA_BASH_EXECUTABLE`（仅诊断用途）
3. 四个默认安装根（Program Files 等）× Git 的标准相对路径
4. `PATH` 自己的 `bash.exe`

装在非默认位置（`D:\\tools\\Git`、便携版）时，在设置的**运行时**分类
里找到 **Git Bash 路径**一行，填你的 `bash.exe` 全路径即可（留空 =
恢复自动搜索；Linux/macOS 上这一行根本不出现——那里的 shell 就是
`bash`，没有可配置的东西）。`natalia doctor` 会显示当前解析到哪一个、
以及是不是你配置的那个。一个都没找到时，运行时会明确报错并指向这个
设置项，而不是默默退回 cmd.exe。

> 这一行只在 Windows 出现，判断依据是**运行时上报的宿主平台**（它的
> 状态快照里带 `host:<platform>`），不是浏览器的 User-Agent——用
> Linux 笔记本连一台 Windows 宿主时，只有前者是对的。

## 3. 一次性全编译

一条命令构建分发所需的**全部**原生构件（按依赖顺序，逐步失败即停）：

```bash
npm run build:everything
```

八个步骤：confinement 后端 → 对象存储原生 crate（cdylib + 常驻索引
daemon）→ AST wasm 包（核心 + 44 语言）→ 许可清单 → wezterm Ubuntu
（podman，glibc 对齐）→ wezterm Windows（交叉构建）→ 插件分发 →
双平台 release（自带契约自检：布局/无机器本地状态/本平台终端二进制/
全部文件在校验和清单里）。

跳过标志的**确切含义**（只有 wezterm 是可跳的）：

| 跳过                                               | 影响                                                                                                                                                                                       |
| -------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `--skip-wezterm-ubuntu` / `--skip-wezterm-windows` | 不编 wezterm。**唯一可跳的一项**——如果你已编译好三个可执行文件，把它们投到 `packages/plugins/native-terminal/wezterm/target/release/`（`ts-build` 只读这个路径）即可，分发与源码运行都能用 |
| `--skip-release`                                   | 只编原生构件，不打 release 包                                                                                                                                                              |

**其余没有跳过标志，也不该有**：confinement 后端、object-store 原生 crate、AST wasm 包都是运行时真正需要的能力，跳掉 = 少功能或静默降级，不是一个等价构建。

在本机构建全部原生件的命令（`build:everything` 会同时打 **linux-x64 + windows-x64** 两个 release，没有 podman/交叉链的机器做不到——所以在 Windows 上请用这条而不是 `build:everything`）：

```powershell
npm run native:all          # confinement 后端 + object-store 原生 crate（cargo）
npm run diff:build-wasm     # text-diff wasm + 44 个 AST wasm 包
npm run build:windows       # 上面全部 + licenses + ts:build(不跳native) + plugin store + web
```

`build:windows` 里的 `ts:build` **不带** `NATALIA_BUILD_SKIP_NATIVE`——它会检查三个 wezterm 可执行文件在 `wezterm/target/release/` 并把它们 stage 进插件分发，缺一个就大声报错（半成品不是分发）。

每一步的成功/跳过/失败都带耗时打印；结束时列出每个产物的实际大小
（或“未构建”）。某一步失败会让整条构建停在那里并打印该命令的输出
尾部——半成品不是分发。

## 4. 终端可执行文件投放（prebuilt/）

交互式终端用的是本仓库维护的 wezterm fork。**如果你只有编译好的
三个可执行文件**（比如从别处下载的），把它们放进：

```
packages/plugins/native-terminal/prebuilt/<平台>/
```

其中 `<平台>` 是 `windows-x64` 或 `linux-x64`，三个文件是
`wezterm` / `wezterm-gui` / `wezterm-mux-server`（Windows 带 `.exe`）。

这个目录就是为“下载后直接用”准备的：**不需要你手动创建 wezterm
target/release 那一长串路径**——解压出来的目录结构本身就长这样。
release 包里已带对应平台的三个文件，无需再投。

解析顺序：显式指定的目录 → **prebuilt 投放目录** → fork 自己的构建
目录。解析不到时，报错信息会直接点名 prebuilt 目录（而不是只甩一个
环境变量）。该目录已被 git 忽略（它放大块二进制），你放什么都没
会被误提交。

⚠️ **两个目录，两种用途，别只放一个**：

| 路径                      | 谁读它                                      | 什么时候要                             |
| ------------------------- | ------------------------------------------- | -------------------------------------- |
| `prebuilt/windows-x64/`   | **运行时**（源码跑 `serve` 时插件自己解析） | 从源码跑                               |
| `wezterm/target/release/` | **`ts-build`**（打分发时 stage 进插件包）   | 打分发（`build:windows` / `ts:build`） |

`ts-build` 不跳 native 时**只读 `wezterm/target/release/`**：三个可执行文件缺一个，就直接抛
`missing terminal executable wezterm.exe`。要打分发，就把编译好的三个文件**同时**投到这两处。

## 5. 从源码跑（Windows / Linux 通用）

上面四节讲的是「拿到 release 目录」。**从源码跑**要另外两步，而且这两步
任何脚本都不会替你做（这是本轮补上的坑）：

```bash
bun install                        # 不要用 npm：workspace:* 依赖
npm run build:distribution         # dist/ts：CLI + 插件 + 插件 UI bundle
npm run build:web                  # apps/web/dist：web shell（只有它构建这个）
```

- **`build:web` 是必须的**：`ts:build`、`build:everything`、`release:build`
  三者都**不**构建 `apps/web/dist`，而 CEF 桌面和 `serve-web.ts` 伺服的正是
  它。跳过这一步 = 空白页面。
- **插件 store 别再手动同步**：`build:distribution` 已经带了
  `refresh:plugin-store`。

然后起服务：

```bash
bun apps/cli/src/main.ts serve 8790     # 运行时 API
bun apps/cef-desktop/serve-web.ts       # 静态 web → 127.0.0.1:5178
```

浏览器开 `http://127.0.0.1:5178`。

## 6. CEF 桌面：平台矩阵

CEF 本身跨平台（Chromium Embedded Framework，Windows/macOS/Linux 全都支持）。
**这个仓库目前接了两个平台**，差的从来不是 CEF：

| 平台    | CEF SDK 根                | 入口                           | 启动器                                                                                                                            | 构建                        |
| ------- | ------------------------- | ------------------------------ | --------------------------------------------------------------------------------------------------------------------------------- | --------------------------- |
| Linux   | `.cef-test/`              | `cefsimple_linux.cc`（`main`） | `run-cef-desktop.sh`                                                                                                              | `npm run desktop:cef:build` |
| Windows | `npm run package:windows` | 双击 Setup.exe                 | 链条与两路输入（`.iss`/`.wxs`）已就绪并在合成树上渲染验证过；**容器那一锤等你选 MSIX 还是 Inno Setup**，且需一台 Windows 机器编译 |
| macOS   | `npm run appbundle`       | 把 `.app` 拖到 Applications    | bundle 与 dmg staging 代码测过，**但没有 macOS release 产物喂它**（见下）；只在合成树上验证过                                     |

Windows 从零开始：

```powershell
pwsh -NoProfile -File scripts\build-cef-windows.ps1
```

### 6b. 安装包：各平台的实话

| 平台    | 装包脚本                  | 用户要做什么                  | 状态                                                                                                                                                                                                   |
| ------- | ------------------------- | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Linux   | `npm run appimage`        | 双击 AppImage，或从应用菜单点 | **可用**，已在真 release 产物上验证过（含 `ldd` 零未解析依赖）                                                                                                                                         |
| Windows | `npm run package:windows` | 双击 Setup.exe                | 链条与两路输入（`.iss`/`.wxs`）已就绪并在合成树上渲染验证过；**容器那一锤等你选 MSIX 还是 Inno Setup**，且需一台 Windows 机器编译                                                                      |
| macOS   | `npm run appbundle`       | 把 `.app` 拖到 Applications   | 已在**真 darwin release 树**上验证过（`bun --target=bun-darwin-arm64` 交叉编译出的 66MB Mach-O runtime 被打进 bundle，`plistlib` 解析 Info.plist 15 键）；**CEF host 仍是合成占位**——它需在 mac 上构建 |

**每行的验证深度写在自己的「状态」里，不藏在脚注**：Linux 那行是真 release + 真 AppDir + ldd；Windows 那行是合成树渲染；macOS 那行同样只有合成树。三者不是一回事。

**macOS 为什么 defer**：`release:build --all` 只构建 host + windows-x64，因为没有
macOS 的终端构建（`build-wezterm-*.ts` 只有 ubuntu 和 windows 两版）。一个交互终端
跑不起来的 release 是带校验和的谎言，所以不做。`appbundle`/dmg staging 的代码写好并
测过，`stageDesktopHost` 里那个 `.app` 分支因此在 `--all` 下不可达（这点写在该函数的注
释里，避免下一个人误以为它被覆盖了）。

不过 runtime 那半边**可以**交叉编译：`bun build --compile --target=bun-darwin-arm64`
在本机产出了可用的 Mach-O arm64 二进制，`stageWebShell`/`appbundle` 也已在这样的真树上
验证过。所以 macOS release 缺的**只是** CEF host 和 wezterm natives——这两个必须在 mac
上构建。哪天真要出 macOS 分发，补的是这两个平台构建，不是打包链。

它做三件事：拉同版本 Windows CEF 分发（`scripts/fetch-cef-windows.ts`，
版本从 `.cef-test/include/cef_version.h` 读，**不一致就报错**而不是链到
奇奇怪怪的符号错误）→ 用 clang-cl/Ninja 或 MSVC 构建 → 校验 CEF 运行时
落在 exe 旁边。

只有 Linux 机器、想产出 Windows 包：CEF 的 Windows 分发给的是 **MSVC 格式**
（`libcef.lib` / `libcef_dll_wrapper.lib`），所以交叉链需要一套面向
`x86_64-pc-windows-msvc` 的 clang-cl + lld-link，并借 MSVC 的 CRT/头。
CMake 侧已经按平台分支（`WIN32`），工具链自备。

我们的 app 代码只有 `cefsimple_win.cc` 是 Windows 专属（入口）；
`simple_app.cc` 用的是 CEF 152 的 views 框架，平台无关；X11 那段全在
`#if defined(CEF_X11)` 里，Windows 上根本不编译。

<a id="english"></a>

## English

Natalia is a local-first coding-agent runtime. This guide covers building
the workspace, staging the terminal executables, and installing.

### 1. Install

Linux / macOS:

```bash
bash install.sh                       # or: --from <release dir> --home /opt/natalia
/opt/natalia/bin/natalia --version
natalia doctor                        # the first-run health report
/opt/natalia/bin/natalia uninstall    # removes this install only
```

**Where it installs is not where your data lives.** The command above puts
the program in place. Your state lives under TWO roots, and uninstalling
touches neither:

| Root        | POSIX                | Windows                   | Holds                                          |
| ----------- | -------------------- | ------------------------- | ---------------------------------------------- |
| config root | `~/.config/natalia/` | `%APPDATA%\natalia\`      | config, workspace registry, skills, UI state   |
| state root  | `~/.natalia/`        | `%USERPROFILE%\.natalia\` | `logs/`, `stores/` (SQLite journals), `vault/` |

The STATE root is the big one — journals are per-workspace SQLite files and
grow to GBs over time. Carry both when migrating a machine.

Windows (PowerShell):

```powershell
pwsh -NoProfile -File scripts\\install.ps1 -From <release dir>
natalia.exe uninstall
```

(The installer's flag is `-NataliaHome`, not `-Home` — PowerShell's
read-only automatic variable.)

### 1b. From source (Windows and Linux alike)

Two extra steps no script performs for you, plus why:

```bash
bun install                        # not npm: workspace:* dependencies
npm run build:windows              # see the native table below
npm run build:web                  # apps/web/dist: the web shell (still separate)
```

`build:distribution` 带 `NATALIA_BUILD_SKIP_NATIVE=1`，**那是 CI/测试专用**——它跳过 wezterm 的 stage。要一个功能完整的分发，用 `build:windows`（Windows）或 §3 的 `native:all` + `build:distribution:native`。

`build:web` is REQUIRED: `ts:build`, `build:everything` and `release:build`
all skip `apps/web/dist`, and that is exactly what the CEF desktop and
`serve-web.ts` serve. Skipping it yields a blank page. Then:

```bash
bun apps/cli/src/main.ts serve 8790     # the runtime API
bun apps/cef-desktop/serve-web.ts       # static web on 127.0.0.1:5178
```

### 1c. The CEF desktop's platform matrix

CEF itself is cross-platform (Windows, macOS, Linux). This repository wires
**two** platforms today; what was missing was never CEF:

| Platform | CEF SDK root    | Entry                            | Launcher              | Build                               |
| -------- | --------------- | -------------------------------- | --------------------- | ----------------------------------- |
| Linux    | `.cef-test/`    | `cefsimple_linux.cc` (`main`)    | `run-cef-desktop.sh`  | `npm run desktop:cef:build`         |
| Windows  | `.cef-windows/` | `cefsimple_win.cc` (`wWinMain`)  | `run-cef-desktop.cmd` | `npm run desktop:cef:build:windows` |
| macOS    | —               | (the views code needs no change) | —                     | pending                             |

On Windows, from nothing:

```powershell
pwsh -NoProfile -File scripts\build-cef-windows.ps1
```

It fetches the matching Windows CEF distribution (the version is read from
`.cef-test/include/cef_version.h`, so a mismatch fails loudly instead of at
link time), builds with clang-cl/Ninja or MSVC, and verifies the runtime
landed beside the executable.

On Linux, producing the Windows binary is a CROSS build: CEF's Windows
distribution is MSVC-format (`libcef.lib`, `libcef_dll_wrapper.lib`), so you
need a clang-cl + lld-link toolchain targeting `x86_64-pc-windows-msvc` and
MSVC's CRT/headers. The CMake side is already branched on `WIN32`; the
toolchain is yours to supply.

Our app code is Windows-specific in exactly one file (the entry point).
`simple_app.cc` uses the CEF 152 views framework and is platform-agnostic;
the X11 parts are guarded by `#if defined(CEF_X11)` and never compile there.

### 2. Git Bash (Windows only)

Linux and macOS need nothing: their shell IS bash.

On Windows, Natalia's shell calls resolve a bash-compatible shell in this
order: the path you set in Settings (a persisted configuration, not an
env var) → `NATALIA_BASH_EXECUTABLE` (diagnostics) → the four default
install roots → `PATH`'s own `bash.exe`. Set it under **Settings →
Runtime → Git Bash path** when Git for Windows lives outside the default
roots (`D:\\tools\\Git`, a portable install); `natalia doctor` reports
which one resolved and whether it is yours. Nothing found means a clear
error pointing at the setting — never a silent fallback to cmd.exe.

The row lives in the settings panel's Runtime category, and it appears
only on Windows: the host comes from the RUNTIME's status snapshot
(`host:<platform>`), not from the browser's User-Agent — a Linux laptop
driving a Windows host would get the wrong answer from the latter. On
Linux and macOS the row is absent because their shell IS bash and there
is nothing to configure.

### 3. Build everything

One command, in dependency order, fail-loud at every step:

```bash
npm run build:everything
```

Eight steps: the confinement backend → the object-store native crate (the
cdylib AND the resident index daemon) → the AST wasm packs (the core + 44
languages) → the license manifest → wezterm Ubuntu (podman, a glibc
match) → wezterm Windows (the cross build) → the plugin distribution →
the releases for both platforms (each self-verified: layout, no
machine-local state, its own platform's terminal binaries, every file
checksummed).

`--skip-wezterm-ubuntu`, `--skip-wezterm-windows` and `--skip-release`
exist for hosts without podman or the cross toolchain; each skip is
printed, and the closing table lists every artifact's size or
"not built". A failed step stops the build with that command's output
tail — a half-built distribution is not a distribution.

### 4. Prebuilt terminal executables

The interactive terminal uses this repository's managed wezterm fork.
With only the three executables in hand (downloaded from elsewhere), drop
them into one directory:

```
packages/plugins/native-terminal/prebuilt/<platform>/
```

`<platform>` is `windows-x64` or `linux-x64`, and the three files are
`wezterm` / `wezterm-gui` / `wezterm-mux-server` (`.exe` on Windows).

That directory exists precisely so a downloaded tree needs no hand-made
`wezterm/target/release` path — extracting an archive already has this
shape. Release bundles carry their own platform's three files.

Resolution order: an explicit directory → the prebuilt drop → the fork's
build directory; the error names the drop directory rather than only an
environment variable. The directory is git-ignored (it holds large
binaries) — whatever you drop there cannot be committed by accident.
