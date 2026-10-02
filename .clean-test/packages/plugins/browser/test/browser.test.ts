import { afterEach, expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createPluginRegistry } from "@anthelia/plugin";
import { createToolRegistry } from "@anthelia/tools";
import {
  BROWSER_BRIDGE_EXTENSION_MISSING_ERROR,
  BROWSER_PLUGIN_ID,
  browserToolFamily,
  browserTools,
  createBrowserPlugin,
  getBrowserBridgeLifecycle,
} from "../src";

const originalPort = process.env.NATALIA_BROWSER_BRIDGE_PORT;
const originalUrl = process.env.NATALIA_BROWSER_BRIDGE_URL;

afterEach(async () => {
  await getBrowserBridgeLifecycle().close();
  if (originalPort === undefined)
    delete process.env.NATALIA_BROWSER_BRIDGE_PORT;
  else process.env.NATALIA_BROWSER_BRIDGE_PORT = originalPort;
  if (originalUrl === undefined) delete process.env.NATALIA_BROWSER_BRIDGE_URL;
  else process.env.NATALIA_BROWSER_BRIDGE_URL = originalUrl;
});

test("the browser family describes the tools it ships", () => {
  const family = browserToolFamily();
  expect(family.id).toBe("browser");
  expect(family.scope).toBe("session");
  expect(family.tools).toEqual(browserTools);
  expect(browserTools.map((tool) => tool.name)).toEqual([
    "browser_screenshot",
    "browser_open",
    "browser_close",
    "browser_tabs",
    "browser_scan",
    "browser_execute_js",
    "browser_navigate",
    "browser_click",
    "browser_input",
  ]);
});

test("the browser plugin owns its tools and unloads cleanly", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(createBrowserPlugin());
  expect(registry.list()[0]).toMatchObject({
    id: BROWSER_PLUGIN_ID,
    scope: "session",
  });
  for (const tool of browserTools) expect(tools.has(tool.name)).toBe(true);
  await registry.unload(BROWSER_PLUGIN_ID);
  for (const tool of browserTools) expect(tools.has(tool.name)).toBe(false);
});

test("browser tools report a friendly missing-extension error when no extension is connected", async () => {
  // Use a random port so the test never conflicts with a real development
  // bridge server already running on the default port.
  process.env.NATALIA_BROWSER_BRIDGE_PORT = "0";
  delete process.env.NATALIA_BROWSER_BRIDGE_URL;

  const tabTool = browserToolFamily().tools.find(
    (tool) => tool.name === "browser_tabs",
  )!;
  const root = await mkdtemp(join(tmpdir(), "natalia-browser-test-"));

  await expect(
    tabTool.execute({}, { workspaceRoot: root } as never),
  ).rejects.toThrow(BROWSER_BRIDGE_EXTENSION_MISSING_ERROR);
});

test("browser tools delegate to an external bridge when one is configured", async () => {
  const calls: Array<{ path: string; body: Record<string, unknown> }> = [];
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      const url = new URL(request.url);
      const body = (await request.json().catch(() => ({}))) as Record<
        string,
        unknown
      >;
      calls.push({ path: url.pathname, body });
      if (url.pathname === "/browser/tabs")
        return Response.json({
          activeId: "tab_1",
          tabs: [
            {
              id: "tab_1",
              url: "https://example.com",
              title: "Example",
              active: true,
            },
          ],
        });
      if (url.pathname === "/browser/open")
        return Response.json({
          ok: true,
          tabId: "tab_2",
          url: "https://example.org",
        });
      if (url.pathname === "/browser/screenshot")
        return Response.json({ data: "data:image/png;base64,QUJD" });
      if (url.pathname === "/browser/scan")
        return Response.json({
          url: "https://example.com",
          title: "Example",
          text: "hello",
          html: "<body>hello</body>",
          truncated: false,
          textOnly: true,
        });
      if (url.pathname === "/browser/execute_js")
        return Response.json({ result: "ok", tabId: "tab_1" });
      if (url.pathname === "/browser/navigate")
        return Response.json({
          ok: true,
          tabId: "tab_1",
          url: "https://example.org",
        });
      if (url.pathname === "/browser/click")
        return Response.json({ result: "ok", tabId: "tab_1" });
      if (url.pathname === "/browser/input")
        return Response.json({ result: "ok", tabId: "tab_1" });
      return new Response("not found", { status: 404 });
    },
  });
  const saved = process.env.NATALIA_BROWSER_BRIDGE_URL;
  process.env.NATALIA_BROWSER_BRIDGE_URL = server.url.toString();
  const root = await mkdtemp(join(tmpdir(), "natalia-browser-bridge-test-"));
  try {
    const family = browserToolFamily();

    const tabs = (await family.tools
      .find((tool) => tool.name === "browser_tabs")!
      .execute({}, { workspaceRoot: root } as never)) as string;
    expect(tabs).toContain("tab_1");

    const scanned = (await family.tools
      .find((tool) => tool.name === "browser_scan")!
      .execute({ tabId: "tab_1" }, { workspaceRoot: root } as never)) as string;
    expect(scanned).toContain("hello");

    const executed = (await family.tools
      .find((tool) => tool.name === "browser_execute_js")!
      .execute({ tabId: "tab_1", script: "document.title" }, {
        workspaceRoot: root,
      } as never)) as string;
    expect(executed).toContain("ok");

    const navigated = (await family.tools
      .find((tool) => tool.name === "browser_navigate")!
      .execute({ tabId: "tab_1", url: "https://example.org" }, {
        workspaceRoot: root,
        settings: { allowedSchemes: ["https"], allowedHosts: ["example.org"] },
      } as never)) as string;
    expect(navigated).toContain("tab_1");

    const clicked = (await family.tools
      .find((tool) => tool.name === "browser_click")!
      .execute({ tabId: "tab_1", x: 10, y: 20 }, {
        workspaceRoot: root,
      } as never)) as string;
    expect(clicked).toContain("ok");

    const input = (await family.tools
      .find((tool) => tool.name === "browser_input")!
      .execute({ tabId: "tab_1", text: "hello" }, {
        workspaceRoot: root,
      } as never)) as string;
    expect(input).toContain("ok");

    const screenshotPath = join(root, "shot.png");
    const shot = (await family.tools
      .find((tool) => tool.name === "browser_screenshot")!
      .execute({ url: "https://example.org", path: "shot.png" }, {
        workspaceRoot: root,
        settings: { allowedSchemes: ["https"], allowedHosts: ["example.org"] },
      } as never)) as string;
    expect(shot).toContain("shared-browser");
    expect(require("node:fs").readFileSync(screenshotPath)).toEqual(
      Buffer.from([0x41, 0x42, 0x43]),
    );

    const paths = calls.map((call) => call.path);
    expect(paths).toContain("/browser/tabs");
    expect(paths).toContain("/browser/scan");
    expect(paths).toContain("/browser/execute_js");
    expect(paths).toContain("/browser/screenshot");
  } finally {
    server.stop(true);
    if (saved) process.env.NATALIA_BROWSER_BRIDGE_URL = saved;
    else delete process.env.NATALIA_BROWSER_BRIDGE_URL;
  }
});

test("plugin setup does not start the bridge server until a tool is used", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(createBrowserPlugin());
  const lifecycle = getBrowserBridgeLifecycle();
  expect(lifecycle.isConnected()).toBe(false);
  expect(lifecycle.getBaseUrl()).toBeUndefined();
  await registry.unload(BROWSER_PLUGIN_ID);
});
