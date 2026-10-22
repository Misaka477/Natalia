# Natalia Browser Bridge (browser tools)

[中文](#中文) | [English](#english)

<a id="english"></a>

## English

Drives the user's **existing** Chrome/Edge/Firefox browser through a local
bridge. The extension keeps the user's session: cookies, logins, and tabs
are the browser's own, so nothing is re-authenticated.

```
browser_* tool → HTTP POST /browser/<action> → bridge server (port 18765)
  → WebSocket → extension → chrome.scripting / chrome.debugger
```

### Layout

| Path                                | What it is                                                                        |
| ----------------------------------- | --------------------------------------------------------------------------------- |
| `src/server.ts`                     | The bridge server: HTTP in, WebSocket out, one entry per extension connection     |
| `src/browser-bridge-lifecycle.ts`   | Starts the server on first tool call, tracks the extension connection             |
| `src/tools.ts`                      | The nine `browser_*` tools and their layered error messages                       |
| `src/extension-dir.ts`              | Where the extension lives (install vs checkout), one answer for helper and errors |
| `scripts/install.ts`                | The one-click helper: bridge up, browser found, folder named                      |
| `src/extension/chromium/`           | The Chrome/Edge extension (MV3)                                                   |
| `src/extension/firefox/`            | The Firefox extension (MV3)                                                       |
| `src/extension/shared/page-scan.js` | The page-scan script both engines inject                                          |
| `skills/browser-bridge-setup/`      | The setup/recovery SOP the skills plugin ships                                    |

### Perception (`browser_scan`)

The scan is a perception of the page, not a dump. `page-scan.js` walks the
DOM into a model, then a pure policy decides what the reader sees:

- invisible nodes (display none, zero size, opacity 0) are dropped, and the
  result reports how many;
- fully covered siblings are dropped — a dialog hides the text under it —
  unless they hold something clickable, which still works;
- interactive elements render as markers with their attributes:
  `[button "Save"]`, `[input name=q type=text "search"]`;
- long repeated lists collapse to three items plus
  `[FAKE ELEMENT] N more items hidden, selector: "li.row"`, so a 200-row
  result list costs three rows and a selector to query precisely;
- `textOnly` (default) or the simplified HTML; long URLs collapse to
  `__link__`;
- `maxlen`/`offset` page the render; `totalTextLength`/`truncated`
  describe the whole page.

The policy is pure over the model, so `test/page-scan.test.ts` drives it
with hand-built trees — every rule above has a test that fails without it.

### Actions

- `browser_click` walks the full pointer sequence (over → move → press →
  focus → release → click) and returns what it hit. A bare `click()` never
  tells a hover-opened component the pointer arrived.
- `browser_input` writes through the prototype's own value setter and fires
  `input` + `change`, which is what a framework-controlled component is
  wired to; assigning `el.value` directly tells the page nothing.
- `browser_execute_js` runs through the debugger (so CSP cannot refuse it)
  and returns the page diff, new tabs, and whether the navigation destroyed
  the context.

### Setup

The extension is loaded once by hand through `chrome://extensions`
(current Chrome/Edge no longer auto-load unpacked extensions from the
registry). The `browser-bridge-setup` skill carries the steps, the
expected error badge, and the layer-by-layer recovery path; the runtime's
error messages name the directory to load.

Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-On →
`extension/firefox/manifest.json` (temporary, so it is repeated after a
restart).

<a id="chinese"></a>

## 中文

通过本地桥接驱动用户**正在使用**的 Chrome/Edge/Firefox。扩展直接复用用户
现有浏览器会话：Cookie、登录态、标签页都是浏览器自己的，不需要重新登录。

```
browser_* 工具 → HTTP POST /browser/<action> → 桥接服务（端口 18765）
  → WebSocket → 扩展 → chrome.scripting / chrome.debugger
```

### 目录

| 路径                                | 作用                                                       |
| ----------------------------------- | ---------------------------------------------------------- |
| `src/server.ts`                     | 桥接服务：HTTP 进、WebSocket 出，每条扩展连接一项          |
| `src/browser-bridge-lifecycle.ts`   | 首次工具调用时启动服务，跟踪扩展连接状态                   |
| `src/tools.ts`                      | 九个 `browser_*` 工具及其分层错误信息                      |
| `src/extension-dir.ts`              | 扩展目录解析（安装态 / 检出态），helper 与报错共用同一答案 |
| `scripts/install.ts`                | 一键 helper：起桥接、找浏览器、给出目录                    |
| `src/extension/chromium/`           | Chrome/Edge 扩展（MV3）                                    |
| `src/extension/firefox/`            | Firefox 扩展（MV3）                                        |
| `src/extension/shared/page-scan.js` | 两个引擎共同注入的页面扫描脚本                             |
| `skills/browser-bridge-setup/`      | 随插件发行的安装/排障 SOP                                  |

### 感知（`browser_scan`）

扫描是页面的感知结果，不是原始转储。`page-scan.js` 先把 DOM 走成模型，
再由一段纯策略决定读者看到什么：

- 不可见节点（display:none、零尺寸、opacity 0）被丢弃，并报告丢弃数量；
- 被完全遮盖的兄弟节点被丢弃（弹层盖住的文字），但其中可点击的元素保留，
  因为它们仍然可操作；
- 可交互元素渲染成带属性的标记：`[button "Save"]`、
  `[input name=q type=text "search"]`；
- 长列表折叠为三条加一句
  `[FAKE ELEMENT] N more items hidden, selector: "li.row"`，200 行的结果
  列表只花三条的钱，外加一个可以精确查询的选择器；
- `textOnly`（默认）或精简 HTML；过长的 URL 折叠为 `__link__`；
- `maxlen`/`offset` 分页；`totalTextLength`/`truncated` 描述整页规模。

策略对模型是纯函数，因此 `test/page-scan.test.ts` 用手工构造的树驱动它——
上面每条规则都有对应的测试，去掉实现测试就红。

### 操作

- `browser_click` 走完整指针序列（over → move → press → focus → release →
  click）并返回点到了什么。只调 `click()` 的话，靠 hover 展开的组件永远
  不知道指针到过。
- `browser_input` 通过原型自身的 value setter 写入并触发 `input` +
  `change`——受框架管控的组件监听的就是这两个事件；直接赋
  `el.value` 页面什么都不知道。
- `browser_execute_js` 走 debugger 执行（CSP 拦不住），并返回页面 diff、
  新标签页、以及导航是否销毁了执行上下文。

### 安装

扩展通过 `chrome://extensions` 由用户手动加载一次（当前版本的
Chrome/Edge 已不再从注册表自动加载未打包扩展）。`browser-bridge-setup`
技能带有完整步骤、对「错误」徽标的解释、以及分层排障路径；运行时的错误
信息会直接给出要加载的目录。

Firefox：`about:debugging#/runtime/this-firefox` → 临时加载附加组件 →
`extension/firefox/manifest.json`（临时加载，重启后需重复）。
