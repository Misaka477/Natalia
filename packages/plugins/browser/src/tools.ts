/**
 * Natalia browser tool family.
 *
 * These tools control the user's existing browser through the local
 * ExternalBrowserBridge (browser extension + bridge server).
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import {
  assertNetworkURL,
  numberOr,
  optionalString,
  requireObject,
  requireString,
  workspacePath,
} from "@anthelia/tools";
import type { RuntimeTool, ToolFamily } from "@anthelia/tools";
import { getBrowserBridgeLifecycle } from "./browser-bridge-lifecycle";

export const BROWSER_BRIDGE_EXTENSION_MISSING_ERROR =
  "Natalia Browser Bridge 扩展未安装或未启用。请告诉用户安装该扩展。";

/**
 * The browser-family card (presentation plan P1.3): every browser_* tool
 * answers with the bridge's JSON envelope, so the card is the URL (or the
 * tab id when there is no URL) and the outcome rides as the summary/pill.
 * A malformed result degrades to the generic card rather than throwing.
 */
/**
 * The family's facts (R5): ONE decode, shared by the event's meta slot and
 * the card. A browser answer carries the page's url, the tab it happened in,
 * and the bridge's own status — the three facts a reader scans without
 * opening the card.
 */
function browserFacts(value: string): Record<string, unknown> {
  try {
    const decoded = JSON.parse(value) as unknown;
    return decoded && typeof decoded === "object" && !Array.isArray(decoded)
      ? (decoded as Record<string, unknown>)
      : {};
  } catch {
    return {};
  }
}

/** The output block's `presentationMeta`, for the family's shared shape. */
function browserMeta(_args: unknown, value: string) {
  return browserFacts(value);
}

function browserCard(input: {
  callSummary: string;
  /**
   * The card kind: a call that names a page draws the `web` card (its url
   * is the card's structured field); a call about the browser itself is a
   * generic envelope card.
   */
  kind?: "web" | "generic";
}): NonNullable<
  import("@anthelia/tools").ToolOutputDefinition["presentResult"]
> {
  const kind = input.kind ?? "web";
  return (_args, value, meta) => {
    const facts = meta === undefined ? browserFacts(value) : meta;
    const url = typeof facts.url === "string" ? facts.url : undefined;
    const tabId = facts.tabId ?? facts.activeId;
    const title =
      url ??
      (typeof tabId === "string" || typeof tabId === "number"
        ? String(tabId)
        : "browser");
    const ok = facts.ok;
    const summary =
      ok === false ? `${input.callSummary} · failed` : input.callSummary;
    const meta2: Array<[string, string]> = [];
    if (url) meta2.push(["url", url]);
    if (tabId !== undefined && tabId !== null)
      meta2.push(["tab", String(tabId)]);
    if (typeof facts.status === "number")
      meta2.push(["status", String(facts.status)]);
    return {
      kind,
      title,
      summary,
      // The page is the web card's structured field; a client renders it
      // rather than reading the url off a pill.
      ...(kind === "web" && url !== undefined ? { url } : {}),
      ...(meta2.length ? { meta: meta2 } : {}),
    };
  };
}

function sharedBrowserBase(): string | undefined {
  return process.env.NATALIA_BROWSER_BRIDGE_URL || undefined;
}

function optionalTabId(value: unknown): string | number | undefined {
  if (value === undefined || value === null || value === "") return undefined;
  if (typeof value === "number") return Number.isInteger(value) ? value : value;
  if (typeof value === "string") {
    const trimmed = value.trim();
    if (trimmed === "") return undefined;
    const asNumber = Number(trimmed);
    if (Number.isInteger(asNumber) && String(asNumber) === trimmed)
      return asNumber;
    return trimmed;
  }
  return value as string;
}

async function resolveBrowserBridgeBase(): Promise<string> {
  const lifecycle = getBrowserBridgeLifecycle();
  await lifecycle.ensureStarted();
  if (!lifecycle.isConnected()) {
    throw new Error(BROWSER_BRIDGE_EXTENSION_MISSING_ERROR);
  }
  const base = lifecycle.getBaseUrl();
  if (!base) {
    throw new Error(BROWSER_BRIDGE_EXTENSION_MISSING_ERROR);
  }
  return base;
}

async function browserBridgeCall(
  action: string,
  input: Record<string, unknown> = {},
  sessionID?: string,
): Promise<unknown> {
  const externalBase = sharedBrowserBase();
  const base = externalBase ?? (await resolveBrowserBridgeBase());
  const payload = sessionID ? { ...input, sessionID } : input;
  const url = `${base.replace(/\/$/, "")}/browser/${action}`;
  // The extension state this process can observe: the local lifecycle's
  // connected flag when the bridge is ours, unknown when a configured
  // external bridge owns it (an external bridge's websocket state is not
  // this process's to see, and guessing would be a lie).
  const extensionState = () =>
    externalBase
      ? "unknown"
      : getBrowserBridgeLifecycle().isConnected()
        ? "connected"
        : "disconnected";
  let response: Response;
  try {
    response = await fetch(url, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch (cause) {
    // The bridge did not answer at all: the process that owns it (the
    // Desktop app) is not running, or the configured URL is wrong. The
    // 2026-10-06 smoke run saw nine browser_* tools fail with a bare
    // status line and no way to tell which layer to fix (T-16).
    throw new Error(
      `browser bridge unreachable for ${action} (bridgeServer=down, ` +
        `extension=${extensionState()}, retryable=true): the bridge at ` +
        `${base} did not answer ` +
        `(${cause instanceof Error ? cause.message : String(cause)}). Start the ` +
        `Natalia Desktop app so its bridge server runs, or set ` +
        `NATALIA_BROWSER_BRIDGE_URL to a running bridge, then retry.`,
    );
  }
  const text = await response.text();
  let body: unknown = text;
  try {
    body = JSON.parse(text);
  } catch {
    // keep raw text
  }
  if (!response.ok) {
    const serverError =
      typeof body === "object" && body && "error" in body
        ? String((body as { error?: unknown }).error)
        : undefined;
    // A 5xx from a server that ANSWERED is a layered failure: the bridge is
    // up, the layer behind it (usually the extension connection) is not, so
    // the diagnosis names the reachable layer and the missing one instead
    // of a bare status (T-16).
    if (response.status >= 500) {
      throw new Error(
        `browser bridge layer unavailable for ${action} ` +
          `(bridgeServer=up, extension=${extensionState()}, retryable=true, ` +
          `http=${response.status}): ` +
          `${serverError ?? `HTTP ${response.status}`}. The bridge answered, ` +
          `so the bridge itself is healthy; connect or install the Natalia ` +
          `Browser Bridge extension in Chrome/Edge, then retry.`,
      );
    }
    // A 4xx is the bridge's own answer (unknown action, bad input): pass it
    // through unchanged. It is not a connectivity failure, and "retry"
    // advice would be wrong.
    throw new Error(
      serverError ?? `browser bridge failed: HTTP ${response.status}`,
    );
  }
  return body;
}

function browserScreenshotTool(): RuntimeTool {
  return {
    name: "browser_screenshot",
    description:
      "Capture a real screenshot from the shared browser through the Natalia Browser Bridge extension.",
    requiresApproval: true,
    timeoutSec: 60,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
        path: { type: "string" },
        width: { type: "number" },
        height: { type: "number" },
      },
      required: ["path"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: {} },
      presentCall(args) {
        return {
          kind: "generic",
          title: optionalString(requireObject(args).url) ?? "screenshot",
          summary: "screenshot",
        };
      },
      presentResult: browserCard({ callSummary: "screenshot" }),
      presentationMeta: browserMeta,
    },
    async execute(input, context) {
      if (context.settings?.browserEnabled === false)
        throw new Error("browser tools are disabled by runtime configuration");
      const args = requireObject(input);
      const url = optionalString(args.url);
      const output = workspacePath(
        context.workspaceRoot,
        requireString(args.path, "path"),
      );
      await mkdir(dirname(output), { recursive: true });
      if (url) assertNetworkURL(url, context);

      let tabId: string | number | undefined;
      if (url) {
        const opened = (await browserBridgeCall(
          "open",
          { url },
          context.sessionID,
        )) as {
          tabId?: string | number;
        };
        tabId = opened.tabId;
        if (!tabId)
          throw new Error("shared browser opened a tab but returned no id");
      }
      const result = (await browserBridgeCall(
        "screenshot",
        {
          ...(tabId ? { tabId } : {}),
        },
        context.sessionID,
      )) as { data?: string };
      const data = String(result.data ?? "");
      const base64 = data.replace(/^data:image\/[^;]+;base64,/u, "");
      if (!base64)
        throw new Error("shared browser screenshot returned no image data");
      await writeFile(output, Buffer.from(base64, "base64"));
      return JSON.stringify({
        path: relative(context.workspaceRoot, output),
        via: "shared-browser",
      });
    },
  };
}

function browserOpenTool(): RuntimeTool {
  return {
    name: "browser_open",
    description:
      "Open a new browser tab (optionally with a URL). This never navigates an existing tab.",
    requiresApproval: true,
    timeoutSec: 20,
    parameters: {
      type: "object",
      properties: {
        url: { type: "string" },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: {} },
      presentCall(args) {
        return {
          kind: "generic",
          title: optionalString(requireObject(args).url) ?? "browser",
          summary: "open",
        };
      },
      presentResult: browserCard({ callSummary: "open" }),
      presentationMeta: browserMeta,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const url = optionalString(args.url);
      if (url) assertNetworkURL(url, context);
      return JSON.stringify(
        await browserBridgeCall("open", url ? { url } : {}, context?.sessionID),
        null,
        2,
      );
    },
  };
}

function browserCloseTool(): RuntimeTool {
  return {
    name: "browser_close",
    description:
      "Close a browser tab by id. tabId is optional; when omitted the active tab is closed.",
    requiresApproval: true,
    timeoutSec: 20,
    parameters: {
      type: "object",
      properties: {
        tabId: { type: ["string", "number"] },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: {} },
      presentCall(args) {
        return {
          kind: "generic",
          title: optionalString(requireObject(args).url) ?? "browser",
          summary: "close",
        };
      },
      presentResult: browserCard({ callSummary: "close" }),
      presentationMeta: browserMeta,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const tabId = optionalTabId(args.tabId);
      return JSON.stringify(
        await browserBridgeCall(
          "close",
          tabId ? { tabId } : {},
          context?.sessionID,
        ),
        null,
        2,
      );
    },
  };
}

function browserTabsTool(): RuntimeTool {
  return {
    name: "browser_tabs",
    description:
      "List tabs in the shared Natalia browser. Requires the shared browser bridge (Desktop or a future BrowserDaemon).",
    requiresApproval: false,
    timeoutSec: 10,
    parameters: {
      type: "object",
      properties: {},
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: {} },
      presentCall() {
        return { kind: "generic", title: "browser", summary: "tabs" };
      },
      presentationMeta(_args, value) {
        // The listing's counts are its facts; the listing itself stays the
        // generic card's body (a reader scans it).
        const facts = browserFacts(value);
        const tabs = Array.isArray(facts.tabs) ? facts.tabs : [];
        return {
          total: tabs.length,
          active: tabs.filter(
            (tab) =>
              Boolean(tab) &&
              typeof tab === "object" &&
              (tab as { active?: unknown }).active === true,
          ).length,
        };
      },
      presentResult(_args, value, meta) {
        const facts = meta === undefined ? browserFacts(value) : meta;
        const total = typeof facts.total === "number" ? facts.total : 0;
        const active = typeof facts.active === "number" ? facts.active : 0;
        return {
          kind: "generic",
          title: "browser",
          summary: `${total} tab${total === 1 ? "" : "s"} · ${active} active`,
          meta: [
            ["tabs", String(total)],
            ["active", String(active)],
          ],
          body: value,
        };
      },
    },
    async execute(_input, context) {
      return JSON.stringify(
        await browserBridgeCall("tabs", {}, context?.sessionID),
        null,
        2,
      );
    },
  };
}

function browserScanTool(): RuntimeTool {
  return {
    name: "browser_scan",
    description:
      "Scan a browser tab and return simplified page content (text-only by default). tabId is optional; when omitted the active tab is used. At most maxlen characters per stream per call (default 35000); the result reports the page's total lengths and whether it was cut, and offset is where the next page starts.",
    requiresApproval: false,
    timeoutSec: 20,
    parameters: {
      type: "object",
      properties: {
        tabId: { type: ["string", "number"] },
        textOnly: { type: "boolean" },
        maxlen: { type: "number" },
        offset: { type: "number" },
      },
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: {} },
      presentCall(args) {
        return {
          kind: "generic",
          title: optionalString(requireObject(args).url) ?? "browser",
          summary: "scan",
        };
      },
      presentResult: browserCard({ callSummary: "scan" }),
      presentationMeta: browserMeta,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const tabId = optionalTabId(args.tabId);
      return JSON.stringify(
        await browserBridgeCall(
          "scan",
          {
            tabId,
            textOnly: args.textOnly === false ? false : true,
            maxlen: numberOr(args.maxlen, 35000),
            offset: numberOr(args.offset, 0),
          },
          context?.sessionID,
        ),
        null,
        2,
      );
    },
  };
}

function browserExecuteJsTool(): RuntimeTool {
  return {
    name: "browser_execute_js",
    description:
      "Execute JavaScript in a browser tab. tabId is optional; when omitted the active tab is used. Returns the JS result and page diff when available.",
    requiresApproval: true,
    timeoutSec: 30,
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        script: { type: "string" },
      },
      required: ["script"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: {} },
      presentCall(args) {
        return {
          kind: "generic",
          title: optionalString(requireObject(args).url) ?? "browser",
          summary: "execute js",
        };
      },
      presentResult: browserCard({ callSummary: "execute js" }),
      presentationMeta: browserMeta,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const tabId = optionalTabId(args.tabId);
      const script = requireString(args.script, "script");
      return JSON.stringify(
        await browserBridgeCall(
          "execute_js",
          { tabId, script },
          context?.sessionID,
        ),
        null,
        2,
      );
    },
  };
}

function browserNavigateTool(): RuntimeTool {
  return {
    name: "browser_navigate",
    description:
      "Navigate the browser to a URL. tabId is optional; when omitted the current active tab is navigated (no new tab is created). Returns requestedUrl and currentUrl.",
    requiresApproval: true,
    timeoutSec: 20,
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        url: { type: "string" },
      },
      required: ["url"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: {} },
      presentCall(args) {
        return {
          kind: "generic",
          title: optionalString(requireObject(args).url) ?? "browser",
          summary: "navigate",
        };
      },
      presentResult: browserCard({ callSummary: "navigate" }),
      presentationMeta: browserMeta,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const url = requireString(args.url, "url");
      if (!/^https?:\/\//iu.test(url))
        throw new Error("browser_navigate requires http(s) URL");
      assertNetworkURL(url, context);
      const tabId = optionalTabId(args.tabId);
      const result = await browserBridgeCall(
        "navigate",
        { ...(tabId ? { tabId } : {}), url },
        context.sessionID,
      );
      return JSON.stringify(result, null, 2);
    },
  };
}

function browserClickTool(): RuntimeTool {
  return {
    name: "browser_click",
    description:
      "Click at x/y coordinates in a browser tab. tabId is optional; when omitted the active tab is used.",
    requiresApproval: true,
    timeoutSec: 20,
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        x: { type: "number" },
        y: { type: "number" },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: {} },
      presentCall(args) {
        return {
          kind: "generic",
          title: optionalString(requireObject(args).url) ?? "browser",
          summary: "click",
        };
      },
      presentResult: browserCard({ callSummary: "click" }),
      presentationMeta: browserMeta,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const tabId = optionalTabId(args.tabId);
      const x = Number(args.x);
      const y = Number(args.y);
      if (!Number.isInteger(x) || !Number.isInteger(y))
        throw new Error("browser_click x/y must be integers");
      return JSON.stringify(
        await browserBridgeCall("click", { tabId, x, y }, context?.sessionID),
        null,
        2,
      );
    },
  };
}

function browserInputTool(): RuntimeTool {
  return {
    name: "browser_input",
    description:
      "Insert text into the active element of a browser tab. tabId is optional; when omitted the active tab is used.",
    requiresApproval: true,
    timeoutSec: 20,
    parameters: {
      type: "object",
      properties: {
        tabId: { type: "string" },
        text: { type: "string" },
      },
      required: ["text"],
      additionalProperties: false,
    },
    output: {
      schema: { type: "object", properties: {} },
      presentCall(args) {
        return {
          kind: "generic",
          title: optionalString(requireObject(args).url) ?? "browser",
          summary: "input",
        };
      },
      presentResult: browserCard({ callSummary: "input" }),
      presentationMeta: browserMeta,
    },
    async execute(input, context) {
      const args = requireObject(input);
      const tabId = optionalTabId(args.tabId);
      const text = requireString(args.text, "text");
      return JSON.stringify(
        await browserBridgeCall("input", { tabId, text }, context?.sessionID),
        null,
        2,
      );
    },
  };
}

export const browserTools: RuntimeTool[] = [
  browserScreenshotTool(),
  browserOpenTool(),
  browserCloseTool(),
  browserTabsTool(),
  browserScanTool(),
  browserExecuteJsTool(),
  browserNavigateTool(),
  browserClickTool(),
  browserInputTool(),
];

export function browserToolFamily(): ToolFamily {
  return {
    id: "browser",
    name: "Browser Tools",
    version: "1.0.0",
    description:
      "Control the user's existing browser through the Natalia Browser Bridge extension.",
    scope: "session",
    tools: browserTools,
  };
}
