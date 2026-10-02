# Natalia Windows 分发测试回报（zh-CN）

> 分支 `explore` @ `a061272d`（tarball 导入，本地 git 提交 `60cb0a7`）
> 工作目录 `E:\Development\natalia-cli`
> 交接文档：`E:\windows-distribution-handoff.zh-CN.md`
> 结论先行：**全链在 Windows 上跑通了**（`build:windows` 绿、CEF 桌面端构建并启动、三个核心面板工作），
> 共修 **19 个 Windows 专属问题**（清单见下）。除 §P10 的启动卡死外，其余均为构建期/数据正确性问题。

## 环境

| 项       | 值                                                                                                                                                                 |
| -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Windows  | Windows 11 (10.0.26200)                                                                                                                                            |
| Git      | 2.53.0.windows.2（`D:\Software_Development\Git`）                                                                                                                  |
| Bun      | 1.3.14                                                                                                                                                             |
| Node     | 24.15.0（`D:\Software_Development\nodejs`）                                                                                                                        |
| CMake    | 4.3.1（conda env `natalia`）                                                                                                                                       |
| Ninja    | 官方 1.12.1（`D:\Software_Development\ninja`，**替换了 conda 的魔改版**，见 P16）                                                                                  |
| MSVC     | VS 2022 Community 14.44.35207（`D:\Software_Development\Microsoft Visual Studio`）                                                                                 |
| Rust     | 1.98.1 stable（`D:\Software_Development\rustup` + `D:\Software_Development\cargo`），targets `x86_64-pc-windows-msvc` / `wasm32-unknown-unknown` / `wasm32-wasip1` |
| LLVM     | 19.1.7（`D:\Software_Development\LLVM`，CEF 构建用 clang-cl 19.1.7）                                                                                               |
| WASI SDK | 34.0（`D:\Software_Development\wasi-sdk`）                                                                                                                         |
| node-pty | 1.0.0 已本机编译（`conpty.node` / `conpty_console_list.node` / `pty.node`）                                                                                        |

新增开发工具全部装在 `D:\Software_Development`；User 级环境变量已持久化：
`PATH` 追加 `D:\Software_Development\cargo\bin` 与 `D:\Software_Development\LLVM\bin`
（ninja 置于最前以压过 conda 版本），另设 `WASI_SDK` / `RUSTUP_HOME` / `CARGO_HOME`。

## 问题与修复清单（按发现顺序）

### P1 `bun install`：node-pty 1.0.0 的 Windows 原生编译三连炸（已修）

1. **MSB8040**：node-pty 的 `binding.gyp` 硬开 `SpectreMitigation: 'Spectre'`，VS 2022 未装 Spectre 版 MSVC 库。
   → 修法（**未提权**、未动 VS 安装）：`binding.gyp` 里 `SpectreMitigation` 改 `'false'`（同步改 bun 包缓存
   `~/.bun/install/cache/node-pty@1.0.0@@@1/binding.gyp`），MSBuild 直编。
2. **C2362 ×10**：`src/win/winpty.cc` 的 `PtySpawn` 有 6 处 `goto cleanup` 跨过变量初始化。
   → 改成等价的 `delete …; return;`（原 `cleanup:` 标签删除），语义不变。
3. **`PFNCREATEPSEUDOCONSOLE` 未定义**：新 Windows SDK 已定义 `PROC_THREAD_ATTRIBUTE_PSEUDOCONSOLE` 宏，导致
   node-pty 的整块回退 typedef 被 `#ifndef` 跳过，而 SDK 的函数指针类型又按 `NTDDI_VERSION` 门控没给。
   → 宏守卫保留，四个 `PFN*PSEUDOCONSOLE` typedef 改为无条件提供（C++ 允许同一 typedef 重声明）。

修完 `bun install` exit 0，重装幂等（缓存同步打了补丁）。
**已知残留（不影响分发）**：这些 `.node` 在 bun 下 dlopen 失败（两个后端都是）；但
`pty-terminal-controller.ts` 的 `defaultSpawn` 在 bun 下**故意不走 node-pty**（走 Python 桥，Linux 路径），
且 Windows 上 pty 后端已改报明确错误（见 P12），因此分发运行不经过这条 dlopen。

### P2 `native:all` 在 Windows 必然失败：confinement crate 是 Linux-only（已按设计分流）

`natalia-confinement-native` 26 个编译错误（`std::os::unix` / `libc::S_IFMT` / `Command::exec`）。
`packages/hosts/confinement/src/index.ts` 文档原话："macOS/Windows rungs are not here yet — on a platform
without a backend, only `danger-full-access` remains usable"；Windows 没有 landlock。
→ 修法：`package.json` 新增 `"native:windows"`（= object-store + index 两个 crate），`build:windows` 改用它；
`native:all`（Linux 语义）不动。**建议上游**：把 confinement 也改成 Windows 下直接跳过，而不是留给构建脚本调用方。

### P3 object-store 原生 crate 的 Unix 假设（已移植）

| #   | 位置                                   | 问题                                                             | 修法                                                                                                                                              |
| --- | -------------------------------------- | ---------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | `object-store/native-index/src/lib.rs` | `use std::os::unix::io::AsRawFd` + extern mmap                   | 增加 `#[cfg(windows)]` 实现：`CreateFileMappingW`+`MapViewOfFile`，Drop 里 `UnmapViewOfFile`+`CloseHandle`；struct 加 Windows-only `section` 句柄 |
| 2   | `object-store/native/src/packread.rs`  | 同上（pack 阅读端）                                              | 同 #1                                                                                                                                             |
| 3   | `object-store/native/src/lib.rs`       | `Permissions::from_mode`                                         | 抽 `restrict(path, mode)`：Unix 走 `from_mode`，Windows no-op                                                                                     |
| 4   | `object-store/src/rust-store.ts`       | 加载器写死 `libnatalia_object_store.so`                          | win32 加载 `natalia_object_store.dll`；CARGO_HOME 的 `/tmp` 默认值改仅 POSIX                                                                      |
| 5   | `object-store/src/native-index.ts`     | 候选路径写死 `.so`                                               | 按平台选 `.dll`（与 `daemon-client.ts` 既有分支同一惯例）                                                                                         |
| 6   | `package.json`                         | 链里没有单独编 index cdylib 的步骤（产物落不到 loader 找的位置） | 新增 `"native:index"`，并入 `native:windows`                                                                                                      |

验证：bun 下 `objectStoreBackendStatus()` = `rust`、`nativePackIndexAvailable()` = `true`；
产物 `natalia_object_store.dll` / `natalia-object-store-daemon.exe` / `natalia_index_native.dll`。

### P4 bun 下原生库测试 4 处 Windows 断点（已修）

1. **FFI `cstring` 不收 JS 字符串**（bun 1.3.14 Windows：`To convert a string to a pointer, encode it as a buffer`；
   Linux 侧 bun 宽容）。→ `native-index.ts` 加 `cstr()` 助手（NUL 结尾 utf8 buffer），并同步修 `NativeLib` 类型。
2. **`rust-cas-parity` 断言 `mode & 0o777 === 0o700`**（POSIX 专有）。→ 测试加 `win32` 跳过。
3. **daemon 死亡后写 stdin 抛 EPIPE**（异步 rejection 逃出 try/catch）。→ `await stdin.write(...)`。
4. **temp 目录清理 EBUSY**（store 的 SQLite metaDb 与 daemon 子进程占句柄）。→ `ObjectStore` 增 `dispose()`，三个测试的
   afterAll 先 dispose 再 rm。

`bun test packages/framework/object-store/test`：**39 pass / 0 fail / 1 平台跳过**。

### P5 `licenses:check` 在 Windows 必 stale（已按设计处理）

`THIRD_PARTY_LICENSES.txt` 的 144 个包版本一致，差异全是 bun 内部哈希目录的 `Source file:` 路径行
（Linux 侧提交的版本在 Windows 必然 stale）。→ 按报错提示 `bun scripts/generate-third-party-licenses.ts`
重新生成本地版，`licenses:check` 通过。**建议上游**：把 `Source file:` 行从校验内容里剔除。

### P6 CEF SDK 拉取：URL 命名错 + bun 写流不兼容（已修）

1. `fetch-cef-windows.ts` 把归档名拼成 `cef_binary_152.0.6_g708dc14_windows64_minimal.tar.bz2`（**404**）。
   Spotify CDN 真实命名是全版本串 `+` 连接：`cef_binary_152.0.6%2Bg708dc14%2Bchromium-152.0.7977.83_windows64_minimal.tar.bz2`。
   → 用完整 `CEF_VERSION`（`+` → `%2B`）拼 URL。**交接文档声称"下载后版本/校验一致性已在 Linux 侧验证"不实——
   这个 URL 从未真跑过。**
2. `createWriteStream(...).getWriter is not a function`（bun 的 `node:fs` WriteStream 无 WHATWG writer）。
   → `download()` 改用 `Bun.file(dest).writer()` 流式写，进度 readout 不变。
3. 干净克隆无 `.cef-test/include/cef_version.h`（§6.4 预告的异常）。→ 按交接文档 §4.4 记录的
   `152.0.6+g708dc14+chromium-152.0.7977.83` 造最小版本头（fetch 只读 `CEF_VERSION`）。

Windows 侧 tar 支持 bzip2（§2-#3 解除），sha256 校验通过。

### P7 CEF Windows 构建：9 个问题（全部已修）

`apps/cef-desktop/CMakeLists.txt` 的 Windows 分支是按**旧版 CEF 布局**写的（一切在发行版根下），
CEF 152 的真实布局完全不同：库在 `Release/`，wrapper 无预编译、要从 `libcef_dll/` 源码编。

| #   | 问题                                                                                                         | 修法                                                                                                       |
| --- | ------------------------------------------------------------------------------------------------------------ | ---------------------------------------------------------------------------------------------------------- |
| 1   | 库路径指向发行版根                                                                                           | 改指 `Release/{libcef.lib, libcef.dll}`；runtime 拷贝 `Release/` + `Resources/`                            |
| 2   | 链接不存在的 `libcef_dll_wrapper.lib`                                                                        | `find_package(CEF)` + `add_subdirectory(${CEF_LIBCEF_DLL_WRAPPER_PATH})`，链接 `libcef_dll_wrapper` target |
| 3   | `SimpleHandler::PlatformTitleChange` 只有 Linux 实现                                                         | 照 upstream CEF Windows 示例新增 `simple_handler_win.cc`                                                   |
| 4   | `wWinMain` 用 `LPTSTR`（UNICODE 未定义时是窄串）与宽字符原型冲突                                             | 改 `LPWSTR`                                                                                                |
| 5   | app 目标没开 `NOMINMAX`，windows.h 的 `min/max` 宏吃掉 CEF 的 `std::min/max`                                 | Windows 分支补 `NOMINMAX` + `WIN32_LEAN_AND_MEAN`（`_FILE_OFFSET_BITS=64` 改仅 POSIX）                     |
| 6   | CEF cmake 清空 `CMAKE_CXX_FLAGS*`，app 目标拿不到 `-DNDEBUG`，与 wrapper 的 `DCHECK_IS_ON` 不一致 → 链接错误 | 调 `SET_EXECUTABLE_TARGET_PROPERTIES`（CEF 官方集成方式），与 wrapper 同一 flag 家族                       |
| 7   | clang-cl 不接受 CEF flag 里的 `/MP`（-Werror 下报 unused）/`/MT`（与 CMake 的 `-MD` 运行时冲突）             | add_subdirectory 前过滤这两个 flag                                                                         |
| 8   | clang 对 CEF 自家代码的三个诊断在 /WX 下成错误（FARPROC 转换、部分初始化、undefined-var-template）           | wrapper 与 app 目标分别 `-Wno-error=` 降级为警告                                                           |
| 9   | lld-link 缺 `__delayLoadHelper2`（link.exe 隐式带 delayimp，lld 要显式）                                     | 链接 `delayimp`                                                                                            |

另外 `scripts/build-cef-windows.ps1` 两个 bug（见 P8）。构建结果：
`natalia-cef-desktop.exe` + `libcef.dll` + `*.pak` + `icudtl.dat` + `locales/` + `Resources/` 全部落地。

### P8 `build-cef-windows.ps1`：PowerShell 裸 token 不展开变量（已修）

`-DCMAKE_BUILD_TYPE=$Config` / `-G $generator` 原样传给 cmake——PowerShell 对**原生命令的裸 token**
不做变量展开，`CMAKE_BUILD_TYPE` 缓存里是字面量 `$Config` → rules.ninja 生成 `$Config` → ninja 词法错误。
**Linux 侧无法真跑 ps1，所以这个文件从未被正确执行过。** → 改为 `"$Config"` / `"$generator"`。

### P9 `run-cef-desktop.cmd`： LF 行尾 + `%PATH%` 块解析（已修）+ 后对齐 .sh 语义

1. 全文件 LF 行尾（tar 原样保留）——cmd.exe 解析错乱。
2. `if errorlevel 1 ( … set PATH=%…%;%PATH% )`：cmd 解析括号块时展开 `%PATH%`，本机 PATH 含
   `C:\Program Files (x86)` 等特殊字符 → `\Windows was unexpected at this time.`，脚本从未启动成功。
   → 改 `||` 单行链（`|| if exist … set "PATH=…"`），全局转 CRLF。

### P10 **启动卡死在启动页（用户报告）——根因：workspace 注册表为空（已修）**

**现象**：CEF 窗口显示 Natalia 启动画面不动；console 两条错：
`POST :8790/rpc 400` + `RuntimeRPCError: this runtime does not support pluginCatalog`。

**链路**：web 调 `plugin.catalog` → transport 的 `optionsGuard(client, "pluginCatalog")` 要求 client 有该方法
→ workspace-manager 的 Proxy 在无 active workspace 时对非 routable 方法返回 `undefined`（1284-1301 行）
→ "notSupported"。**每个 runtime 面都经 active workspace 解析**，注册表空 = 整个面全 undefined。
用户 Linux 机器 `~/.config/natalia/workspaces.json` 有历史条目所以从没暴露；干净 Windows 克隆必然踩中。

**修法**（`apps/cli/src/runtime-commands.ts`）：`manager.load()` 后若无 active workspace，
把 `process.cwd()` 种为默认 workspace（`basename(cwd)` 作 title）。
**验证**：重启后 `plugin.catalog` 返回全部 17 个插件（installed+enabled），`runtime.status`=win32，
会话可创建，启动页过。**建议上游**：把这条种子逻辑并入 `createWorkspaceManager`，并给无 workspace 的状态加显式错误。

### P11 终端面板：PTY 后端在 Windows 补上 wezterm pane 作为 spawn（已修）

**链路**：web 面板 → `/terminal/{sessionID}/{terminalID}` WS → transport → pty 控制器 → `defaultSpawn`。
Linux 下 spawn 是 Python 桥（`python3` + POSIX `pty` 模块）；Windows 两样都没有，node-pty 的 `.node` 在 bun 下
dlopen 也失败。

**修法（后端默认不动，只补 Windows 的 spawn）**：

1. `pty-terminal-controller.ts`：`defaultSpawn` 在 win32 且拿得到 host registry 时走 `spawnWithWezTermPty`——
   在 WezTerm mux 里起一个**真 pane**（`background: true`，窗口语义即 registry 自带的"background pane"：
   真 pane、不开窗），轮询 `observe` 喂 `onData`（增量追加 / 全屏重画，与 WS 面板同一纪律），
   write/resize/kill 转发到 registry（human actor）。`PtySpawnOptions` 增加原始 `command` 字段，
   避免与 registry 自己的 profile-shell 包装**双重包装**（反斜杠被 `sh -lc` 吃掉的坑）。
2. `terminal-plugin.ts`：win32 且 backend=pty 时，额外建 wezterm 控制器拿到 registry（`await init`），
   以 getter 形式注入 pty 控制器；dispose 顺序：先关 pty（停 pane）再关 host（拆 mux）。
3. `native-terminal.ts`：`start` 的 `background?: boolean` 显式化（实现早有该语义，只是没暴露）；
   `write` 补 `actor: "human"` 路径（此前 wezterm registry 的 write 只有模型路径，human 键盘输入一律被
   "terminal input is controlled by a human" 拒绝——这是 web 面板在 wezterm 后端不能打字的根因）。

**验证（E2E，真实 WS 链路）**：会话建 pane → `ready` → Git Bash MINGW64 提示符实时流入面板 →
输入 `echo E2E_TERMINAL_OK` 回显 → **0 个 wezterm-gui 窗口**。
**Linux 行为零变化**（backend 默认 `pty`、spawn 默认 Python 桥、`windowMode` 默认 `auto` 全部未动）。

**光标归位**：全屏重画的 dump 以屏幕尾部的空行结尾，光标会落在窗底而不是提示符后。
重画后补显式光标序列 `ESC[{cursorY+1};{cursorX+1}H`（observe 的视图本来就带 cursorX/Y，
mux 不送回退 1;1 = 提示符行首，不再掉到窗底）。E2E 验证：输出流以 CUP 序列结尾。

**曾走过的弯路（已回退，记录在案）**：一度把 win32 默认后端翻成 `wezterm` + `windowMode` 默认 `windowless`。
那是未经授权的配置行为变更——Linux 不弹窗口是因为它默认走 `pty`、路径里根本没有 wezterm，不是
Windows 需要不同的默认值。已全部回退；正确的修法是补 spawn，不是改默认。

### P12 治理 / Drift 面板刷出上千条"幽灵 deleted"（用户报告"假数据"）（已修）

**现象**：Drift 面板 `advisory - 55%`，`currentActivity` 里 `deleted:bun.lock`、`deleted:docs/api-reference.md`…
上千条，实际文件都在（`git status` 干净）。

**根因**：`framework-services.ts` 给 reconcile 注入的 `listPaths` 用的是 `findWorkspaceFiles`——
模糊查找目录（**ignore-free、结果硬顶 200、缓存 1s**）。`workspace-change-auditor.reconcile` 把
"不在集合里"判定为 deleted。仓库几千个文件，前 200 条之外的提示路径全部变成幽灵删除。
（这是真 bug 不是硬编码假数据：数据源是 watcher 真事件，只是删除判定被有界枚举污染。）

**修法**：

1. `platform/workspace-files.ts` 新增 `listWorkspaceFilePaths`：完整走查 + `.nataliaignore` 规则剪枝
   （node_modules/dist/target/\*.log…），带 `truncated` 诚实上报，上限 50k。
2. `workspace-change-auditor`：`reconcile(currentPaths, complete)`——集合不完整时，缺失的提示路径
   **保持 pending**（下次完整 reconcile 再确认），绝不编造删除；`observe` 对 ignore 规则命中的提示直接丢弃。
3. controller 契约改为 `listPaths: () => Promise<{paths, truncated}>`；注入换成新函数 + `isExcludedPath`。

**验证**：reconcile 现在只返回真实变动（造一个 `drift-proof.txt` → 只报 `modified: drift-proof.txt`）。
**说明**：修之前写入 ledger 的旧 finding 仍会显示（持久化事实），可在面板上"误报/忽略"消掉；
新 reconcile 不再产生幽灵数据。

### P13 用户要求：删除 `[web-terminal] fit` 调试日志（已按嘱删除）

`packages/plugins/native-terminal/src/ui/web-terminal.tsx` 的 `console.log("[web-terminal] fit", …)` 及其
专属配套（`measure()`/`chain` 采集，删除后已成死代码）一并移除；ResizeObserver 保留 `fitSafely()`。

### P14 npm 侧踩坑记录（环境侧，非仓库问题）

- conda env `natalia` 自带的 **ninja 1.13.0.git（jobserver 魔改版）** 解析不了 CMake 4.3.1 生成的
  `rules.ninja`（`expected newline, got lexing error`）。→ 装官方 ninja 1.12.1 并置于 PATH 最前。
- VS 2022 未装 Spectre MSVC 库导致 MSB8040；提权装组件被用户拒绝 → 走 P1 的禁 Spectre 方案。
- wezterm 从源码构建（`native-terminal:build-wezterm:windows`）卡在 `openssl-sys`（vendored OpenSSL 要 perl）。
  用户已提前用 Linux 交叉编译好三 exe 放在 `E:\natalia-wezterm-windows`，按交接文档 §4.6 投两处：
  `prebuilt/windows-x64/` 与 `wezterm/target/release/`，冒烟 `wezterm --version` 通过。

## 步骤结果（交接文档 §9 格式）

| 步骤                                                             | 结果                                                                       |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------- |
| ① 干净克隆 explore                                               | ✅（tarball 导入 + 本地 git 化，a061272d 内容）                            |
| ② 装工具（rustup + wasm targets + WASI SDK + LLVM + 官方 ninja） | ✅ 全装 `D:\Software_Development`                                          |
| ③ bun install（node-pty 本机编译）                               | ✅ exit 0                                                                  |
| ④ npm run native:all                                             | ⚠️ Linux-only 的 confinement 必失败（P2，设计内降级）；`native:windows` ✅ |
| ⑤ npm run diff:build-wasm                                        | ✅ 44/44 AST packs + diff core（WASI SDK 34）                              |
| ⑥ npm run licenses:check                                         | ✅（重新生成 Windows 路径版清单）                                          |
| ⑦ bun scripts/ts-build.ts                                        | ✅ 16 插件 + node-abi（v137）+ wezterm 三 exe stage                        |
| ⑧ npm run refresh:plugin-store                                   | ✅ 17 插件写入 store                                                       |
| ⑨ npm run build:web                                              | ✅ vite 产物                                                               |
| ⑩ desktop:cef:fetch:windows                                      | ✅ 152.0.6 sha256 校验通过                                                 |
| ⑪ build-cef-windows.ps1                                          | ✅ exe + runtime 落地（P7 九修）                                           |
| ⑫ run-cef-desktop.cmd                                            | ✅ 8790/5178/CEF 窗口全起                                                  |
| ⑬ bun test（object-store / workspace）                           | ✅ 39+45 pass，0 fail                                                      |
| ⑭ npm run typecheck                                              | ✅ exit 0                                                                  |
| ⑮ 终端面板                                                       | ✅ wezterm 后端 Git Bash running                                           |
| ⑯ 启动页工作负载                                                 | ✅ 17 插件目录 + runtime.status + 会话                                     |

## 遗留与建议

1. **bun 无法加载 node-pty 原生模块**（P1 残留）：建议上游把 node-pty 改 optional 或在 install 脚本加 windows 跳过；
   分发走 wezterm/python 两条路，node-pty 仅纯 Node 路径需要。
2. **cefdesktop 的 CMakeLists Windows 分支是按旧 CEF 布局写的**：本次已修到 152 的真实布局；若上游再升级 CEF，
   建议直接采用 CEF 官方 cmake 集成示例的写法（`find_package(CEF)` + `add_subdirectory(libcef_dll)`）。
3. **`THIRD_PARTY_LICENSES.txt` 校验内容含机器相关路径**：建议剔除 `Source file:` 行（P5）。
4. **confinement 的 `native:all` 无平台门**：建议 crate 级 `#[cfg(not(windows))]` + 脚本平台分流（P2）。
5. **workspace 空注册表=全运行时面静默失效**：建议 manager 内置默认 workspace + 显式错误（P10）。
6. **`reconcile` 的路径枚举必须完整且 ignore-aware**：不要再复用模糊查找目录（200 条上限）做
   baseline/reconcile（P12）。
7. Vite 构建的 `syntax-worker-*.js` 报 `Unexpected token '?'` 的 sourcemap 噪声：非致命（仅 devtools 解析
   sourcemap 的产物大小写路径），不改逻辑，仅记录。

### P17 `refresh:plugin-store` 在 runtime 运行中必失败 EACCES（已修）

**现象**：`npm run refresh:plugin-store` 报 `EACCES: permission denied, rm 'dist\ts\plugin-store'`。
**根因**：runtime 的全仓 watcher 用 `ReadDirectoryChangesW` 握着 store 目录（ignore-free），
`rm -rf` 整个目录失败；随后逐文件拷贝又会撞上**运行中进程的 exe 映像锁**（`wezterm-mux-server.exe` EBUSY）。
**修法**（`scripts/refresh-plugin-store.ts`）：`rm` 改为尽力而为（EACCES 时跳过），
插件拷贝改为逐文件容错（EBUSY/EACCES/EPERM 跳过并计数、不中断），锁住的文件下次刷新再补。
**语义**：store 服务的是下一次 runtime，held-as-is 是旧副本不是坏副本；`natalia.lock` 才是加载权威。

### P18 `run-cef-desktop.cmd` 与 .sh 语义对齐（已修）

Linux 的 `.sh` 用**前台 CEF 窗口 + 退出即清理 server**（SIGTERM + wait），且把
`NATALIA_CONFIG` / `NATALIA_WORKSPACES_FILE` 指到**仓库内 `.natalia/`**。Windows 原 cmd 两样都没有：
`start /b` 脱离导致 server 孤儿化（孤儿持有端口和 `dist\ts\plugin-store` 句柄，正是 P17 的 EACCES 来源），
且 registry 落到用户 profile、与 Linux 不同处。已重写：前台窗口、退出即按 window title 清理、
两个 config 环境变量对齐 .sh、CRLF。

### P19 native-terminal 测试的 Linux 预设（已加平台守卫）

- `default python pty spawn runs an interactive shell` / `input written the instant a pty starts is not dropped by the bridge`
  ——依赖 `python3` + POSIX `pty` 模块，win32 早退跳过。
- `the prebuilt drop directory is the first candidate` ——期望值用 `join()` 拼，随平台分隔符。

`bun test packages/plugins/native-terminal/test`：**132 测试 0 fail / 3 skip**。

## 复现/验证入口

### P20 终端真字节流：ConPTY bridge（按 Linux 路线复刻的最终形态）

Linux 的终端是**真 PTY 字节流**（`spawnWithPythonPty`：python3 `pty.fork()` → onData 透传）。
Windows 上 node-pty（conpty.node）在 bun 下 dlopen 失败、Python 无 `pty` 模块，所以之前只有
"wezterm mux pane + 屏幕轮询 differ"的降级实现（视觉上天花板明显）。

现在补上了正主：`packages/plugins/native-terminal/src/win/natalia-conpty-bridge.cc`——
一个独立 ConPTY host（C++，clang-cl 单文件、无依赖，`npm run native-terminal:build-conpty:windows`，
产物落在 `prebuilt/windows-x64/natalia-conpty-bridge.exe`）。它与 POSIX 桥说**同一协议**
（stdin 一行 JSON spec；stdout `{kind} {size}\n` 帧 + `{"pid":N}` 握手；stdin JSON
control 行 input/resize/kill），所以 pty 控制器、面板、模型看到的就是 Linux 那套**真实字节**。

实现要点：

- `pty-terminal-controller.ts` 抽出共享的 `spawnPtyBridge(child, options)`，Python 桥与 ConPTY 桥
  共用全部帧解析逻辑；`defaultSpawn` 在 win32 上**优先 ConPTY 桥**，helper 未构建时才回退 wezterm differ。
- ConPTY 关键坑：`CreateProcessW` 带伪控制台属性时**不能传 lpApplicationName**（ERROR_INVALID_PARAMETER 87）；
  **lpEnvironment 传 nullptr**（手搓 env block 稍有不合即 87；nullptr = 继承宿主环境，PATH 全在，ConPTY 自设 TERM）。
- E2E（真实 WS 链路）：会话 → WS open → start → ConPTY 桥起 bash → 键入 `echo E2E_CONPTY_OK`
  原样回显、光标跟在提示符后。首帧清屏是 ConPTY 自身启动序列，不是 differ。

**仍未解决（已核实的事实，留给下一轮）**：消息发送。`submit.input` 0.07s 返回 `turn.submitted`，
但该 turn **没有任何 turn 事件**落库（history 里只有 terminal 事件）；`model.selection`/
`model.catalog`/`runtime.status` 全正常，空工作区也复现，Linux 无此问题。submint→turn 派发链
在 Windows 上静默中断，位置未定位。

## 复现/验证入口

- 全量链：`npm run build:windows`（本机已验证 exit 0）
- CEF：`powershell -NoProfile -File scripts\build-cef-windows.ps1`（需 PATH 前置官方 ninja + LLVM bin）
- 运行：`apps\cef-desktop\run-cef-desktop.cmd`（8790/5178/CEF 窗口）
- 原生库冒烟：`bun test packages/framework/object-store/test packages/framework/workspace/test`
- 类型：`npm run typecheck`

### P21 消息发不出去：provider 永不被创建（已定位，已从代码层治本）

**现象**：UI 发送无响应；`submit.input` 返回 `turn.submitted` 后 turn 以 `stopReason:"error"`
静默结束（无 error 事件、无 diagnostic）；空工作区/新机器同样复现；Linux 无此问题。
provider 端点直连实测 200（stepfun step_plan 通道，key 有效）。

**根因（两层，都在 `packages/framework/client/src/runtime`）**：

1. **boot 只认 env**：`plugin-assembly.ts` 的 `initialize()` 只走 `providerFromEnvironment()`；
   config 侧建 provider 的路径（`providerForModel` + defaultModel 兜底）**只由 config 重载触发**。
   纯配置文件部署（或没设默认模型的新机器）→ provider 恒为 not-configured →
   `provider-runner.ts:184` 每轮 turn 静默 error。
2. **attach 门禁**：`applyAgentProvider` 守 `providerSource !== "ts_config"` 就 return，
   而没有默认模型时 source 恒为 `unconfigured` → 会话已选模型在 attach 时也被挡掉
   （没 provider → 不建 provider 的首轮死循环）。

**修复（代码，治本）**：

- `plugin-assembly.ts`：initialize 增加 config 兜底——无 env provider 时按
  `getSelectedModel() ?? config.defaultModel` 解析 provider（source=ts_config）。
- `provider-selection.ts`：`applyAgentProvider` 门禁从"仅 ts_config"放开为
  "environment/explicit 不覆盖；ts_config/unconfigured 均按选择解析"。
- **默认模型仍是"设置即写入"语义**：UI 设置面的 Default Model（`model.setDefault`）本来就把
  `{provider, model}` 对象写进全局 config 并重载——保持原语义。会话级 `model.select`
  不做隐式持久化（不把每次面板选择偷偷写成全局默认）。

**验证（三种形态都通）**：

1. 无 defaultModel、无 env、会话有选择 → boot 即 `model=step-5-preview / provider=openai-compatible`，
   turn 完整跑完（thinking.done + content.partial + content.done + turn.finished）。
2. 有 defaultModel（对象）→ boot 即解析，模型中文回复正常。
3. 新机器：设置面配 provider → 面板选模型即可用；要固化点"设为默认"（写 config）。

**配置 schema 注意**：`defaultModel` 是 **ModelRef 对象** `{provider, model}`，
写成 `"provider/model"` 字符串会让 `configV3Schema.parse` 抛错，
`model.select`/`model.setDefault` 对外表现为 `internal runtime failure`。
（给上游：schema 可接受字符串并归一化；报错应直接指向"defaultModel 需对象"。）

### P22 Windows 既有测试失败（非本次改动引入，仅记录）

`bun test packages/framework/client/test` 12 个失败：sandbox 路径 / checkpoint 恢复 /
EBUSY 临时目录清理（Windows 句柄未释放）。`git stash` A/B 确认与本次改动无关。

### P23 终端：ConPTY 桥的 mute pane 回归，默认切回 wezterm pane（桥降为开关）

**现象**：ConPTY 桥的 pane 只输出 16 字节初始化序列（`ESC[?9001h ESC[?1004h`）后静默——
console 起来了、子进程 bash 活着（0 CPU 阻塞），但没有任何屏幕字节回传；探针与真实 runtime
路径同症状。

**取证事实**：

- 同一个二进制（177664B 的 env-free 构建）在 06:2x 的 E2E 中收到 echo（`echo seen: true`），
  07:2x 起同样二进制只有 16 字节——二进制相同、spec 相同，行为不同。
- 期间累计过约 10 个卡死的桥+bash（每次失败探针留一个；已全部 taskkill 清理，进程归零），
  清理后仍然静默——不是控制台池耗尽。
- 期间一次给桥加了 spec env 的逐条应用（SetEnvironmentVariableW）+TERM 默认（182784B），
  同样静默；已回退为纯环境继承（177664B）。
- 回退后 differ 路线（wezterm pane + output-chunk）在真实 runtime 全恢复：
  prompt 渲染 / echo 回显 / 光标归位均正常（realpath-check code=0）。

**当前形态**：

- win32 默认 spawn = wezterm mux pane 适配器（screen-dump differ，带首帧修复+行对齐追加+
  光标归位）；`NATALIA_TERMINAL_CONPTY=1` 时走 ConPTY 桥。
- 桥代码保留、编译产物保留（ts-build 暂存清单已修，4 个 exe 都进 store），只是运行时默认不选它。

**下一轮定位方向**（按优先级）：

1. 用 Process Monitor 抓一次 mute 期的桥：看 WriteFile(conin) / ReadFile(conout) 哪一侧无流量；
2. 对照 06:2x 成功时与现在的差异变量——唯一未排除的是 ConPTY 的 host 侧握手
   （conhost 与 host 之间的 viewport 协商：成功那次前 pane 恰好被 resize 过）；
3. 若确认是 ConPTY host 侧握手，则在桥启动后主动发一次 ResizePseudoConsole（把 spec 的
   cols/rows 再设一遍）触发 viewport 协商。

### P24 终端渲染：光标掉窗底 + 提示符贴顶（已修，differ 路线）

**症状**：pane 里提示符在第一行，光标块却贴在窗底（VS Code 集成终端是提示符在底、光标紧跟其后）。

**根因**：mux 的屏幕 dump 尾部永远拖着视口的空行（约 23 个换行）。旧代码把整段文本原样转发，
xterm 把光标一路吃到窗底；首帧又把内容从第 1 行开始画，所以提示符贴顶。

**修复（`src/output-chunk.ts` + 两个调用点）**：

1. `trimScreenTail()`：diff / 发送 / 暂存前一律剃掉尾部空行——光标不再被推到窗底。
2. 首帧整屏重画增加"贴底内衬"：首帧按 view.rows 在内容上方补空行，提示符落在窗底
   （集成终端的首屏形态），caret 显式归位序列。
3. 134 测试全过（含新增的尾剃除与不回换行结尾断言）。

**实测（真实 runtime + WS 面板路径）**：流结尾为 `...prompt$ echo CARET_OK\nCARET_OK`，
无拖尾换行、光标钉在提示符后，echo 回显正常；ts-build + refresh 完成，store 四 exe 齐。
（ConPTY 真字节流桥保留为 `NATALIA_TERMINAL_CONPTY=1` 开关，mute 问题见 P23。）

### P25 设置面"设为默认"整条链三断（已修）

**症状**：Providers & Models 弹窗里点"设为默认"无反应（虚空接线）；且改完不刷新，要重启才生效。

**链路取证**（从 UI 按钮一路查到服务端）：

1. 服务端 `model.setDefault`（`provider-selection/selection.ts`）本身正确：RPC 直调返回 `saved:true`
   并把 `defaultModel: {provider, model}` 写进全局 config。
2. **断点 1（真凶）**：web 客户端 `runtime-rpc.ts` 的路由表有
   `setDefaultModel: "model.setDefault"`，但**客户端方法对象里根本没有这个方法** →
   `ctx.runtime.setDefaultModel?.()` 静默空转，按钮看着接线的、实际什么都没发。
   （补了与 selectModel 同款的方法。）
3. **断点 2**：`onSetDefault` 调完不 `refreshModelConfig()`——同面板的
   `onAddProvider`/`onRemoveProvider` 都刷，就它没刷 → 点了不立即生效，
   要重启。
4. **断点 3（数据源错）**：模型行"默认"标签读的是 `props.selection?.modelID`
   （会话当前选择，跟着每次选模型变），应读 config 的 `defaultModel`
   （持久默认、开机解析的那个）。

**修复**：`runtime-rpc.ts` 补 `setDefaultModel` 方法；`app-neu.tsx` 的
`onSetDefault` 写完 await `refreshModelConfig()` 再返回；`model-panel.tsx` 的
默认标签改读 `config.defaultModel`。

**验证**：web bundle 内 `setDefaultModel(E)` 方法、`onSetDefault` 的
`await Pe()`（刷新）、`defaultModel.provider` 均在位；typecheck 0；
用户截图确认默认标签已正确显示在 config 默认模型上。web dist/插件 bundle 已重编。

### P26 启动器进程树：Job Object + 优雅三级关闭（已实现）

**问题**：关窗口/Ctrl+C/杀父进程后，CEF 的 renderers/GPU、终端的 wezterm/mux-server、
两个 bun server 会遗留占端口和数百 MB——每次都要手动猜进程杀。

**机制**（`run-cef-desktop.ps1`）：

1. **Job Object（父进程即 owner）**：`CreateJobObjectW` + `JOB_OBJECT_LIMIT_KILL_ON_JOB_CLOSE`，
   launcher 是所有子进程（runtime/web/CEF 窗口）的父；**launcher 以任何方式退出**
   （关窗、Ctrl+C、脚本错误、甚至父进程被硬杀），OS 关 Job 句柄时整棵树一起消失——
   这就是普通软件的"父进程没了子进程全没"。
2. **CEF 窗口加入 Job**：renderers/GPU 是 browser 进程的 detached 子进程，杀浏览器
   不带它们；入 Job 后整棵树跟着 Job 走。
3. **finally 三级关闭**（正常退出路径）：先 `taskkill /T` 礼貌停两个 bun（给 wezterm
   pane 和 object-store daemon 2 秒刷状态）→ 2 秒后 `/T /F` 强制 → `[NataliaJob]::Close`
   兜底整树 → 镜像名兜底扫四个（CEF/wezterm），防 Job 关闭瞬间新 spawn 的漏网。
4. **Ctrl+C 可达**：web 窗口用轮询式 WaitForExit(500) 而非阻塞 .NET 调用，
   PowerShell 能 Ctrl+C → finally → 上面全链路。

**实测**：启动 → 7 个 CEF 进程 + 2 bun；停父进程 → **cef=0 bun=0 wezterm=0 listeners=0**。
（注：VS Code 终端里运行的父进程若已在别的 Job 中，assign 可能被拒——finally 显式
taskkill 是兜底路径；本机 shell 直跑 Job 生效。）

### P27 provider 配置缺 `protocol.format`：写入路径不声明，每次启动靠猜（已修）

**现象**：runtime 启动时刷屏：
`[providers] endpoint "openai-compatible" declares no protocol.format;
inferring "openai-chat" from its driver. Declare it so the adapter is chosen
by declaration rather than by a name guess: "protocol": { "format": "openai-chat" }`

**根因**：`provider-selection/selection.ts` 的 `providerAdd`（设置面写 provider
的落点）写 config 时不带 `protocol` 字段——`resolveEndpointProtocol`
（`provider-adapters.ts`）对每次没有声明的端点做一次 name-guess 并告警。
功能不坏（推断 openai-chat 是对的），但这是**配置生成缺陷**：每台新机器、
每个新 provider 都要吃一遍告警，且声明驱动的原则被破坏（`"claude-via-openrouter"`
这类名字会猜错）。

**修复**：

1. `providerAdd` 写入时声明格式：`protocol.format = current.protocol.format
?? providerFormatFromDriver(input.type)`（复用运行时的同一词表，
   老条目保留自己的声明）。
2. 用户现有 `.natalia/global-config.json` 的 step-plan 补 `protocol: {format: "openai-chat"}`。

**验证**：runtime 重启无告警输出；`runtime.status` 仍为
`model: step-5-preview / provider: openai-compatible`；typecheck 0、
ts-build/refresh 完成。

### P28 提交链路端到端复核 —— 结论已撤回、重写（superseded by P30）

**本条早期结论是错误的，保留痕迹以备查。**

~~原结论~~：链路是通的；"发不出去"源于审批门。
~~撤回原因~~：审批门发生在**发送成功之后**，把它当作"发不出去"的原因是时序倒置。
~~漏掉的证据~~：事件流第二段 `tool_call → content.partial` 之后紧接
`turn.finished(stopReason: "error")`，且之前有一轮 400 被 `step.retry`
按 connection 分类反复重试——我当时把这一串读成了"网络抖动后成功"。

**真实过程**（详见 P30）：

1. 第一轮 `plan_doc_write` 内存配对完整，`{"written":true}` 成功
2. 该 tool_call 落库为投影事件 `navi.chat.tool.used`，**只保存了展示摘要**
3. 第二轮 `naviChatHistory()` 从事件重建历史，`assistant.toolCalls` 字段缺失
4. 请求体出现"tool 结果没有配对 assistant tool_calls"，网关 400
5. `providerErrorFromHttp` 对 4xx 无重试/无回灌，turn 直接 error

**影响面**：navi / nia 对话通道。**natalia 主 agent 不受影响**
（其请求体由内存 ledger 实时构造，不经过 chat 投影重建）。

### P30 navi/nia 历史重建丢失 assistant.toolCalls（已定位）

**症状**：对话第一轮工具调用成功（`{"written":true}`），第二轮必炸
`tool_calls.id and tool_calls.type are required`（网关 400），turn 秒
`stopReason: "error"`；模型 reasoning 里出现"上一把调用格式崩了"的幻觉归因。

**链路定位**（4 步断点）：

1. **内存侧是完整的**：`chat-turn-navi.ts:549-562` 推 assistant 消息时带
   `toolCalls: calls`，紧接 625-630 的 tool 结果带 `toolCallID: call.id`。第一轮
   请求体配对无损，所以第一轮成功。
2. **持久化丢字段**：tool_call 落库为 `navi.chat.tool.used` 事件
   （`chat-turn-navi.ts:610-623`），载荷只有 `toolName/status/summary/result/
argumentsRaw`——**没有 id、没有 assistant 消息侧的 toolCalls 结构**。
3. **投影不还原**：`projectChatStream`（`packages/framework/session/src/
projector.ts`）把 `chat.tool.used` 投影成 `kind:"tool"` 的**展示行**；
   `chat.message.new` 结算事件只带 `role + text`。`naviChatHistory()`
   （`chat-turn-common.ts:264-277`）把它映射成 ProviderMessage 时**只取
   role + content**，`toolCalls` 无处可来。
4. **第二轮请求体畸形**：history 里出现"有 tool 结果、无配对 assistant
   tool_calls"的消息序列；网关按 OpenAI 规范校验拒收。

**影响面**：`naviChatHistory` / `niaChatHistory` 两条对话通道。
**主 agent（natalia）不受影响**：其请求体由 `framework-turn-orchestration` +
`provider-runner` 从**内存 ledger** 实时构造（`provider-runner.ts:875-887`
的 `result.calls` 直接进 contentParts），不经过 chat 事件投影重建。

**为何 Linux 无感**：Linux 侧 CI 的对话回归脚本不走"同一 session 内连续
两轮带 tool_call"的路径；且即使触发，stepfun 网关侧 400 只表现为 turn 失败，
不影响 CI 断言。

**修复方向**（未实施，待确认）：

- 方案 A（最小）：`chat.tool.used` 事件补 `toolCallID` 载荷；投影层在
  `kind:"tool"` 行邻接的 assistant 结算消息上还原 `toolCalls`
  （需要 assistant 消息记录自己带了哪些 call）。
- 方案 B（彻底）：`chat.message.new` 结算事件 schema 增加 `toolCalls`，
  投影层直接透传。
- 方案 C（规避）：对话侧禁用多轮 tool_call 序列——不可取，损失能力。

**附带缺陷（同链）**：4xx 走 `providerErrorFromHttp` → 无重试、不回灌错误
给模型，用户侧只看到 `Chat could not finish this turn`。建议对
`tool_calls.*` 类 400 走一次"错误信息回灌 + 重试"，与 connection 重试并列。
