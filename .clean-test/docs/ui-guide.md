# Natalia UI Adapter Guide — v2

[中文](#中文) | [English](#english)

<a id="english"></a>

## English

## UI adapters in depth

A UI is a normal v2 plugin using the existing `adapters` integration point.
The from-zero create/install/launch path is in [section 2](#2-from-zero-a-new-plugin-and-a-new-ui).
This section is the host contract: mount, dispose, checkpoints, and testing.

### Create an external UI package

Use the UI template. It writes `scope: "process"`,
`integrationPoints: ["adapters"]`, a unique adapter `kind`, and the
`@anthelia/contracts` dependency:

```bash
natalia-ts plugin create ./my-ui --id yourco.web --package @yourco/natalia-ui-web --template ui
```

The published package needs `@anthelia/plugin` to register the adapter
and `@anthelia/contracts` when it imports `RuntimeClient`, `RuntimeEvent`,
or other public types:

```json
{
  "name": "@yourco/natalia-ui-web",
  "version": "1.0.0",
  "type": "module",
  "files": ["src", "natalia.plugin.json"],
  "exports": { ".": "./src/index.js" },
  "dependencies": {
    "@anthelia/plugin": "<compatible-version>",
    "@anthelia/contracts": "<compatible-version>"
  }
}
```

Do not copy the `workspace:*` dependency versions or `.ts` entry from
`packages/examples/ui-plugin`; that package is a repository fixture. External
packages must publish an importable `.js` or `.mjs` entry and declare real
release-compatible dependency versions.

### Mount and dispose

The UI plugin itself is small. Registration is inert: `mount` runs only after a
UI host selects the adapter kind, and `dispose` must release every listener,
timer, renderer, socket, or other resource created by `mount`.

```js
import { definePlugin } from "@anthelia/plugin";

export default definePlugin({
  manifest: {
    apiVersion: 2,
    id: "yourco.ui.web",
    version: "1.0.0",
    name: "Web UI",
    description: "Example UI adapter.",
    entry: "src/index.js",
    scope: "process",
    provides: [],
    requires: [],
    optionalRequires: [],
    conflicts: [],
    dependencies: [],
    hooks: {},
    integrationPoints: ["adapters"],
  },
  setup(api) {
    let unsubscribe: (() => void) | undefined;
    api.adapters.registerUi({
      kind: "ui.web",
      async mount(input) {
        const commands = await input.commands.list();
        render({ runtime: input.runtime, commands });
        unsubscribe = input.events.subscribe((event) => update(event));
      },
      dispose() {
        unsubscribe?.();
        unmount();
      },
    });
  },
});
```

The host injects three public ports:

| Port                                  | Use                                                                                                                                                                                                                                          |
| ------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input.runtime`                       | The complete typed `RuntimeClient`: submit turns, query sessions and resources, call checkpoint methods, and invoke other documented runtime operations. Feature methods are optional, so show an unavailable state when a method is absent. |
| `input.events.subscribe(listener)`    | Subscribes to the shared `RuntimeEvent` stream and returns an unsubscribe function. Keep projected UI state in the adapter; do not create a second runtime or mutate framework state.                                                        |
| `input.commands.list()` / `execute()` | Lists and executes the host's authoritative command catalog. Resolve by command `name`, and pass the raw command plus parsed arguments to `execute`.                                                                                         |

The UI package does not import an internal UI host, checkpoint controller,
registry, or transport implementation. It only uses these public ports and
public `@anthelia/contracts` types. This lets a web or custom
renderer use the same runtime without sharing current UI state or components.

### Dynamic panel registration

Web shells use a separate renderer-facing panel protocol for feature
panels. A plugin package can declare `ui.entry` in its manifest; the shell
discovers it from the same `pluginCatalog` used for official and third-party
plugins and loads it through `GET /plugins/<pluginId>/ui.js`. The UI module
exports `createUiPlugin()`:

```js
import { defineUiPlugin } from "@natalia/ui-host";

export function createFeatureUiPlugin() {
  return defineUiPlugin({
    id: "yourco.ui.feature",
    panels: [
      {
        id: "feature-settings",
        title: "Feature",
        region: "settings",
        group: "扩展",
        mount(ctx, container) {
          // render the feature's settings UI
        },
      },
    ],
  });
}
```

The host then exposes the panel through `host.listPanels()` and mounts it with
`host.mountPanel()`. Disabling or uninstalling the runtime plugin removes its
panels automatically.

### Skins, layout profiles and shell layout plugins

The UI is designed so one skin file controls the entire visual identity. A skin is a
`UiSkin` object from `@natalia/ui-kit`:

```ts
export const neo = defineUiSkin({
  id: "neo",
  name: "Neo",
  tokens: {
    "--neu-bg": "#0a0a14",
    "--neu-accent": "#22d3ee",
    "--neu-text": "#e0f2fe",
  },
  layout: {
    regions: {
      left: { width: 220, visible: true },
      right: { order: ["diff", "plan", "terminal"], visible: true },
    },
  },
});
```

All component CSS, including plugin UI CSS, should reference these CSS custom
properties. Applying a skin updates the root variables and `data-theme`.

A `UiLayoutProfile` can rearrange common shell regions: left/right visibility,
width, panel order and default tab. For completely new shell structures, a UI
plugin may implement `shellLayout`; the main UI then delegates the whole root
rendering to that plugin.

### Checkpoints and message-level restore

Build restore UI around preview, never around a direct workspace mutation:

```js
async function openRestore(input, checkpointID) {
  if (!input.runtime.checkpointPreview || !input.runtime.checkpointRollback)
    return showUnavailable("Checkpoint management is unavailable.");

  const preview = await input.runtime.checkpointPreview(checkpointID);
  renderRollbackPreview(
    preview.changes,
    preview.context,
    preview.resources,
    preview.warnings,
  );

  // An optional dry run returns the same preview without changing the workspace.
  await input.runtime.checkpointRollback({ id: checkpointID, dryRun: true });

  if (!(await confirmRestore(preview))) return;
  const result = await input.runtime.checkpointRollback({
    id: checkpointID,
    dryRun: false,
  });
  showRestored({ safetyCheckpointID: result.safetyCheckpointID });
}
```

`checkpointList()` returns `RuntimeCheckpoint` items with `turnID`. Transcript
message IDs follow `${turnID}:user`, `${turnID}:assistant`, and related segment
forms, so a UI can derive the turn ID and filter checkpoints with
`checkpoint.turnID === turnID`. This supports a `Restore...` action on either a
user message or an assistant reply without coupling to the web UI renderer.

Show every `CheckpointPreview.changes` item with its `add`, `modify`, `delete`,
`rename`, `mode`, or `symlink` kind, plus context truncation, resource policies,
warnings, and whether `complete` is true. Do not offer a restore for an
incomplete checkpoint. A confirmed rollback creates `safetyCheckpointID` before
workspace mutation; surface it explicitly as "Restore is reversible" and allow
the user to restore that safety checkpoint later.

For a light-weight action, a small preview may use one confirmation. For broad
or destructive previews, require the user to review the changed-file list and
warnings before enabling confirmation. The runtime remains authoritative: it
refuses incomplete targets and safety checkpoints even if a UI makes a mistake.

### Test the package

Keep renderer code behind an adapter-local function and test `mount` with a
fake `RuntimeClient`. Assert that registration performs no I/O before
materialization, events update only local UI state, command execution uses the
catalog, and `dispose` stops all event listeners and renderer resources. See
`packages/examples/ui-plugin` and
`packages/plugins/ui/web/test/plugin.test.ts` for an end-to-end materialization
test.

### Launch an installed UI

A UI package is installed like any other plugin and launched by its adapter
kind — one package, two commands:

```bash
natalia-ts plugin install @yourco/natalia-ui-web
natalia-ts ui ui.web
```

`natalia-ts ui <kind>` runs the UI in-process against a real runtime;
`natalia-ts ui` without a kind lists the available UI kinds from enabled
installed and path plugins. The web shell and every installed UI share one generic host,
`createUiAdapterHost` (`@natalia/client`): it resolves the workspace config,
discovers enabled plugins, loads only adapter-capable process plugins into one
process registry, and materializes the requested kind(s) against one shared
`UiAdapterMountInput`. Closing is idempotent and fail-closed (materializer,
then registry, then runtime).

<a id="chinese"></a>

## 中文

## UI adapter 深入

UI 是使用现有 `adapters` integration point 的普通 v2 插件。
从零创建/安装/启动路径见 [第 2 节](#2-从零开始新插件和新-ui)。
本节是 host 契约：mount、dispose、checkpoint 和测试。

### 创建外部 UI package

直接使用 UI 模板。它会写入 `scope: "process"`、`integrationPoints: ["adapters"]`、
唯一 adapter `kind`，以及 `@anthelia/contracts` 依赖：

```bash
natalia-ts plugin create ./my-ui --id yourco.web --package @yourco/natalia-ui-web --template ui
```

发布包需要 `@anthelia/plugin` 注册 adapter；导入 `RuntimeClient`、`RuntimeEvent`
或其他公共类型时使用 `@anthelia/contracts`：

```json
{
  "name": "@yourco/natalia-ui-web",
  "version": "1.0.0",
  "type": "module",
  "files": ["src", "natalia.plugin.json"],
  "exports": { ".": "./src/index.js" },
  "dependencies": {
    "@anthelia/plugin": "<compatible-version>",
    "@anthelia/contracts": "<compatible-version>"
  }
}
```

不要把 `packages/examples/ui-plugin` 的 `workspace:*` 依赖版本或 `.ts` 入口照搬到
发行包；它是仓库 fixture。外部 package 必须发布可导入的 `.js` 或 `.mjs` entry，并声明
与发行版兼容的实际依赖版本。

### Mount 与 dispose

UI 插件本身很小。注册是惰性的：只有 UI host 选择对应 adapter kind 后才调用 `mount`；
`dispose` 必须释放 `mount` 创建的所有 listener、timer、renderer、socket 或其他资源。

```js
import { definePlugin } from "@anthelia/plugin";

export default definePlugin({
  manifest: {
    apiVersion: 2,
    id: "yourco.ui.web",
    version: "1.0.0",
    name: "Web UI",
    description: "Example UI adapter.",
    entry: "src/index.js",
    scope: "process",
    provides: [],
    requires: [],
    optionalRequires: [],
    conflicts: [],
    dependencies: [],
    hooks: {},
    integrationPoints: ["adapters"],
  },
  setup(api) {
    let unsubscribe: (() => void) | undefined;
    api.adapters.registerUi({
      kind: "ui.web",
      async mount(input) {
        const commands = await input.commands.list();
        render({ runtime: input.runtime, commands });
        unsubscribe = input.events.subscribe((event) => update(event));
      },
      dispose() {
        unsubscribe?.();
        unmount();
      },
    });
  },
});
```

host 注入三个公共端口：

| Port                                  | 用途                                                                                                                                                                    |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `input.runtime`                       | 完整的类型化 `RuntimeClient`：提交 turn、查询 session/resource、调用 checkpoint 方法和其他已文档化的 runtime 操作。Feature 方法是可选的，方法不存在时应展示不可用状态。 |
| `input.events.subscribe(listener)`    | 订阅共享 `RuntimeEvent` 流，并返回 unsubscribe。UI projection state 保持在 adapter 内部；不要另建 runtime 或修改 framework state。                                      |
| `input.commands.list()` / `execute()` | 列出并执行 host 的权威 command catalog。通过 command `name` 定位，向 `execute` 传入原始命令与已解析参数。                                                               |

UI package 不应导入内部 UI host、checkpoint controller、registry 或 transport 实现，只能
使用这些公共 port 与公开的 `@anthelia/contracts` type。因此 web 或自定义
renderer 都可使用同一 runtime，而不依赖当前 UI 的 state 或组件。

### 动态面板注册

Web 对功能面板使用独立的 renderer 面板协议。插件包可以在 manifest
里声明 `ui.entry`；shell 从同一份 `pluginCatalog` 发现官方/第三方插件，并通过
`GET /plugins/<pluginId>/ui.js` 加载。UI 模块导出 `createUiPlugin()`：

```js
import { defineUiPlugin } from "@natalia/ui-host";

export function createFeatureUiPlugin() {
  return defineUiPlugin({
    id: "yourco.ui.feature",
    panels: [
      {
        id: "feature-settings",
        title: "Feature",
        region: "settings",
        group: "扩展",
        mount(ctx, container) {
          // 渲染功能设置 UI
        },
      },
    ],
  });
}
```

host 通过 `host.listPanels()` 暴露面板，并通过 `host.mountPanel()` 挂载。
禁用或卸载运行时插件后，对应面板会自动移除。

### 皮肤、布局配置与 Shell 布局插件

UI 设计为“一个皮肤文件控制整套视觉”。皮肤是 `@natalia/ui-kit` 的 `UiSkin`：

```ts
export const neo = defineUiSkin({
  id: "neo",
  name: "Neo",
  tokens: {
    "--neu-bg": "#0a0a14",
    "--neu-accent": "#22d3ee",
    "--neu-text": "#e0f2fe",
  },
  layout: {
    regions: {
      left: { width: 220, visible: true },
      right: { order: ["diff", "plan", "terminal"], visible: true },
    },
  },
});
```

所有组件 CSS（包括插件 UI CSS）都应引用这些 CSS 自定义属性。应用皮肤会更新根节点变量
与 `data-theme`。

`UiLayoutProfile` 可以调整常见 Shell 区域：左右栏显隐、宽度、面板顺序、默认 tab。
若要完全自定义 Shell 结构，UI 插件可以实现 `shellLayout`，主 UI 会把整个根节点渲染
委托给该插件。

### Checkpoint 与消息级 restore

restore UI 必须围绕 preview 构建，不能直接修改 workspace：

```js
async function openRestore(input, checkpointID) {
  if (!input.runtime.checkpointPreview || !input.runtime.checkpointRollback)
    return showUnavailable("Checkpoint management is unavailable.");

  const preview = await input.runtime.checkpointPreview(checkpointID);
  renderRollbackPreview(
    preview.changes,
    preview.context,
    preview.resources,
    preview.warnings,
  );

  // 可选 dry run 返回相同 preview，不会改变 workspace。
  await input.runtime.checkpointRollback({ id: checkpointID, dryRun: true });

  if (!(await confirmRestore(preview))) return;
  const result = await input.runtime.checkpointRollback({
    id: checkpointID,
    dryRun: false,
  });
  showRestored({ safetyCheckpointID: result.safetyCheckpointID });
}
```

`checkpointList()` 返回带 `turnID` 的 `RuntimeCheckpoint`。transcript message ID 采用
`${turnID}:user`、`${turnID}:assistant` 及相关 segment 形式，因此 UI 可以解析 turn ID，
再用 `checkpoint.turnID === turnID` 过滤 checkpoint。这样能在 user message 或 assistant
reply 上提供 `Restore...`，而不耦合 web UI renderer。

展示每个 `CheckpointPreview.changes` 的 `add`、`modify`、`delete`、`rename`、`mode` 或
`symlink` 类型，并展示 context truncation、resource policy、warning 和 `complete` 状态。
不完整 checkpoint 不能提供 restore。确认 rollback 会在修改 workspace 前创建
`safetyCheckpointID`；应明确显示“Restore is reversible”，并允许用户之后恢复到该 safety
checkpoint。

小型 preview 可以只用一次确认。范围大或包含 destructive change 的 preview，应要求用户
查看 changed-file list 和 warning 后才启用确认。runtime 始终是权威边界：即使 UI 出错，它也
会拒绝不完整 target 和 safety checkpoint。

### 测试 package

将 renderer 代码放在 adapter-local function 后，并使用 fake `RuntimeClient` 测试 `mount`。
验证 registration 在 materialize 前不产生 I/O，event 只更新 UI 本地 state，command 通过
catalog 执行，`dispose` 停止所有 event listener 和 renderer resource。端到端
materialization 测试可参考 `packages/examples/ui-plugin` 与
`packages/plugins/ui/web/test/plugin.test.ts`。

### 启动已安装的 UI

UI 包与普通插件一样安装，并按 adapter kind 启动——一个包、两条命令：

```bash
natalia-ts plugin install @yourco/natalia-ui-web
natalia-ts ui ui.web
```

`natalia-ts ui <kind>` 在进程内对真实 runtime 挂载该 UI；`natalia-ts ui`（不带 kind）
列出已启用已安装/path 插件贡献的可用 UI kind。Web shell 与所有已安装 UI 共用同一个通用 host
`createUiAdapterHost`（`@natalia/client`）：解析 workspace 配置、发现已启用插件、只把
adapter-capable 的 process 插件装入一个进程 registry，并对同一个共享
`UiAdapterMountInput` materialize 请求的 kind(s)。关闭幂等且 fail-closed（先
materializer，再 registry，最后 runtime）。
