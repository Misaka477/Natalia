# Iterate Tools

[中文](#中文) | [English](#english)

<a id="english"></a>

## English

Self-iteration: the two ends of the loop.

| Tool                      | What it does                                                                                                                                                                                                                                          |
| ------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iterate_branch`          | Copies this product's read-only source baseline to a path the model chooses, opens a workspace there, and starts a NEW session carrying the current session's context, permission and goal — which begins working on the given prompt immediately.    |
| `propose_code_generation` | (registered by the framework, beside `propose_generation`) Proposes a staged-build generation from a built tree: the build artifacts AND the source state, so the swap lands the binary and the next iteration copies the baseline this one produced. |

### The loop

```
模型判断要自迭代
  → ask_user（点名目标路径 + 继承的权限 + goal 去向）
  → iterate_branch(path, prompt)          ← 本插件
       ├─ 拒绝：path 是 baseline / 在 baseline 内 / 非空且未 resume
       ├─ 拷贝 baseline（剔 node_modules 与构建产物）
       ├─ addWorkspace(path)              ← manager 持全部 runtime，故由它注入
       ├─ sessionSeed(父会话事件)           ← 跨库播种，目标库重新排序
       ├─ 权限显式继承（不读目标工作区设置）
       └─ goal：seed(子) → arm(子) → complete(父, handed_off)
  → 子会话：改代码 → 构建 → 测试（现有工具，无新增）
  → 并行多方向：team_fanout / team_review（三方合并，不相交都落）
  → propose_code_generation(buildDir, version)
  → apply_generation(candidateID)
       四 face 门 → 审批 → 全 workspace drain → 换版 → 探版本
       → baseline 原子更新 → Windows self-replace（spawn 新二进制后退出）
```

### What it is NOT

Not a general "fork to another tree" primitive. The semantics are
load-bearing for self-iteration — the goal moves and is armed, the
permission travels, the baseline is never written by the model — and a
general tool would let a session reach for them where they were never
designed. For work in another project, use `sandbox_create` in the
current workspace.

### Platform

The handoff needs the workspace manager, so it exists where a served
runtime does (the Natalia Desktop app or `natalia serve`). Everywhere
else the tool loads and refuses with the reason. The baseline is
`<install>/source` when the install ships it, otherwise the repository
root the workspace sits in.

<a id="chinese"></a>

## 中文

自迭代：闭环的两端。

| 工具                      | 作用                                                                                                                                                      |
| ------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `iterate_branch`          | 把本产品只读的源码基线拷贝到模型指定的路径，在该处开工作区，并启动一个**新会话**——带着当前会话的上下文、权限和 goal，按给定 prompt 立即开工。             |
| `propose_code_generation` | （由框架注册，与 `propose_generation` 同层）从构建产物提议 staged-build generation：**构建产物 + 源码状态**双载荷，换版落二进制、下一轮拷本轮产出的基线。 |

### 闭环

```
模型判断要自迭代
  → ask_user（点名目标路径 + 继承权限 + goal 去向）
  → iterate_branch(path, prompt)          ← 本插件
       ├─ 拒绝：path 是 baseline / 在 baseline 内 / 非空且未 resume
       ├─ 拷贝 baseline（剔 node_modules 与构建产物）
       ├─ addWorkspace(path)              ← manager 持全部 runtime，故由它注入
       ├─ sessionSeed(父会话事件)           ← 跨库播种，目标库重新排序
       ├─ 权限显式继承（不读目标工作区设置）
       └─ goal：seed(子) → arm(子) → complete(父, handed_off)
  → 子会话：改代码 → 构建 → 测试（现有工具，无新增）
  → 并行多方向：team_fanout / team_review（三方合并，不相交都落）
  → propose_code_generation(buildDir, version)
  → apply_generation(candidateID)
       四 face 门 → 审批 → 全 workspace drain → 换版 → 探版本
       → baseline 原子更新 → Windows self-replace（spawn 新二进制后退出）
```

### 它不是什么

不是通用的「fork 到另一棵树」原语。它的语义是为自迭代设计的负重件——
goal 强制移交并自动武装、权限随活走、baseline 永不被模型直接写——
做成通用的，模型就能在从没设计过的场景伸手。要去别人的项目干活，用当前
工作区的 `sandbox_create`。

### 平台

交接需要 workspace manager，所以它存在于有 served runtime 的地方
（Natalia 桌面版或 `natalia serve`）；别处插件照常加载并给出理由拒绝。
baseline 优先取 `<install>/source`，否则取工作区所在的仓库根。
