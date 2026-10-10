import { expect, test } from "bun:test";
import { parseDuckDuckGoResults } from "../src/web-tools";
import { webTools } from "../src";

/**
 * `web_search`'s result parsing (the 2026-10-08 audit's P1-16).
 *
 * The audit measured the tool returning the raw DuckDuckGo HTML — a model got
 * `<div class="result results_links ...">` and a byte counter, with no
 * results it could read. A search's answer is its results.
 */

const PAGE = [
  '<div class="result results_links">',
  '<a class="result__a" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone&amp;rut=x">First result</a>',
  '<a class="result__snippet" href="//duckduckgo.com/l/?uddg=x">The first snippet</a>',
  "</div>",
  '<div class="result results_links">',
  '<a class="result__a" href="https://example.org/two">Second result</a>',
  '<a class="result__snippet" href="https://example.org/two">The second snippet</a>',
  "</div>",
].join("\n");

test("the results, their destinations and their snippets are parsed", () => {
  const results = parseDuckDuckGoResults(PAGE);
  expect(results).toEqual([
    {
      title: "First result",
      // The redirect's own parameters after `uddg` are not the destination's.
      url: "https://example.com/one",
      snippet: "The first snippet",
    },
    {
      title: "Second result",
      url: "https://example.org/two",
      snippet: "The second snippet",
    },
  ]);
});

test("a page with no results parses to none, not to a guess", () => {
  expect(
    parseDuckDuckGoResults("<html><body>no results</body></html>"),
  ).toEqual([]);
  // A rate-limited page is the same answer: nothing parseable.
  expect(parseDuckDuckGoResults("<html>anomaly</html>")).toEqual([]);
});

test("markup in a title is stripped and entities are decoded", () => {
  const page = [
    '<div class="result">',
    '<a class="result__a" href="https://example.com/x">A &amp; B <b>bold</b></a>',
    "</div>",
  ].join("\n");
  expect(parseDuckDuckGoResults(page)[0]).toMatchObject({
    title: "A & B bold",
    url: "https://example.com/x",
    snippet: "",
  });
});

test("web_search answers with the parsed results, not the page's markup (P1-16)", async () => {
  // The audit's exact measurement: the tool returned the raw HTML and a byte
  // counter. The answer is the results now.
  const originalFetch = globalThis.fetch;
  const page = [
    '<div class="result results_links">',
    '<a class="result__a" href="https://example.com/one">First result</a>',
    '<a class="result__snippet" href="https://example.com/one">The first snippet</a>',
    "</div>",
  ].join("\n");
  globalThis.fetch = Object.assign(
    async () =>
      new Response(page, {
        status: 200,
        headers: { "content-type": "text/html" },
      }),
    { preconnect: async () => undefined },
  ) as never;
  try {
    const tool = webTools.find((t) => t.name === "web_search")!;
    const answer = String(
      await tool.execute({ query: "natalia cli" }, {} as never),
    );
    expect(answer).toContain("results=1");
    expect(answer).toContain("1. First result");
    expect(answer).toContain("https://example.com/one");
    expect(answer).toContain("The first snippet");
    // The markup itself is not the answer.
    expect(answer).not.toContain("result__a");
    expect(answer).not.toContain("<div");
  } finally {
    globalThis.fetch = originalFetch;
  }
});

test("results parse whatever order the attributes arrive in", () => {
  // F-D: every search answered `results=0` while the results were sitting in
  // the body. The parser assumed `class` came before `href` on the result
  // anchor and that the block's `<div>` opened with `class=` first — neither
  // holds in DuckDuckGo's real markup.
  const realShaped = [
    '<div data-testid="result" class="result results_links">',
    '<a rel="nofollow noopener" href="//duckduckgo.com/l/?uddg=https%3A%2F%2Fexample.com%2Fone" class="result__a">First result</a>',
    '<div class="result__snippet">The first snippet</div>',
    "</div>",
    '<div data-testid="result" class="result results_links">',
    '<a href="https://example.org/two" class="result__a">Second result</a>',
    '<a class="result__snippet" href="https://example.org/two">The second snippet</a>',
    "</div>",
  ].join("\n");
  expect(parseDuckDuckGoResults(realShaped)).toEqual([
    {
      title: "First result",
      url: "https://example.com/one",
      snippet: "The first snippet",
    },
    {
      title: "Second result",
      url: "https://example.org/two",
      snippet: "The second snippet",
    },
  ]);
});

test("a container the parser does not recognise no longer hides the results", () => {
  // The old parser split on `<div class="...result...">` before looking at
  // anything, so a container whose attributes changed took every result down
  // with it. The results are found by their own anchor class now.
  const noBlocks = [
    "<main>",
    '<a class="result__a" href="https://example.com/solo">Solo result</a>',
    '<span class="result__snippet">A snippet</span>',
    "</main>",
  ].join("\n");
  expect(parseDuckDuckGoResults(noBlocks)).toEqual([
    {
      title: "Solo result",
      url: "https://example.com/solo",
      snippet: "A snippet",
    },
  ]);
});
