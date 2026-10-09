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

test("a capped fetch says it was capped, with the byte total", async () => {
  // A silent `slice(0, maxBytes)` told the model nothing was missing. The
  // result now names the cap and the total, and the card keeps the header
  // line out of the page body.
  const tool = webToolFamily().tools.find(
    (candidate) => candidate.name === "web_fetch",
  )!;
  const originalFetch = globalThis.fetch;
  const big = "<html>" + "x".repeat(4000) + "</html>";
  globalThis.fetch = (async () =>
    new Response(big, {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as unknown as typeof fetch;
  try {
    const value = (await tool.execute(
      { url: "https://example.com/big", maxBytes: 500 },
      { workspaceRoot: "/tmp" },
    )) as string;
    expect(value).toContain("status=200");
    expect(value).toContain("truncated=true bytes=500 of " + big.length);
    const card = tool.output!.presentResult!(
      { url: "https://example.com/big" },
      value,
    );
    expect(card!.meta).toContainEqual(["truncated", "true"]);
    expect(card!.body).not.toContain("truncated=true");
    expect(card!.body!.length).toBe(500);
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("web_search projects a card naming the status and the byte cap", () => {
  // web_search had NO output definition at all: the only web tool whose card
  // the UI could not draw, so a search turn showed a raw JSON blob. Its card
  // is the fetch card's twin — same header block, same two facets.
  const tool = webTools.find((t) => t.name === "web_search")!;
  expect(tool.output?.presentCall?.({ query: "natalia cli" })).toEqual({
    kind: "web",
    title: "natalia cli",
    summary: "search",
  });
  const card = tool.output?.presentResult?.(
    { query: "natalia cli" },
    "status=200\ncontent-type=text/html\nresults=7\ntruncated=true bytes=500 of 9000\n1. First\n   https://example.com",
  );
  expect(card).toEqual({
    kind: "web",
    title: "natalia cli",
    // The result count is the headline fact of a search (P1-16): a reader
    // scanning rows wants "7 results", not a status code.
    summary: "7 results",
    body: "1. First\n   https://example.com",
    meta: [
      ["status", "200"],
      ["results", "7"],
      ["truncated", "true"],
    ],
  });
  // An uncapped result carries no truncation facet — a UI must not invent one.
  const whole = tool.output?.presentResult?.(
    { query: "natalia cli" },
    "status=200\ncontent-type=text/html\n<body>",
  );
  expect(whole?.meta).toEqual([
    ["status", "200"],
    ["results", "0"],
  ]);
});

test("a search that found nothing says so instead of returning the page (F10)", async () => {
  // The 2026-10-10 sweep's F10: with no endpoint configured, a search returned
  // 33 KB of DuckDuckGo markup — measured — for an answer of "no results".
  // The raw body is reachable through web_fetch; the search's own answer is
  // that it found nothing.
  const originalFetch = globalThis.fetch;
  // No endpoint configured, so the DuckDuckGo fallback is the source — the
  // path the sweep measured.
  globalThis.fetch = (async () =>
    new Response("<html><body>no results here</body></html>", {
      status: 200,
      headers: { "content-type": "text/html" },
    })) as never;
  try {
    const tools = new Map(webTools.map((tool) => [tool.name, tool]));
    const answer = String(
      await tools
        .get("web_search")!
        .execute({ query: "nothing" }, { workspaceRoot: tmpdir() } as never),
    );
    expect(answer).toContain("results=0");
    expect(answer).toContain("body=omitted");
    expect(answer).toContain("web_fetch");
    // The markup itself is not in the answer.
    expect(answer).not.toContain("<html>");
  } finally {
    globalThis.fetch = originalFetch;
  }
});
