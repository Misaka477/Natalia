// Natalia Browser Bridge extension (Firefox/WebExtension).
// Mirrors the Chromium adapter capabilities using the browser.* API.

const BRIDGE_URL = "ws://127.0.0.1:18765";
let socket = null;

function connect() {
  try {
    socket = new WebSocket(BRIDGE_URL);
    socket.onopen = () => console.log("[natalia-browser-bridge] firefox connected");
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
    socket.onerror = () => socket?.close();
  } catch (error) {
    console.error("[natalia-browser-bridge] firefox connect failed", error);
    setTimeout(connect, 1000);
  }
}

function respond(message, result, error) {
  if (!socket || socket.readyState !== WebSocket.OPEN) return;
  socket.send(JSON.stringify({ id: message.id, result, error }));
}

function normalizeTabId(tabId) {
  if (tabId == null || tabId === "") return undefined;
  const id = Number(tabId);
  return Number.isInteger(id) ? id : undefined;
}

async function activeTab(tabId) {
  const normalized = normalizeTabId(tabId);
  if (normalized) return normalized;
  let [tab] = await browser.tabs.query({ active: true, currentWindow: true });
  if (!tab) {
    const all = await browser.tabs.query({});
    tab = all.find((item) => item.active) || all[0];
  }
  if (!tab?.id) throw new Error("no active browser tab");
  return tab.id;
}

async function execute(tabId, code) {
  const id = await activeTab(tabId);
  const results = await browser.tabs.executeScript(id, { code });
  return results?.[0];
}

async function handle(message) {
  const { action, payload = {} } = message;
  try {
    let result;
    switch (action) {
      case "tabs": {
        const tabs = await browser.tabs.query({});
        const active = tabs.find((tab) => tab.active) || tabs[0];
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
        await new Promise((resolve) => setTimeout(resolve, 1500));
        const tab = await browser.tabs.get(id);
        result = { ok: true, tabId: tab.id, requestedUrl: targetUrl, currentUrl: tab.url };
        break;
      }
      case "scan": {
        const id = await activeTab(payload.tabId);
        const offset = Number(payload.offset) || 0;
        const maxlen = Number(payload.maxlen) || 35000;
        const value = await execute(id, `(() => {
          const text = document.body?.innerText || "";
          const html = document.body?.innerHTML || "";
          return {
            text: text.slice(${offset}, ${offset + maxlen}),
            html: html.slice(${offset}, ${offset + maxlen}),
            totalTextLength: text.length,
            totalHtmlLength: html.length,
            offset: ${offset},
            maxlen: ${maxlen},
            title: document.title,
            url: location.href,
            truncated: (${offset + maxlen}) < text.length || (${offset + maxlen}) < html.length,
          };
        })()`);
        result = value || { text: "", html: "", title: "", url: "" };
        break;
      }
      case "read": {
        const id = await activeTab(payload.tabId);
        result = { text: await execute(id, "document.documentElement.outerHTML") };
        break;
      }
      case "execute_js": {
        const id = await activeTab(payload.tabId);
        const code = String(payload.script || "");
        const value = await execute(id, code);
        result = { result: value, tabId: id };
        break;
      }
      case "click": {
        const id = await activeTab(payload.tabId);
        const x = Number(payload.x);
        const y = Number(payload.y);
        result = await execute(id, `(() => { const el = document.elementFromPoint(${x},${y}); if (el) { el.click(); return "ok"; } return "no_element"; })()`);
        result = { result, tabId: id };
        break;
      }
      case "input": {
        const id = await activeTab(payload.tabId);
        const text = JSON.stringify(String(payload.text || ""));
        result = await execute(id, `(() => { const el = document.activeElement; if (!el) return "no_active"; if (el.value !== undefined) el.value = ${text}; el.dispatchEvent(new Event("input", {bubbles:true})); return "ok"; })()`);
        result = { result, tabId: id };
        break;
      }
      case "screenshot": {
        const id = await activeTab(payload.tabId);
        const dataUrl = await browser.tabs.captureTab(id);
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
