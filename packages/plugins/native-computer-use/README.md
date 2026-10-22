# Computer Use Tools

[中文](#中文) | [English](#english)

<a id="english"></a>

## English

Drives the desktop itself — the windows, the screen, the pointer and the
keyboard — with every action verified against the pixels it changed.

Six tools, one discipline: **probe, then one action, then verify.**

| Tool                  | What it does                                                                                                                                          |
| --------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `computer_windows`    | Enumerates the visible top-level windows (title, class, pid, physical rectangle, foreground) and the screen's physical size. The first probe, always. |
| `computer_screenshot` | Captures the screen or one window's client area as a PNG in the workspace and attaches it to the turn.                                                |
| `computer_click`      | Clicks at physical coordinates and verifies the click against the pixels around it.                                                                   |
| `computer_type`       | Types text through the keyboard events (Unicode, clipboard untouched).                                                                                |
| `computer_key`        | Sends a key or chord: `enter`, `ctrl+v`, `ctrl+shift+esc`, `f5`.                                                                                      |
| `computer_activate`   | Brings a window to the front and verifies it took the foreground.                                                                                     |

### Layout

| Path                   | What it is                                                     |
| ---------------------- | -------------------------------------------------------------- |
| `src/tools.ts`         | The six tools and their verification/reporting                 |
| `src/win32/ffi.ts`     | The Win32 surface: libraries opened lazily, handles normalized |
| `src/win32/screen.ts`  | DPI awareness and the virtual screen's metrics                 |
| `src/win32/windows.ts` | Enumeration, client-area geometry, activation                  |
| `src/win32/capture.ts` | BitBlt capture into BGRA, then a PNG                           |
| `src/win32/input.ts`   | Pointer and keyboard events                                    |
| `src/png.ts`           | The PNG encoder (signature, IHDR, IDAT, IEND)                  |
| `src/coords.ts`        | Pure screen geometry: regions, clipping, frame→screen          |
| `src/keys.ts`          | Pure key-spec parsing (`ctrl+v` → the press order)             |
| `src/verify.ts`        | Pure click verification: the diff and its verdict              |
| `skills/computer-use/` | The discipline the tools are built around                      |

### The rules the code enforces

- **Physical pixels, one grid.** The process marks itself DPI aware once;
  after that the Win32 metrics, the window rectangles, the capture and the
  click are all the same physical grid. A point read off a screenshot is a
  point that can be clicked.
- **A window's capture is its client area.** The answer carries the
  client origin; a point read off that image is relative to it. The window
  rectangle is wrong for this — it includes the title bar and borders,
  which is the offset that lands a click one title-bar above its target.
- **A click is verified.** The region around the point is sampled before
  and after; the verdict reports the change's size or names what to check
  (the coordinate transform first). It never says "ok" for a call that
  returned, and never advises clicking the same pixel again.
- **No silent success.** Activation is verified against
  `GetForegroundWindow`; a capture names the region it really got; a
  platform that cannot drive a desktop refuses at call time with the
  reason.
- **The clipboard is the user's.** Text goes through the Unicode key
  events, not a paste.

### Platform

The native layer is Win32 (`user32`/`gdi32`) through Bun's FFI — no native
build step, no prebuilt binary. The branch is a runtime check: the plugin
loads everywhere, and on a platform without the layer every tool answers
with the reason instead of pretending. A POSIX backend (X11) would slot in
behind the same seams; until it exists, the refusal is the honest answer.

### Tests

- `test/pure.test.ts` — the PNG round trip, the coordinate arithmetic, the
  key specs, the click verdicts. No display needed.
- `test/desktop.test.ts` — Windows only, against the real desktop:
  enumeration, the foreground flag, client-area geometry, a real capture.
  Every one of them is read-only; nothing here clicks, types or activates
  the user's desktop.
- `test/plugin.test.ts` — the family, the registrations, the manifest.

<a id="chinese"></a>

## 中文

驱动桌面本身——窗口、屏幕、指针、键盘——并且每个动作都对照它改变的像素
做验证。

六个工具，一条纪律：**先探测，再一个动作，再验证。**

| 工具                  | 作用                                                                                    |
| --------------------- | --------------------------------------------------------------------------------------- |
| `computer_windows`    | 枚举可见的顶层窗口（标题、类名、pid、物理矩形、是否前台）与屏幕物理尺寸。永远的第一步。 |
| `computer_screenshot` | 截取整个屏幕或某个窗口的客户区，写成本地 PNG 并挂到本轮对话。                           |
| `computer_click`      | 在物理坐标上点击，并对照点击周边的像素变化做验证。                                      |
| `computer_type`       | 通过键盘事件输入文本（Unicode，不碰剪贴板）。                                           |
| `computer_key`        | 发送按键或组合键：`enter`、`ctrl+v`、`ctrl+shift+esc`、`f5`。                           |
| `computer_activate`   | 把窗口带到前台，并验证它确实拿到了前台。                                                |

### 目录

| 路径                   | 作用                                      |
| ---------------------- | ----------------------------------------- |
| `src/tools.ts`         | 六个工具及其验证与汇报                    |
| `src/win32/ffi.ts`     | Win32 入口：库惰性打开，句柄统一规范化    |
| `src/win32/screen.ts`  | DPI 感知与虚拟屏幕度量                    |
| `src/win32/windows.ts` | 窗口枚举、客户区几何、激活                |
| `src/win32/capture.ts` | BitBlt 抓屏转 BGRA，再编码 PNG            |
| `src/win32/input.ts`   | 指针与键盘事件                            |
| `src/png.ts`           | PNG 编码器（签名、IHDR、IDAT、IEND）      |
| `src/coords.ts`        | 纯屏幕几何：区域、裁剪、截图坐标→屏幕坐标 |
| `src/keys.ts`          | 纯按键规格解析（`ctrl+v` → 按下顺序）     |
| `src/verify.ts`        | 纯点击验证：像素 diff 与结论              |
| `skills/computer-use/` | 工具遵循的操作纪律                        |

### 代码强制的规则

- **物理像素，同一网格。** 进程一次性声明 DPI 感知；此后 Win32 度量、
  窗口矩形、截图、点击都在同一张物理网格上。从截图读出的坐标就是可以
  点击的坐标。
- **窗口截图是客户区。** 返回里带客户区原点；从该图读出的坐标相对于
  它。窗口矩形不能用来做这个换算——它包含标题栏和边框，那正是让点击
  偏高一个标题栏的偏移量。
- **点击有验证。** 点击前后采样点击点周边区域；结论报告变化幅度，或
  指出该查什么（坐标换算优先）。它不会把「调用返回了」说成「成功」，
  也不会建议再点一次同一个像素。
- **没有静默成功。** 激活对照 `GetForegroundWindow` 验证；截图如实报告
  真正抓到的区域；不能驱动桌面的平台在调用时给出原因并拒绝，而不是
  假装成功。
- **剪贴板是用户的。** 文本走 Unicode 键盘事件，不走粘贴。

### 平台

原生层是通过 Bun FFI 调用的 Win32（`user32`/`gdi32`）——不需要原生
构建，不需要预编译二进制。平台分支是运行时判断：插件在任何平台都能
加载，在没有该能力的平台上每个工具都会给出原因并拒绝。POSIX 后端
（X11）可以挂到同一组接缝后面；在它存在之前，拒绝就是诚实的答案。

### 测试

- `test/pure.test.ts` —— PNG 往返、坐标算术、按键规格、点击结论。
  不需要显示器。
- `test/desktop.test.ts` —— 仅 Windows，对着真实桌面：枚举、前台标记、
  客户区几何、真实抓屏。其中每一条都是只读的；没有任何测试会点击、
  输入或激活用户的桌面。
- `test/plugin.test.ts` —— 工具族、注册、manifest。
