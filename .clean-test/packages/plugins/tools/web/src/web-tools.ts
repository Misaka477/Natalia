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
      properties: { url: { type: "string" }, maxBytes: { type: "number" } },
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
        const body = value.split("\n").slice(2).join("\n") || "(empty body)";
        return {
          kind: "web",
          title: url,
          summary: `status ${status}`,
          body,
          meta: [
            ["content-type", contentType],
            ["status", String(status)],
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
      return [
        `status=${response.status}`,
        `content-type=${response.headers.get("content-type") ?? "unknown"}`,
        text.slice(0, numberOr(args.maxBytes, 20000)),
      ].join("\n");
    },
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
      properties: { query: { type: "string" }, maxBytes: { type: "number" } },
      required: ["query"],
      additionalProperties: false,
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
      return [
        `status=${response.status}`,
        `content-type=${response.headers.get("content-type") ?? "unknown"}`,
        `source=${search.label}`,
        text.slice(0, numberOr(args.maxBytes, 20000)),
      ].join("\n");
    },
  };
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
