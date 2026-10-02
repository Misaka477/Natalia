# Natalia Browser Plugin

[中文](#中文) | [English](#english)

<a id="english"></a>

## English

`@natalia/plugin-browser` provides full browser control through a local bridge server and a browser extension that connects the user's existing Chrome / Edge / Firefox.

The plugin contains:

- `src/server.ts`: local bridge server, listening on `127.0.0.1:18765` by default
- `src/extension/chromium/`: Chrome / Edge extension
- `src/extension/firefox/`: Firefox extension
- `scripts/install.ts`: automatic install/launch helper

## Installing the browser extension

### Option 1: automatic install helper

From the repository root:

```bash
bun packages/plugins/browser/scripts/install.ts
```

Or from the plugin directory:

```bash
cd packages/plugins/browser
bun run install-extension
```

The helper will:

1. Start the local bridge server.
2. Detect a Chromium browser (Chrome / Edge / Brave / Opera / Vivaldi / Arc).
3. If the browser is not running, launch it with `--load-extension`.
4. If the browser is already running, open the extensions page and print the folder to load manually.

### Option 2: manual install

#### Chrome / Edge

1. Open the extensions page:
   - Chrome: `chrome://extensions`
   - Edge: `edge://extensions`
2. Enable **Developer mode**.
3. Click **Load unpacked**.
4. Select:

```text
packages/plugins/browser/src/extension/chromium
```

#### Firefox

1. Open:

```text
about:debugging#/runtime/this-firefox
```

2. Click **Load Temporary Add-on**.
3. Select:

```text
packages/plugins/browser/src/extension/firefox/manifest.json
```

> A temporary Firefox add-on must be reloaded after the browser restarts.

## Starting the local bridge server

Usually you do not need to start it manually: the plugin starts the bridge server automatically on the first `browser_*` tool call.

If you need to start it manually to check connectivity:

```bash
bun packages/plugins/browser/src/server.ts
```

## Verifying extension connection

After loading the extension, it automatically connects to:

```text
ws://127.0.0.1:18765
```

The extension reconnects every second if the connection is lost.

After the server is running, check its status:

```bash
curl http://127.0.0.1:18765/healthz
```

A successful connection looks like:

```json
{ "ok": true, "extensions": 1 }
```

If `extensions` is `0`, the extension is not connected yet; verify that the extension is loaded and the local bridge server is running.

<a id="chinese"></a>

## 中文

`@natalia/plugin-browser` 提供完整的浏览器控制能力，通过本地 bridge server 和浏览器扩展连接用户现有的 Chrome / Edge / Firefox。

插件中包含：

- `src/server.ts`：本地 bridge server，默认监听 `127.0.0.1:18765`
- `src/extension/chromium/`：Chrome / Edge 扩展
- `src/extension/firefox/`：Firefox 扩展
- `scripts/install.ts`：自动安装/启动辅助脚本

## 安装浏览器扩展

### 方式一：自动安装辅助脚本

在仓库根目录执行：

```bash
bun packages/plugins/browser/scripts/install.ts
```

或者在浏览器插件目录执行：

```bash
cd packages/plugins/browser
bun run install-extension
```

脚本会：

1. 启动本地 bridge server
2. 检测 Chromium 系浏览器（Chrome / Edge / Brave / Opera / Vivaldi / Arc）
3. 浏览器未运行时，用 `--load-extension` 自动加载扩展
4. 浏览器已运行时，打开扩展管理页并提示手动加载目录

### 方式二：手动安装

#### Chrome / Edge

1. 打开扩展管理页：
   - Chrome：`chrome://extensions`
   - Edge：`edge://extensions`
2. 打开「开发者模式」
3. 点击「加载已解压的扩展程序」
4. 选择目录：

```text
packages/plugins/browser/src/extension/chromium
```

#### Firefox

1. 打开：

```text
about:debugging#/runtime/this-firefox
```

2. 点击「临时载入附加组件」
3. 选择文件：

```text
packages/plugins/browser/src/extension/firefox/manifest.json
```

> Firefox 临时加载的扩展在浏览器重启后需要重新加载。

## 启动本地 bridge server

通常不需要手动启动：第一次调用 `browser_*` 工具时，插件会自动启动 bridge server。

如果需要手动启动以便提前确认扩展连接：

```bash
bun packages/plugins/browser/src/server.ts
```

## 验证扩展是否已连接

扩展加载后会自动连接：

```text
ws://127.0.0.1:18765
```

扩展断线后每秒自动重连。

服务启动后可以检查连接状态：

```bash
curl http://127.0.0.1:18765/healthz
```

看到类似输出即表示连接成功：

```json
{ "ok": true, "extensions": 1 }
```

如果 `extensions` 为 `0`，说明扩展还没有连接；请确认扩展已经加载，并且本地 bridge server 正在运行。
