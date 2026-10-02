import { expect, test } from "bun:test";
import { tmpdir } from "node:os";
import { createPluginRegistry } from "@anthelia/plugin";
import { createToolRegistry } from "@anthelia/tools";
import {
  createWebPlugin,
  WEB_PLUGIN_ID,
  webToolFamily,
  webTools,
} from "../src";

test("the web family describes the tools it ships", () => {
  const family = webToolFamily();
  expect(family.id).toBe("web");
  expect(family.scope).toBe("session");
  expect(family.tools).toEqual(webTools);
});

test("the web plugin owns its tools and unloads cleanly", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(createWebPlugin());
  expect(registry.list()[0]).toMatchObject({
    id: WEB_PLUGIN_ID,
    scope: "session",
  });
  for (const tool of webTools) expect(tools.has(tool.name)).toBe(true);
  await registry.unload(WEB_PLUGIN_ID);
  for (const tool of webTools) expect(tools.has(tool.name)).toBe(false);
});

test("web_fetch enforces the network policy before reaching the network", async () => {
  const tool = webToolFamily().tools.find(
    (candidate) => candidate.name === "web_fetch",
  )!;
  await expect(
    tool.execute({ url: "file:///etc/passwd" }, { settings: {} } as never),
  ).rejects.toThrow(/http\(s\)/u);
  await expect(
    tool.execute({ url: "http://localhost:8080" }, {
      settings: { allowLocalhost: false },
    } as never),
  ).rejects.toThrow(/localhost/u);
});

test("web_fetch finalizes fetched content by stripping script blocks", () => {
  const tool = webToolFamily().tools.find(
    (candidate) => candidate.name === "web_fetch",
  )!;
  const content = `<html><script>alert(1)</script><p>hello</p><script type="module">run()</script></html>`;
  const finalized = tool.output!.finalizeContent!(content);
  expect(finalized).not.toContain("alert(1)");
  expect(finalized).not.toContain("run()");
  expect(finalized).toContain("<p>hello</p>");
});

test("web_search uses a native configured endpoint without proxying Go", async () => {
  const saved = process.env.NATALIA_WEB_SEARCH_URL;
  const server = Bun.serve({
    port: 0,
    fetch: (request) => {
      expect(new URL(request.url).searchParams.get("q")).toBe("Natalia TS7");
      return new Response("native search result");
    },
  });
  process.env.NATALIA_WEB_SEARCH_URL = server.url.toString();
  const tool = webToolFamily().tools.find(
    (candidate) => candidate.name === "web_search",
  )!;
  try {
    await expect(
      tool.execute({ query: "Natalia TS7" }, { workspaceRoot: tmpdir() }),
    ).resolves.toContain("native search result");
  } finally {
    server.stop(true);
    if (saved) process.env.NATALIA_WEB_SEARCH_URL = saved;
    else delete process.env.NATALIA_WEB_SEARCH_URL;
  }
});

test("web_search selects the configured endpoint only when its priority permits", async () => {
  const configured = Bun.serve({
    port: 0,
    fetch: () => new Response("configured provider result"),
  });
  const tool = webToolFamily().tools.find(
    (candidate) => candidate.name === "web_search",
  )!;
  try {
    await expect(
      tool.execute(
        { query: "priority" },
        {
          workspaceRoot: tmpdir(),
          settings: {
            webSearchEndpoint: configured.url.toString(),
            webSearchProviderPriority: ["configured", "duckduckgo"],
            allowLocalhost: true,
          },
        },
      ),
    ).resolves.toContain("configured provider result");
  } finally {
    configured.stop(true);
  }
});

test("web tools do not own browser tools", () => {
  const names = webToolFamily().tools.map((tool) => tool.name);
  expect(names).not.toContain("browser_tabs");
  expect(names).not.toContain("browser_open");
});
