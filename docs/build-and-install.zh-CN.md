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

**安装位置 ≠ 状态位置。** 上一步装的是程序本身；你的配置、workspace
注册表、技能和 TUI 状态在另一个目录：`~/.config/natalia/`（POSIX）/
`%APPDATA%\natalia\`（Windows）。卸载不会动它。

### Windows

在 PowerShell 里：

```powershell
pwsh -NoProfile -File scripts\\install.ps1 -From <release目录>
```

同样落到 `~/.natalia`（`bin\\natalia.exe` + `versions\\`）。
**注意**：安装器参数是 `-NataliaHome`（不是 `-Home`——那是 PowerShell
的只读自动变量，写它会直接失败）。

卸载：`natalia.exe uninstall`。

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

没有 podman 或交叉工具链的机器：

```bash
npm run build:everything -- --skip-wezterm-ubuntu --skip-wezterm-windows
```

只编原生构件、不打 release 包：

```bash
npm run build:everything -- --skip-release
```

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
the program in place; your config, workspace registry, skills and TUI
state live in a separate directory: `~/.config/natalia/` (POSIX) /
`%APPDATA%\natalia\` (Windows). Uninstalling does not touch it.

Windows (PowerShell):

```powershell
pwsh -NoProfile -File scripts\\install.ps1 -From <release dir>
natalia.exe uninstall
```

(The installer's flag is `-NataliaHome`, not `-Home` — PowerShell's
read-only automatic variable.)

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
