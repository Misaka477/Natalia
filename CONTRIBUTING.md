# Contributing to Natalia

[中文](#中文) | [English](#english)

<a id="english"></a>

## English

`npm run verify` is the definition of "this change is done". CI runs exactly
that command, so a green local run and a green CI run mean the same thing.

```sh
bun install
npm run verify      # format, typecheck, tests, docs check, guards
```

Each rule below states a standard and how it is checked. A rule is here
because breaking it shipped something that should not have.

## Standards

### 1. Commit messages

Every commit message is in English and follows this shape:

```
type(scope): imperative summary

Body wrapped at 72 columns: what changed and why.

Test: <command> -> <result>
```

- The summary is imperative, at most 50 characters after the prefix, with no
  trailing period, no em-dash asides, and no colloquial clauses.
- The body explains what and why. The diff already shows how, so do not
  narrate it. Never paste session history, chat quotes, or the record of
  approaches that were tried and abandoned; only what is true of the final
  state belongs here.
- The `Test:` footer names the gate that ran and what it printed. "Test:
  sandbox 112/112" is a claim with a number behind it; "Test: looks good" is
  not.
- `Fixes:` or `Refs:` carries a real issue number. Never invent one.
- Allowed types: `feat`, `fix`, `docs`, `refactor`, `test`, `build`,
  `ci`, `chore`.

Good:

```
fix(build): write exe version info with bun's native flags

bun build --compile produces a copy of the bun binary, so all eight
VERSIONINFO fields said bun and users saw "this program is made by Bun"
in the file properties. The five text flags bun 1.4.0 supports all work,
so the text fields go through them; the icon keeps the Win32
UpdateResource stamp.

Test: FileVersionInfo reads back company Misaka477, product Natalia,
version 0.0.0.13; scripts suite 46/0.
```

Not acceptable:

```
fix(build): the icon is real this time -- multi-size write + verify

User 2026-10-14: "still not fixed". Round four. The first three rounds
I only wrote, never read back, and three Win32 APIs returned true so I
called it done...
```

### 2. Commit often, one change at a time

- Commit when a change is done and verified, not when the session ends.
- One logical change per commit. A commit that fixes a bug and adds a
  feature cannot be reviewed, reverted, or bisected.

Checked by: review.

### 3. No stubs

- A field, enum member, event type, or capability that nothing produces is
  worse than absent: it tells every later reader that a path exists. Wire
  it, remove it, or add it to the contract-producer guard's `ALLOWED` map
  with the reason it stays.

Checked by: `npm run guard:contract`.

### 4. Fix what you find

- Fix pre-existing breakage you meet, or record it as debt with a reason. A
  gate that always fails catches nothing, and the same investigation gets
  done twice.

Checked by: every gate in `npm run verify`.

### 5. Verify with the repo's gate, over the whole tree

- Run `npm run verify`, not a subset you picked and not a command you
  assembled. A test that is not in the root `test` script does not run: add
  a new package's test directory to the root script.
- Use the root script's concurrency. Bare full-concurrency runs produce
  timeouts that are load, not logic, and they change between runs.

Checked by: CI runs the same command.

### 6. Watch each test fail

- Write the assertion, break the thing it is about, confirm it goes red,
  then restore the fix. A test you have only ever seen pass may be
  exercising the wrong path or asserting something trivially true.

Checked by: review; a fix whose test was never seen red is not done.

### 7. Assert outcomes, not the absence of failure

- `expect(answer).not.toContain("refused")` cannot tell "the gate allowed
  this" from "something else refused it first". Assert the thing you mean:
  that the goal is complete, that the file is gone, that the second
  promotion was refused and the first candidate's work is still there.

Checked by: review.

### 8. Completion claims cite gates

- If a claim can be checked by a command, run the command and quote it. A
  checklist you wrote and updated is your own answer key, not evidence.
  Where a contract declares a field, the test that proves it belongs on the
  producer, not only on the consumer.

Checked by: review; the report must quote command output.

### 9. Both platforms, every change

- The product ships on Windows and Linux. A fix that helps one by breaking
  the other is not a fix.
- Platform branches are runtime checks (`process.platform === "win32"`),
  never choices baked into a file at write time.
- A change may not make the other platform worse. A platform-specific
  failure found along the way is fixed in the same change.
- A test that only means something on one platform is gated with
  `test.skipIf`, and the gate carries the reason in a comment.

Checked by: CI runs both `ubuntu-latest` and `windows-latest`.

### 10. Documentation is bilingual in one file

- English and Chinese live in the same file: the English section first, an
  anchor link at the top, then the Chinese section.
- Changing one language without the other is a review failure, the same as
  a format violation.
- Generated references (`docs/api-reference.md`, `docs/types-reference.md`,
  `docs/config-reference.md` and their `.zh-CN` siblings) stay as their
  generator emits them until the generator changes.

Checked by: review.

### 11. Leave no clutter

- If a change makes something dead, delete it in the same commit. Nothing
  you touched should be less tidy than you found it.

Checked by: review; `npm run guard:orphans` catches modules with no caller.

## Generated files

Never hand-edit these; regenerate them:

- `docs/api-reference.md`, `docs/types-reference.md`,
  `docs/config-reference.md` and their `.zh-CN` siblings. `docs:check`
  fails when they are stale and prints the regeneration command.
- `THIRD_PARTY_LICENSES.txt`. After any dependency change, run
  `bun scripts/generate-third-party-licenses.ts`.
- `assets/icons/*` and `apps/cef-desktop/src/app_icon_png.h`. Regenerate
  with the icon build script.

## Agents

See [AGENTS.md](AGENTS.md) for the agent-specific overlay: environment
facts, test strategy, process and port safety, history rules, and language
rules.

<a id="chinese"></a>

## 中文

`npm run verify` 即「这个改动做完了」的定义。CI 跑的就是这一条命令，因此本地全绿和
CI 全绿是同一件事。

```sh
bun install
npm run verify      # format、typecheck、测试、文档检查、各守卫
```

下面每条标准都写明规则和检查方式。每条都在这里，是因为违反它曾经把不该发布的东西
发布了出去。

## 标准

### 1. Commit 信息

每条 commit 信息用英文，形状如下：

```
type(scope): 祈使句摘要

72 列换行的正文：改了什么、为什么。

Test: <命令> -> <结果>
```

- 摘要用祈使句，前缀之后不超过 50 字符，无句末标点，无破折号闲聊，无口语化从句。
- 正文写 what 和 why。diff 本身已经展示了 how，不要复述；永不粘贴 session 历史、
  聊天记录或被放弃方案的過程，只写对最终状态成立的事实。
- `Test:` footer 写明跑了哪条门禁、输出是什么。"Test: sandbox 112/112" 是有数字
  背书的结论；"Test: looks good" 不是。
- `Fixes:` 或 `Refs:` 只写真实 issue 号，不编造。
- 允许的类型：`feat`、`fix`、`docs`、`refactor`、`test`、`build`、
  `ci`、`chore`。

合格示例：

```
fix(build): write exe version info with bun's native flags

bun build --compile 产出的是 bun 二进制副本，8 个 VERSIONINFO 字段全是
bun 的，用户在文件属性里看到「这程序是 Bun 做的」。bun 1.4.0 原生支持
的五个文本 flag 全部有效，文本字段改走原生 flag；图标保留 Win32
UpdateResource stamp。

Test: FileVersionInfo 读回公司 Misaka477、产品 Natalia、版本 0.0.0.13；
scripts 套件 46/0。
```

不合格示例：

```
fix(build): the icon is real this time -- multi-size write + verify

用户 2026-10-14：「还是没修好」。第四轮。前三轮我只写不读回，三个
Win32 API 都返回 true 我就当修好了……
```

### 2. 频繁提交，一次只做一件事

- 一个改动做完并验证后立刻提交，不要等到 session 结束。
- 一个 commit 只做一个逻辑变更。又修 bug 又加功能的 commit 无法 review、
  无法 revert、无法 bisect。

检查方式：review。

### 3. 不留 stub

- 没有任何生产者会写入的字段、枚举成员、事件类型或能力，比不存在更糟：它告诉
  每个后来的读者这里有条路。接上它、删掉它，或者带着理由把它加进
  contract-producer guard 的 `ALLOWED` 表。

检查方式：`npm run guard:contract`。

### 4. 修你发现的

- 遇到既有损坏就修，或者带着理由记录成债务。永远红着的门禁抓不到任何东西，同一
  个调查还会做第二遍。

检查方式：`npm run verify` 里的每一道门禁。

### 5. 用仓库的门禁、全树验证

- 跑 `npm run verify`，不跑你挑的子集，不跑你拼的命令。不在根 `test` 脚本里的
  测试等于不存在：新增包的测试目录要加进根脚本。
- 使用根脚本的并发度。裸跑满并发产生的超时是负载不是逻辑，且每次结果都不同。

检查方式：CI 跑同一条命令。

### 6. 每个测试都要看它红

- 先写断言，再弄坏它断言的东西，确认变红，然后恢复修复。只见过它通过的测试，可能
  跑的是错的路径，或在断言一个恒真的东西。

检查方式：review；修复的测试没被看到红过，就不算完成。

### 7. 断言结果，不断言「没报错」

- `expect(answer).not.toContain("refused")` 分不清「门禁放行了」和「别的东西先
  拒绝了」。断言你真正想说的：目标完成了、文件没了、第二次晋升被拒且第一次候选的
  成果还在。

检查方式：review。

### 8. 完成声明引用门禁

- 能被命令检查的结论，就跑那条命令并引用它的输出。你自己写自己更新的清单是你的
  答案键，不是证据。契约声明了字段，证明它的测试要挂在生产者上，不能只挂在消费者。

检查方式：review；报告必须引用命令输出。

### 9. 每个改动都顾两个平台

- 产品同时发布在 Windows 和 Linux。以弄坏另一边为代价的修复不是修复。
- 平台分支是运行时判断（`process.platform === "win32"`，永不把平台选择在写入
  时烘焙进文件。
- 一个改动不许让另一个平台比之前更糟。路上发现的平台专属失败，在同一个改动里修掉。
- 只在一个平台上有意义的测试用 `test.skipIf` 门住，并在注释里写明原因。

检查方式：CI 同时跑 `ubuntu-latest` 和 `windows-latest`。

### 10. 文档中英双语合在一个文件

- 英文和中文在同一个文件里：英文段在前，顶部放锚点链接，中文段在后。
- 只改一边语言不改另一边，与格式违规同罪。
- 生成出来的参考文档（`docs/api-reference.md`、`docs/types-reference.md`、
  `docs/config-reference.md` 及其 `.zh-CN` 兄弟）在生成器支持之前，保持生成器
  的输出形态。

检查方式：review。

### 11. 不留杂物

- 一个改动让什么东西死了，就在同一个 commit 里删掉它。你碰过的东西不应该比你发现
  它时更乱。

检查方式：review；`npm run guard:orphans` 抓没有调用者的模块。

## 生成文件

以下文件禁止手改，只能重新生成：

- `docs/api-reference.md`、`docs/types-reference.md`、
  `docs/config-reference.md` 及其 `.zh-CN` 兄弟。过期时 `docs:check` 会失败并
  打印重新生成的命令。
- `THIRD_PARTY_LICENSES.txt`。任何依赖变动后，运行
  `bun scripts/generate-third-party-licenses.ts`。
- `assets/icons/*` 和 `apps/cef-desktop/src/app_icon_png.h`。用图标构建脚本
  重新生成。

## Agent

AI agent 的专用规则见 [AGENTS.md](AGENTS.md)：环境事实、测试策略、进程与端口安全、
历史规则、语言规则。
