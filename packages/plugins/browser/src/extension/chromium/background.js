// Natalia Browser Bridge extension (Chromium).
// Connects to the local @natalia/browser-bridge server and executes commands
// against the user's existing Chrome/Edge browser.

const BRIDGE_URL = "ws://127.0.0.1:18765";
// The shared page-scan script, injected into a tab before the func that
// calls it. Both engines run the same file (see ../shared/page-scan.js), so
// a page is perceived and acted on identically everywhere.
const PAGE_SCAN_FILE = "shared/page-scan.js";

function normalizeTabId(tabId) {
  if (tabId == null || tabId === "") return undefined;
  const id = Number(tabId);
  return Number.isInteger(id) ? id : undefined;
}

let socket = null;

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
  let [tab] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
  if (!tab) [tab] = await chrome.tabs.query({ active: true });
  if (!tab) {
    const all = await chrome.tabs.query({});
    tab = all.find((item) => item.active) || all[0];
  }
  if (!tab?.id) throw new Error("no active browser tab");
  return tab.id;
}

/**
 * Run the shared page-scan script in the tab, then call into it.
 *
 * The file injection and the call are two executeScript calls in the same
 * isolated world, so the global the file installs is the one the call
 * reads. A page whose CSP refuses inline code is still fine: extension
 * injection is not subject to the page's policy.
 */
async function runInTab(tabId, call, args) {
  const id = await activeTab(tabId);
  await chrome.scripting.executeScript({
    target: { tabId: id },
    files: [PAGE_SCAN_FILE],
  });
  const results = await chrome.scripting.executeScript({
    target: { tabId: id },
    func: call,
    args,
  });
  return results?.[0]?.result;
}

async function scan(tabId, options = {}) {
  const result = await runInTab(
    tabId,
    (scanOptions) => {
      const api = globalThis.NataliaPageScan;
      // A missing global means the injection failed; an empty scan would
      // read as "the page has nothing on it", which is a lie.
      if (!api) throw new Error("page-scan script was not injected");
      return api.scan(document, window, scanOptions);
    },
    [options],
  );
  return result || { text: "", html: "", title: "", url: "" };
}

async function attachDebugger(tabId) {
  const id = await activeTab(tabId);
  try {
    await chrome.debugger.attach({ tabId: id }, "1.3");
  } catch (error) {
    // already attached is fine
  }
  return id;
}

async function detachDebugger(tabId) {
  try {
    await chrome.debugger.detach({ tabId });
  } catch {
    // already detached
  }
}

async function evaluate(expression, tabId) {
  const id = await attachDebugger(tabId);
  try {
    const wrapped = /^\s*return\b/u.test(expression)
      ? `(() => { ${expression} })()`
      : expression;
    const response = await chrome.debugger.sendCommand(
      { tabId: id },
      "Runtime.evaluate",
      { expression: wrapped, returnByValue: true, awaitPromise: true },
    );
    if (response.exceptionDetails) {
      throw new Error(response.exceptionDetails.text || "JS evaluation failed");
    }
    return response.result?.value;
  } finally {
    await detachDebugger(id);
  }
}

async function handle(message) {
  const { action, payload = {} } = message;
  try {
    let result;
    switch (action) {
      case "tabs": {
        const tabs = await chrome.tabs.query({});
        let [active] = await chrome.tabs.query({ active: true, lastFocusedWindow: true });
        if (!active) [active] = await chrome.tabs.query({ active: true });
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
        const tab = await chrome.tabs.create({ url: payload.url || "about:blank" });
        result = { ok: true, tabId: tab.id, url: tab.url };
        break;
      }
      case "close": {
        const id = normalizeTabId(payload.tabId) || await activeTab();
        await chrome.tabs.remove(id);
        result = { ok: true, tabId: id };
        break;
      }
      case "navigate": {
        const id = normalizeTabId(payload.tabId) || await activeTab();
        const targetUrl = new URL(String(payload.url || "")).href;
        await chrome.tabs.update(id, { url: targetUrl });
        let tab = await chrome.tabs.get(id);
        for (let i = 0; i < 50; i += 1) {
          if (tab.status !== "loading" && tab.url === targetUrl) break;
          if (tab.url && tab.url !== "about:blank" && tab.url === targetUrl) break;
          await new Promise((resolve) => setTimeout(resolve, 100));
          tab = await chrome.tabs.get(id);
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
        const results = await chrome.scripting.executeScript({
          target: { tabId: id },
          func: () => document.documentElement.outerHTML,
        });
        result = { text: results[0]?.result || "" };
        break;
      }
      case "execute_js": {
        const beforeTabs = await chrome.tabs.query({});
        const beforeIds = new Set(beforeTabs.map((tab) => tab.id));
        let before = { text: "", title: "", url: "" };
        try {
          before = await scan(payload.tabId, { textOnly: true, maxlen: 20000 });
        } catch {
          before = { text: "", title: "", url: "" };
        }
        const value = await evaluate(String(payload.script || ""), payload.tabId);
        const afterTabs = await chrome.tabs.query({});
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
        result = await runInTab(
          payload.tabId,
          (px, py) => globalThis.NataliaPageScan.clickAt(document, px, py),
          [x, y],
        );
        result = { result, tabId: payload.tabId };
        break;
      }
      case "input": {
        const text = String(payload.text || "");
        // The shared type: the prototype's own value setter plus the input
        // and change events, which a controlled component is wired to.
        result = await runInTab(
          payload.tabId,
          (value) => globalThis.NataliaPageScan.typeIntoActive(document, value),
          [text],
        );
        result = { result, tabId: payload.tabId };
        break;
      }
      case "screenshot": {
        const id = await attachDebugger(payload.tabId);
        try {
          const shot = await chrome.debugger.sendCommand(
            { tabId: id },
            "Page.captureScreenshot",
            { format: "png", fromSurface: true },
          );
          result = { data: `data:image/png;base64,${shot.data}` };
        } finally {
          await detachDebugger(id);
        }
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
