---
name: browser-bridge-setup
description: Use when any browser_* tool fails with an extension-not-connected, bridge-unreachable or 5xx error, or a scan that returns nothing — the setup and recovery path for the Natalia Browser Bridge extension. Also use before the first browser_* call in a new environment, and when a page scan comes back empty or suspiciously short.
---

# Browser Bridge setup and recovery

The `browser_*` tools drive the user's real browser through a local bridge
server (port 18765) plus the Natalia Browser Bridge extension. Two layers
must both be up: the bridge process (started by the plugin on first use,
or by the Natalia Desktop app) and the extension loaded in the browser.
An error message names which layer is down — read it before acting.

## Loading the extension (the setup path)

Current Chrome and Edge no longer auto-load unpacked extensions from the
Windows registry, so the user loads it once by hand:

1. Open `chrome://extensions` (Edge: `edge://extensions`).
2. Turn on **Developer mode**.
3. Click **Load unpacked** and choose the extension directory named in the
   error message. It is `<install>/plugins/natalia-browser/extension/chromium`
   on an installed copy, or
   `packages/plugins/browser/src/extension/chromium` in a checkout.
4. The listing may show an **"error" badge** until the bridge is running.
   That badge is expected — it means "cannot reach ws://127.0.0.1:18765",
   not "broken extension". Do not ask the user to fix it.
5. Open any normal page (`https://example.com`), then call `browser_scan`.

A freshly loaded extension with no page open answers `browser_scan` with
"no active browser tab" — that is a page problem, not a bridge problem.

Firefox: `about:debugging#/runtime/this-firefox` → Load Temporary Add-on →
pick `extension/firefox/manifest.json`. A temporary add-on does not survive
a browser restart, so repeat it after one.

## When a call fails, read the layer

- `bridgeServer=down` — nothing answered on the bridge URL. Start the
  Natalia Desktop app (its bridge runs inside it), or set
  `NATALIA_BROWSER_BRIDGE_URL` to a running bridge.
- `bridgeServer=up, extension=disconnected` — the bridge is healthy, the
  extension is not connected. Walk the setup path above.
- `bridgeServer=up, extension=connected` — the page itself refused (a
  `chrome://` page, a closed tab, a cross-origin frame). Fix the target,
  not the bridge.
- A 4xx is the bridge's own answer (unknown action, bad input): fix the
  arguments. Retrying will not help.

If the extension truly will not connect, check in this order and stop at
the first failure: (1) is a browser process running at all; (2) is the
bridge listening (`GET http://127.0.0.1:18765/healthz` answers with
`{"ok":true,"extensions":N}`); (3) does the browser's `Secure Preferences`
file contain an entry for the extension id (a load that silently failed
never writes one); (4) ask the user to reload the extension from
`chrome://extensions`. Never start a second bridge — port 18765 has one
owner.

## Reading a scan

`browser_scan` returns a perception of the page, not a dump:

- interactive elements arrive as markers: `[button "Save"]`,
  `[input name=q type=text "search"]`, `[a href=... "text"]`;
- invisible nodes (display:none, zero-size, opacity 0) and fully covered
  siblings are dropped, and the result reports how many were hidden;
- long repeated lists collapse to three items plus a
  `[FAKE ELEMENT] N more items hidden, selector: "..."` line — use
  `browser_execute_js` with that selector when you need the rest;
- `textOnly` defaults to true; pass `false` for the simplified HTML;
- `totalTextLength`/`totalHtmlLength` plus `truncated` describe the whole
  page, and `offset` is where the next call continues. Page through with
  the same `maxlen` and a growing `offset`.

Rules that came from measurement:

- A first scan of a just-navigated page can be empty or partial. Wait
  briefly and scan again; never conclude "the page has nothing" from one
  empty scan.
- `browser_click` returns what was hit at those coordinates. If the
  description is not the element you meant, re-scan — the page moved
  under you (an infobar, a reflow, a cookie banner).
- `browser_execute_js` returns the page diff (what changed, new tabs,
  whether the navigation destroyed the context). Read it before scanning
  again.
