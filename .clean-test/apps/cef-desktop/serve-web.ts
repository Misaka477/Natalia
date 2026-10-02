import { resolve } from "node:path";
import { serve } from "bun";

const root = resolve(import.meta.dir, "../../apps/web/dist");
const port = Number(process.env.NATALIA_WEB_PORT ?? 5178);

const indexFile = resolve(root, "index.html");

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
          "cache-control": "no-cache",
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
          "cache-control": "no-cache",
        },
      });
    }

    return new Response("not found", { status: 404 });
  },
});

console.log(`[cef-web] serving ${root} on http://127.0.0.1:${port}`);
