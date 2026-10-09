/**
 * The web tool family, as a separately packaged family.
 *
 * It provides the basic web surface (fetch and search) only. The full browser
 * surface is owned by the separate natalia-tool-browser plugin.
 */
import {
  assertNetworkURL,
  numberOr,
  requireObject,
  requireString,
} from "@anthelia/tools";
import type { Plugin, PluginManifest } from "@anthelia/plugin";
import type { RuntimeTool, ToolFamily } from "@anthelia/tools";

export const WEB_PLUGIN_ID = "natalia-tool-web";

function webFetchTool(): RuntimeTool {
  return {
    name: "web_fetch",
    description: "Fetch an HTTP or HTTPS URL and return text content.",
    requiresApproval: false,
    timeoutSec: 30,
    parameters: {
      type: "object",
      properties: {
        url: {
          type: "string",
          description: "The HTTP(S) URL to fetch.",
        },
        maxBytes: {
          type: "number",
          description:
            "Maximum decoded bytes to return. The result says when the body was cut, " +
            "so a caller can fetch a narrower resource instead of re-reading the same cap.",
        },
      },
      required: ["url"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: {
          status: { type: "number" },
          contentType: { type: "string" },
          body: { type: "string" },
        },
        required: ["status", "contentType", "body"],
        additionalProperties: false,
      },
      presentCall(args) {
        return {
          kind: "web",
          title: requireObject(args).url as string,
          summary: "fetch",
        };
      },
      presentResult(args, value) {
        const url = requireObject(args).url as string;
        const status = Number(/status=(\d+)/u.exec(value)?.[1] ?? "0");
        const contentType =
          /content-type=([^\n]*)/u.exec(value)?.[1] ?? "unknown";
        // The header block grows by a line when the body is truncated, so the
        // body starts after the LAST `key=...` header line — a fixed slice(2)
        // would put `truncated=true ...` in the card's body as page text.
        const lines = value.split("\n");
        let bodyStart = 0;
        while (
          bodyStart < lines.length &&
          /^[a-z][a-z-]*=/u.test(lines[bodyStart]!)
        )
          bodyStart += 1;
        const body = lines.slice(bodyStart).join("\n") || "(empty body)";
        return {
          kind: "web",
          title: url,
          summary: `status ${status}`,
          body,
          meta: [
            ["content-type", contentType],
            ["status", String(status)],
            // The cap is a fact about the result, so the card shows it rather
            // than presenting a cut page as the whole page.
            ...(/truncated=true/u.test(value)
              ? ([["truncated", "true"]] as Array<[string, string]>)
              : []),
          ],
        };
      },
      // The page's scripts are not content the model should read: a fetched
      // page goes to the model with its executable script blocks removed.
      finalizeContent(content) {
        return content.replace(/<script\b[^>]*>[\s\S]*?<\/script>/giu, "");
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      const url = requireString(args.url, "url");
      if (!/^https?:\/\//iu.test(url))
        throw new Error("web_fetch requires http(s) URL");
      assertNetworkURL(url, context);
      const response = await fetch(url, { signal: context.signal });
      if (!response.ok)
        throw new Error(
          `web_fetch failed: HTTP ${response.status} from ${url}`,
        );
      const text = await response.text();
      const bounded = boundedWebBody(text, numberOr(args.maxBytes, 20000));
      return [
        `status=${response.status}`,
        `content-type=${response.headers.get("content-type") ?? "unknown"}`,
        ...(bounded.truncated
          ? [
              `truncated=true bytes=${bounded.body.length} of ${bounded.totalBytes}`,
            ]
          : []),
        bounded.body,
      ].join("\n");
    },
  };
}

/**
 * The byte bound, WITH its facts. A silent `slice(0, maxBytes)` told the model
 * nothing was missing while the rest of the page — or the search results —
 * went unread; the caller could not tell a complete result from a cut one.
 * The header line rides the repo's own vocabulary (`truncated`, and the byte
 * total the way `mailbox_status` reports `returned/total`).
 */
function boundedWebBody(
  text: string,
  maxBytes: number,
): {
  body: string;
  truncated: boolean;
  totalBytes: number;
} {
  const totalBytes = Buffer.byteLength(text, "utf8");
  if (totalBytes <= maxBytes)
    return { body: text, truncated: false, totalBytes };
  return {
    body: text.slice(0, maxBytes),
    truncated: true,
    totalBytes,
  };
}

function webSearchTool(): RuntimeTool {
  return {
    name: "web_search",
    description:
      "Search the web through a configured endpoint, or DuckDuckGo HTML when no endpoint is configured.",
    requiresApproval: false,
    timeoutSec: 30,
    parameters: {
      type: "object",
      properties: {
        query: {
          type: "string",
          description: "The search query, in the provider's own syntax.",
        },
        maxBytes: {
          type: "number",
          description:
            "Maximum decoded bytes to return. The result says when the body was cut.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: {
      schema: {
        type: "object",
        properties: { status: { type: "integer" } },
        required: ["status"],
        additionalProperties: false,
      },
      presentCall(args) {
        return {
          kind: "web",
          title: requireObject(args).query as string,
          summary: "search",
        };
      },
      presentResult(args, value) {
        const query = requireObject(args).query as string;
        // The result's header block is `status=..`, then the body. The
        // facets say what came back and whether the byte cap cut it — the
        // same two facts the fetch card carries, so both web tools read
        // alike.
        const status = Number(/status=(\d+)/u.exec(value)?.[1] ?? "0");
        const truncated = /truncated=true/u.test(value);
        const results = Number(/results=(\d+)/u.exec(value)?.[1] ?? "0");
        const lines = value.split("\n");
        let bodyStart = 0;
        while (
          bodyStart < lines.length &&
          /^[a-z][a-z-]*=/u.test(lines[bodyStart]!)
        )
          bodyStart += 1;
        return {
          kind: "web",
          title: query,
          // The result count is the headline fact of a search (P1-16): a
          // reader scanning rows wants "7 results", not a status code.
          summary:
            results > 0
              ? `${results} result${results === 1 ? "" : "s"}`
              : "no results",
          body: lines.slice(bodyStart).join("\n") || "(empty body)",
          meta: [
            ["status", String(status)],
            ["results", String(results)],
            ...(truncated
              ? ([["truncated", "true"]] as Array<[string, string]>)
              : []),
          ],
        };
      },
    },
    async execute(input, context) {
      const args = requireObject(input);
      const search = selectWebSearchSource({
        endpoint:
          context.settings?.webSearchEndpoint ??
          process.env.NATALIA_WEB_SEARCH_URL,
        priority: context.settings?.webSearchProviderPriority,
      });
      const endpoint = search.endpoint;
      const url = new URL(endpoint);
      url.searchParams.set("q", requireString(args.query, "query"));
      assertNetworkURL(url.href, context);
      const response = await fetch(url, {
        headers: { "user-agent": "Natalia-TS7-Search/0.1" },
        signal: context.signal,
      });
      const text = await response.text();
      if (!response.ok)
        throw new Error(
          `web_search failed: HTTP ${response.status} from ${url.origin}`,
        );
      const bounded = boundedWebBody(text, numberOr(args.maxBytes, 20000));
      // P1-16: a search's answer is its RESULTS, not the page's markup. The
      // DuckDuckGo HTML endpoint is parsed here — title, destination URL
      // (the redirect unwrapped), snippet — and the result lines are what
      // the model reads. A page that does not parse yields `results=0` with
      // the reason named, and the raw body is still reachable through
      // web_fetch on the same URL.
      const parsed = parseDuckDuckGoResults(bounded.body);
      const header = [
        `status=${response.status}`,
        `content-type=${response.headers.get("content-type") ?? "unknown"}`,
        `source=${search.label}`,
        `results=${parsed.length}`,
        ...(parsed.length === 0
          ? [
              "note=the page carried no parseable results; use web_fetch on the same URL for the raw body",
            ]
          : []),
        ...(bounded.truncated
          ? [
              `truncated=true bytes=${bounded.body.length} of ${bounded.totalBytes}`,
            ]
          : []),
      ];
      if (parsed.length === 0) return [...header, bounded.body].join("\n");
      return [
        ...header,
        ...parsed.map(
          (result, index) =>
            `${index + 1}. ${result.title}\n   ${result.url}\n   ${result.snippet}`,
        ),
      ].join("\n");
    },
  };
}

/**
 * A DuckDuckGo HTML result page, parsed into results.
 *
 * The 2026-10-08 audit's P1-16: `web_search` returned the raw HTML — a model
 * got `<div class="result results_links ...">` and had to parse markup it
 * cannot reliably parse (and the byte cap usually cut it mid-tag). The
 * search tool's job is the RESULTS, so the parsing happens here, once, where
 * the page's shape is known.
 *
 * A page that does not match the expected shape yields no results rather
 * than a guess — the caller then sees `results=0` and the raw body is still
 * available through `web_fetch` on the same URL.
 */
export type WebSearchResult = {
  title: string;
  url: string;
  snippet: string;
};

export function parseDuckDuckGoResults(html: string): WebSearchResult[] {
  const results: WebSearchResult[] = [];
  // Each result is an anchor with class result__a inside a result block;
  // the snippet is the result__snippet node's text.
  const blocks = html.split(/<div[^>]*class="[^"]*result[^"]*"/u).slice(1);
  for (const block of blocks) {
    const anchor =
      /<a[^>]*class="[^"]*result__a[^"]*"[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/u.exec(
        block,
      );
    if (!anchor) continue;
    const href = decodeEntities(anchor[1] ?? "");
    const title = stripTags(decodeEntities(anchor[2] ?? ""));
    const snippetMatch =
      /<a[^>]*class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/u.exec(
        block,
      ) ??
      /class="[^"]*result__snippet[^"]*"[^>]*>([\s\S]*?)<\/a>/u.exec(block);
    const snippet = snippetMatch
      ? stripTags(decodeEntities(snippetMatch[1] ?? ""))
      : "";
    // DuckDuckGo wraps outbound links in a redirect; unwrap it so the URL a
    // model reads is the destination it can fetch.
    const url = unwrapDuckDuckGoRedirect(href);
    if (!url || !title) continue;
    results.push({ title, url, snippet });
    if (results.length >= 20) break;
  }
  return results;
}

function decodeEntities(text: string): string {
  return text
    .replace(/&#x([0-9a-f]+);/giu, (_m, hex: string) =>
      String.fromCodePoint(Number.parseInt(hex, 16)),
    )
    .replace(/&#(\d+);/gu, (_m, dec: string) =>
      String.fromCodePoint(Number(dec)),
    )
    .replace(/&amp;/gu, "&")
    .replace(/&lt;/gu, "<")
    .replace(/&gt;/gu, ">")
    .replace(/&quot;/gu, '"')
    .replace(/&#39;/gu, "'")
    .replace(/&nbsp;/gu, " ");
}

function stripTags(html: string): string {
  return html
    .replace(/<[^>]*>/gu, "")
    .replace(/\s+/gu, " ")
    .trim();
}

function unwrapDuckDuckGoRedirect(href: string): string {
  // `//duckduckgo.com/l/?uddg=<encoded>` — the destination is the parameter.
  const match = /[?&]uddg=([^&]+)/u.exec(href);
  if (!match) return href;
  try {
    return decodeURIComponent(match[1] ?? "");
  } catch {
    return href;
  }
}

function selectWebSearchSource(input: {
  endpoint?: string;
  priority?: string[];
}) {
  const priority = input.priority?.length
    ? input.priority
    : input.endpoint
      ? ["configured", "duckduckgo"]
      : ["duckduckgo"];
  for (const provider of priority) {
    if (provider === "configured" && input.endpoint)
      return { endpoint: input.endpoint, label: "configured endpoint" };
    if (provider === "duckduckgo")
      return {
        endpoint: "https://html.duckduckgo.com/html/",
        label: "DuckDuckGo HTML",
      };
  }
  if (input.endpoint)
    return {
      endpoint: input.endpoint,
      label: "configured endpoint (priority fallback)",
    };
  return {
    endpoint: "https://html.duckduckgo.com/html/",
    label: "DuckDuckGo HTML (priority fallback)",
  };
}

export const webTools: RuntimeTool[] = [webFetchTool(), webSearchTool()];

/**
 * Session scope: these tools are only meaningful while the session using them
 * is alive; the network policy they enforce is the host's settings.
 */
export function webToolFamily(): ToolFamily {
  return {
    id: "web",
    name: "Web Tools",
    version: "1.0.0",
    description: "Fetching and searching the web.",
    scope: "session",
    tools: webTools,
  };
}

export const WEB_PLUGIN_MANIFEST: PluginManifest = {
  apiVersion: 2,
  id: WEB_PLUGIN_ID,
  version: "1.0.0",
  name: "Web Tools",
  description: "Fetching and searching the web.",
  entry: "index.js",
  scope: "session",
  provides: [],
  requires: [],
  optionalRequires: [],
  conflicts: [],
  dependencies: [],
  hooks: {},
  integrationPoints: ["tools"],
};

export function createWebPlugin(): Plugin {
  return {
    manifest: WEB_PLUGIN_MANIFEST,
    setup(api) {
      for (const tool of webTools) api.tools.register(tool);
    },
  };
}
