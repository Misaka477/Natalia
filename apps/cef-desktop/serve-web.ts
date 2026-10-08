import { resolve } from "node:path";
import { serve } from "bun";

const root = resolve(import.meta.dir, "../../apps/web/dist");
const port = Number(process.env.NATALIA_WEB_PORT ?? 5178);

const indexFile = resolve(root, "index.html");

/**
 * The cache policy for a served path.
 *
 * The 2026-10-08 stale-bundle hunt's root cause: this server sent
 * `cache-control: no-cache` WITHOUT a validator (no ETag, no
 * Last-Modified). Per HTTP, `no-cache` means "revalidate before reuse" —
 * with nothing to revalidate AGAINST, Chromium kept serving its disk-cached
 * copy, so every app restart and every reload rendered the PREVIOUS build
 * (the user's "你根本没改" across a day of fixes, and a one-step lag on
 * every reload). The policy is now the standard SPA one:
 *
 *   - the HTML entry is `no-store`: every load fetches the current
 *     index.html, which names the current content-hashed bundle;
 *   - the hashed assets are `immutable`: a new build is a new URL, so a
 *     long cache is both safe and instant on the next launch.
 */
function cacheControlFor(pathname: string): string {
  if (pathname.endsWith(".html") || !pathname.includes("."))
    return "no-store, must-revalidate";
  return "public, max-age=31536000, immutable";
}

function contentTypeFor(pathname: string): string {
  if (pathname.endsWith(".html")) return "text/html; charset=utf-8";
  if (pathname.endsWith(".js")) return "application/javascript; charset=utf-8";
  if (pathname.endsWith(".css")) return "text/css; charset=utf-8";
  if (pathname.endsWith(".svg")) return "image/svg+xml";
  if (pathname.endsWith(".wasm")) return "application/wasm";
  if (pathname.endsWith(".json")) return "application/json";
  return "application/octet-stream";
}

serve({
  port,
  async fetch(request) {
    const url = new URL(request.url);
    let pathname = decodeURIComponent(url.pathname);
    if (pathname === "/") pathname = "/index.html";
    const filePath = resolve(root, pathname.slice(1));

    if (!filePath.startsWith(root)) {
      return new Response("forbidden", { status: 403 });
    }

    const perfProbe = [
      process.env.NATALIA_PERF_VERBOSE === "1"
        ? "<script>window.__NATALIA_PERF_VERBOSE=1</script>"
        : "",
      process.env.NATALIA_MEMORY_TRACE === "1"
        ? "<script>window.__NATALIA_MEMORY_TRACE=1</script>"
        : "",
    ].join("");

    const file = Bun.file(filePath);
    if (await file.exists()) {
      let body = await file.text();
      if (pathname.endsWith(".html") && perfProbe) {
        body = body.replace("</body>", `${perfProbe}</body>`);
      }
      return new Response(body, {
        headers: {
          "access-control-allow-origin": "*",
          "cache-control": cacheControlFor(pathname),
          "content-type": contentTypeFor(pathname),
        },
      });
    }

    // SPA fallback
    const index = Bun.file(indexFile);
    if (await index.exists()) {
      let body = await index.text();
      if (perfProbe) body = body.replace("</body>", `${perfProbe}</body>`);
      return new Response(body, {
        headers: {
          "access-control-allow-origin": "*",
          "content-type": "text/html; charset=utf-8",
          "cache-control": "no-store, must-revalidate",
        },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`[cef-web] serving ${root} on http://127.0.0.1:${port}`);
