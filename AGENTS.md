# AGENTS.md

[中文](#中文) | [English](#english)

<a id="english"></a>

## English

Rules for AI agents working in this repository.
[CONTRIBUTING.md](CONTRIBUTING.md) states the engineering standards; this
file is the agent-specific overlay. Where they overlap, CONTRIBUTING.md is
the reference.

### 1. Evidence before claims

- If a claim can be checked by a command, run the command and quote its
  output. "Should work now" is not a report.
- An API returning success is not verification. Read the result back. Three
  Win32 calls once returned `true` while the shipped icon was still wrong.

### 2. No blame-shifting

- If a test fails and the handoff, the issue, or the commit history does not
  record that failure, you caused it. Fix it. "Pre-existing" is not an
  answer unless something in the repository says so.

### 3. Read the whole file

- Read files completely. Do not grep-skim. A conclusion drawn from one
  matching line has been wrong here more than once.

### 4. Both platforms

- Never make the project Windows-only or Linux-only. Every fix leaves the
  other platform no worse than before, and a platform-specific failure found
  along the way is fixed in the same change.
- Platform branches are runtime checks, never baked-in choices.

### 5. Process and port safety

- The user may have a natalia instance running (ports 8790 and 8791).
- Before starting `natalia.exe` for debugging, check the ports
  (`Get-NetTCPConnection -LocalPort 8790 -State Listen`) and the process
  list. Start only when nothing is running, and clean up when you finish.
- Never start a second instance while one is running: it takes the ports and
  the user's window goes blank.

### 6. UI honesty

- No fake data. A default may exist, but it must be a real schema default
  (`packages/core/contracts/src/schema-foundation.ts`), not a placeholder
  that reads like a value. User changes always win.
- Do not advertise a control that does not exist.

### 7. Environment

- Bun is exactly 1.4.0. Check `bun --version` before trusting a test run.
- `npm install` does not work in this repository (`workspace:` protocol).
  Use `bun install` with `BUN_INSTALL` and `BUN_TMPDIR` pointed inside the
  workspace scratch directory, or it fails with EPERM.
- POSIX `VAR=value cmd` prefixes do not work in PowerShell. Set `$env:VAR`.
- pwsh 7 is not on the npm PATH. Use its absolute path.
- Python with Pillow: `D:\Software_Development\miniconda3\python.exe`.
  There is no dotnet SDK.
- A sandbox denial is reported, not worked around.

### 8. Test strategy

- While iterating, run only the layers your change touches:
  `bun test <package>/test`, or the directories of the CI matrix layer.
- The full suite takes about nine minutes. Do not rerun it to "check". One
  full `npm run verify` before claiming done, and quote the parts that
  matter.
- `guard:test-workspaces` checks the property statically (every file importing
  `plugin-test-helpers` must call `useWorkspaceCleanup()`) and reclaims the
  workspaces teardown could not unlink on Windows. A green suite stays green;
  a forgotten call is still red.

### 9. History

- Do not rewrite history, amend published commits, or force-push unless the
  user explicitly asks. When asked, use `--force-with-lease` and report
  exactly which commits were rewritten.

### 10. Generated files

Never hand-edit: the docs references (`docs:check` fails when stale),
`THIRD_PARTY_LICENSES.txt` (regenerate after dependency changes), and
`assets/icons/*` plus `apps/cef-desktop/src/app_icon_png.h` (icon build
script).

### 11. Language

- Code, comments, commit messages, and technical documentation: English.
- User-facing UI strings: Chinese.
- Conversation with the user: Chinese.

<a id="chinese"></a>

## 中文

AI agent 在本仓库工作的规则。[CONTRIBUTING.md](CONTRIBUTING.md) 是工程标准，
本文件是 agent 专用的补充层。冲突时以 CONTRIBUTING.md 为准。

### 1. 先证据，后结论

- 能被命令检查的结论，就跑那条命令并引用输出。"应该好了" 不是报告。
- API 返回成功不等于验证过，要把结果读回来。三个 Win32 API 曾经全部返回
  `true`，而发布出去的图标仍然是错的。

### 2. 不甩锅

- 测试失败时，如果交接文档、issue 或提交历史里没有记录这个失败，那就是你造成的。
  去修。「既有问题」不是答案，除非仓库里有东西这么写。

### 3. 读全文

- 文件要完整读，不 grep-skim。靠一条匹配行下的结论，在这里错过不止一次。

### 4. 两个平台

- 不准把项目变成 Windows-only 或 Linux-only。每个修复都不让另一个平台比之前更糟，
  路上发现的平台专属失败在同一个改动里修掉。
- 平台分支是运行时判断，永不烘焙进文件。

### 5. 进程与端口安全

- 用户这边可能有一个在跑的 natalia 实例（端口 8790 和 8791）。
- 调试需要启动 `natalia.exe` 前，先查端口
  （`Get-NetTCPConnection -LocalPort 8790 -State Listen`）和进程列表。确认没有
  在跑的实例才启动，调试完自己清理。
- 绝不在一实例运行时启动第二个：它会抢占端口，用户的界面会全空。

### 6. UI 诚实

- 不准有假数据。可以有默认值，但必须是 schema 里的真实默认值
  （`packages/core/contracts/src/schema-foundation.ts`），不是装成值的占位符。
  用户改过的一律按用户的来。
- 不准宣传不存在的控件。

### 7. 环境

- Bun 必须恰好是 1.4.0。信任一次测试运行前先查 `bun --version`。
- 本仓库 `npm install` 不可用（`workspace:` 协议）。用 `bun install`，并把
  `BUN_INSTALL` 和 `BUN_TMPDIR` 指到工作区 scratch 目录内，否则报 EPERM。
- POSIX 的 `VAR=value cmd` 前缀在 PowerShell 里无效，用 `$env:VAR`。
- pwsh 7 不在 npm 的 PATH 里，用绝对路径。
- 带 Pillow 的 Python：`D:\Software_Development\miniconda3\python.exe`。
  没有 dotnet SDK。
- sandbox 拒绝就是拒绝，上报，不绕。

### 8. 测试策略

- 迭代期间只跑与改动相关的层：`bun test <package>/test`，或 CI matrix 对应层的
  目录。
- 全量套件约 9 分钟。不要为了「检查一下」反复跑全量。收尾跑一次 `npm run verify`，
  并引用其中关键部分的输出。
- `guard:test-workspaces` 静态检查这条性质（每个 import 了 `plugin-test-helpers`
  的文件必须调用 `useWorkspaceCleanup()`），并回收 Windows 上 teardown 删不掉的
  目录。绿套件保持绿；漏了 hook 仍然红。

### 9. 历史

- 用户没有明确要求，不准重写历史、修改已发布的 commit、force-push。被要求时用
  `--force-with-lease`，并报告清楚重写了哪些 commit。

### 10. 生成文件

禁止手改：文档参考（过期时 `docs:check` 会失败）、`THIRD_PARTY_LICENSES.txt`
（依赖变动后重新生成）、`assets/icons/*` 与
`apps/cef-desktop/src/app_icon_png.h`（图标构建脚本生成）。

### 11. 语言

- 代码、注释、commit 信息、技术文档：英文。
- 面向用户的 UI 文案：中文。
- 与用户的交流：中文。
