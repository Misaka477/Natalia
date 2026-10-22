// Natalia Browser Bridge extension (Firefox).
// Connects to the local @natalia/browser-bridge server and executes commands
// against the user's existing Firefox browser.

const BRIDGE_URL = "ws://127.0.0.1:18765";
// The shared page-scan script. Both engines run the same file (see
// ../shared/page-scan.js): a page is perceived and acted on identically
// everywhere. Chromium injects it through scripting.executeScript; Firefox
// has no per-call file injection with arguments, so the source is fetched
// once and concatenated with the call.
const PAGE_SCAN_URL = "shared/page-scan.js";

let socket = null;
let pageScanSource = undefined;

/** The shared page-scan source, fetched from the extension and cached. */
function loadPageScanSource() {
  pageScanSource ??= (async () => {
    const response = await fetch(browser.runtime.getURL(PAGE_SCAN_URL));
    if (!response.ok) throw new Error(`page-scan source fetch failed: ${response.status}`);
    return response.text();
  })();
  return pageScanSource;
}

function normalizeTabId(tabId) {
  if (tabId == null || tabId === "") return undefined;
  const id = Number(tabId);
  return Number.isInteger(id) ? id : undefined;
}

function connect() {
  try {
    socket = new WebSocket(BRIDGE_URL);
    socket.onopen = () => console.log("[natalia-browser-bridge] connected");
    socket.onmessage = (event) => {
      let message;
      try {
        message = JSON.parse(event.data);
      } catch {
        return;
      }
      void handle(message);
    };
    socket.onclose = () => {
      socket = null;
      setTimeout(connect, 1000);
    };
    socket.onerror = () => {
      socket?.close();
    };
  } catch (error) {
    console.error("[natalia-browser-bridge] connect failed", error);
    setTimeout(connect, 1000);
  }
}

function respond(message, result, error) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ id: message.id, result, error }));
}

async function activeTab(tabId) {
  const normalized = normalizeTabId(tabId);
  if (normalized) return normalized;
  let [tab] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await browser.tabs.query({ active: true });
  if (!tab) {
    const all = await browser.tabs.query({});
    tab = all.find((item) => item.active) || all[0];
  }
  if (!tab?.id) throw new Error("no active browser tab");
  return tab.id;
}

/**
 * Run the shared page-scan call in the tab.
 *
 * The source and the call are concatenated into one script so the global
 * the file installs is the one the call reads, with no dependence on state
 * surviving between two injections.
 */
async function runInTab(tabId, callSource) {
  const id = await activeTab(tabId);
  const source = await loadPageScanSource();
  const results = await browser.tabs.executeScript(id, {
    code: `${source}\n;(${callSource})();`,
  });
  return results?.[0];
}

async function scan(tabId, options = {}) {
  const result = await runInTab(
    tabId,
    `function () {
      const api = globalThis.NataliaPageScan;
      // A missing global means the injection failed; an empty scan would
      // read as "the page has nothing on it", which is a lie.
      if (!api) throw new Error("page-scan script was not injected");
      return api.scan(document, window, ${JSON.stringify(options)});
    }`,
  );
  return result || { text: "", html: "", title: "", url: "" };
}

async function handle(message) {
  const { action, payload = {} } = message;
  try {
    let result;
    switch (action) {
      case "tabs": {
        const tabs = await browser.tabs.query({});
        let [active] = await browser.tabs.query({ active: true, lastFocusedWindow: true });
        if (!active) [active] = await browser.tabs.query({ active: true });
        if (!active) active = tabs.find((tab) => tab.active) || tabs[0];
        result = {
          activeId: active?.id,
          tabs: tabs.map((tab) => ({
            id: tab.id,
            url: tab.url,
            title: tab.title,
            active: tab.id === active?.id,
          })),
        };
        break;
      }
      case "open": {
        const tab = await browser.tabs.create({ url: payload.url || "about:blank" });
        result = { ok: true, tabId: tab.id, url: tab.url };
        break;
      }
      case "close": {
        const id = normalizeTabId(payload.tabId) || await activeTab();
        await browser.tabs.remove(id);
        result = { ok: true, tabId: id };
        break;
      }
      case "navigate": {
        const id = normalizeTabId(payload.tabId) || await activeTab();
        const targetUrl = new URL(String(payload.url || "")).href;
        await browser.tabs.update(id, { url: targetUrl });
        let tab = await browser.tabs.get(id);
        for (let i = 0; i < 50; i += 1) {
          if (tab.url && tab.url === targetUrl) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
          tab = await browser.tabs.get(id);
        }
        result = {
          ok: true,
          tabId: tab.id,
          requestedUrl: targetUrl,
          currentUrl: tab.url,
        };
        break;
      }
      case "scan": {
        result = await scan(payload.tabId, {
          textOnly: payload.textOnly !== false,
          maxlen: Number(payload.maxlen) || 35000,
          offset: Number(payload.offset) || 0,
        });
        break;
      }
      case "read": {
        const id = await activeTab(payload.tabId);
        const results = await browser.tabs.executeScript(id, {
          code: "document.documentElement.outerHTML",
        });
        result = { text: results[0] || "" };
        break;
      }
      case "execute_js": {
        const beforeTabs = await browser.tabs.query({});
        const beforeIds = new Set(beforeTabs.map((tab) => tab.id));
        let before = { text: "", title: "", url: "" };
        try {
          before = await scan(payload.tabId, { textOnly: true, maxlen: 20000 });
        } catch {
          before = { text: "", title: "", url: "" };
        }
        const scriptTabId = await activeTab(payload.tabId);
        const results = await browser.tabs.executeScript(scriptTabId, {
          code: String(payload.script || ""),
        });
        const value = results[0];
        const afterTabs = await browser.tabs.query({});
        const newTabs = afterTabs
          .filter((tab) => !beforeIds.has(tab.id))
          .map((tab) => ({ id: tab.id, url: tab.url }));
        let after = { text: "", title: "", url: "" };
        try {
          after = await scan(payload.tabId, { textOnly: true, maxlen: 20000 });
        } catch {
          after = { text: "", title: "", url: "" };
        }
        const beforeText = before.text || "";
        const afterText = after.text || "";
        let topChange = "";
        let changed = beforeText !== afterText || before.title !== after.title || before.url !== after.url;
        if (before.title !== after.title) {
          topChange = `title: ${before.title} -> ${after.title}`;
        } else if (before.url !== after.url) {
          topChange = `url: ${before.url} -> ${after.url}`;
        } else if (beforeText !== afterText) {
          const beforeLines = beforeText.split("\n");
          const afterLines = afterText.split("\n");
          const limit = Math.min(beforeLines.length, afterLines.length, 200);
          for (let i = 0; i < limit; i += 1) {
            if (beforeLines[i] !== afterLines[i]) {
              topChange = `line ${i + 1}: ${String(afterLines[i]).slice(0, 120)}`;
              break;
            }
          }
          if (!topChange) {
            topChange =
              beforeLines.length !== afterLines.length
                ? `line count changed ${beforeLines.length} -> ${afterLines.length}`
                : "content changed";
          }
        }
        const active = await activeTab(payload.tabId);
        result = {
          result: value,
          tabId: active,
          diff: {
            changed,
            beforeLength: beforeText.length + before.title.length + before.url.length,
            afterLength: afterText.length + after.title.length + after.url.length,
            topChange,
          },
          newTabs,
        };
        break;
      }
      case "click": {
        const x = Number(payload.x);
        const y = Number(payload.y);
        // The shared click: the full pointer sequence plus a description of
        // what was hit, so the caller learns whether the coordinates named
        // the element it meant to hit.
        const clicked = await runInTab(
          payload.tabId,
          `function () {
            const api = globalThis.NataliaPageScan;
            if (!api) throw new Error("page-scan script was not injected");
            return api.clickAt(document, ${x}, ${y});
          }`,
        );
        result = { result: clicked, tabId: payload.tabId };
        break;
      }
      case "input": {
        const text = String(payload.text || "");
        // The shared type: the prototype's own value setter plus the input
        // and change events, which a controlled component is wired to.
        const typed = await runInTab(
          payload.tabId,
          `function () {
            const api = globalThis.NataliaPageScan;
            if (!api) throw new Error("page-scan script was not injected");
            return api.typeIntoActive(document, ${JSON.stringify(text)});
          }`,
        );
        result = { result: typed, tabId: payload.tabId };
        break;
      }
      case "screenshot": {
        const id = await activeTab(payload.tabId);
        const dataUrl = await browser.tabs.captureVisibleTab(id, { format: "png" });
        result = { data: dataUrl };
        break;
      }
      default:
        throw new Error(`unknown browser action: ${action}`);
    }
    respond(message, result);
  } catch (error) {
    respond(message, undefined, error instanceof Error ? error.message : String(error));
  }
}

connect();
