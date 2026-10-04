import { stat } from "node:fs/promises";
import { extname, join, normalize, resolve, sep } from "node:path";

/**
 * Serve a directory over HTTP — the release's own static file server.
 *
 * The dev flow has `apps/cef-desktop/serve-web.ts`, which resolves
 * `../../apps/web/dist`: a REPO-relative path. An installed copy has no repo, so
 * the web shell it ships (`<install>/web`) had nothing to serve it and the CEF
 * window loaded a URL with no listener behind it. This is the same job, pointed
 * at a directory the caller names, living in the CLI so every release carries it.
 */
export type StaticServeOptions = {
  /** The directory to serve. */
  root: string;
  /** The port; 0 picks a free one and reports it. */
  port?: number;
  hostname?: string;
};

const CONTENT_TYPES: Record<string, string> = {
  ".html": "text/html; charset=utf-8",
  ".js": "text/javascript; charset=utf-8",
  ".mjs": "text/javascript; charset=utf-8",
  ".css": "text/css; charset=utf-8",
  ".json": "application/json; charset=utf-8",
  ".map": "application/json; charset=utf-8",
  ".svg": "image/svg+xml",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".jpeg": "image/jpeg",
  ".gif": "image/gif",
  ".webp": "image/webp",
  ".ico": "image/x-icon",
  ".wasm": "application/wasm",
  ".woff": "font/woff",
  ".woff2": "font/woff2",
  ".ttf": "font/ttf",
  ".txt": "text/plain; charset=utf-8",
};

/** Resolve a URL path to a file inside root, refusing anything that escapes it. */ async function resolveWithin(
  root: string,
  urlPath: string,
) {
  const decoded = decodeURIComponent(urlPath.split("?")[0] ?? "/");
  const relative = normalize(decoded.replace(/^[/\\]+/u, ""));
  const target = resolve(join(root, relative));
  // The containment check, done on the RESOLVED paths: `..` segments and
  // absolute-looking inputs are normalized away first, so the comparison is
  // against the real location rather than the spelling.
  if (target !== resolve(root) && !target.startsWith(resolve(root) + sep))
    return undefined;
  const hit = await stat(target).catch(() => undefined);
  if (hit?.isFile()) return target;
  // A directory serves its index.html — a SPA's deep link has no file.
  const index = join(target, "index.html");
  const fallback = await stat(index).catch(() => undefined);
  return fallback?.isFile() ? index : undefined;
}

export async function serveStaticDirectory(
  options: StaticServeOptions,
): Promise<{ url: string; port: number; stop(): void }> {
  const root = resolve(options.root);
  const server = Bun.serve({
    port: options.port ?? 0,
    hostname: options.hostname ?? "127.0.0.1",
    async fetch(request) {
      const path = new URL(request.url).pathname;
      const file = await resolveWithin(root, path);
      if (!file) return new Response("not found", { status: 404 });
      return new Response(Bun.file(file), {
        headers: {
          "content-type":
            CONTENT_TYPES[extname(file).toLowerCase()] ??
            "application/octet-stream",
          // A shipped asset never changes under a running app, so it can be
          // cached hard; the HTML is revalidated so a rebuild is picked up.
          "cache-control":
            extname(file).toLowerCase() === ".html"
              ? "no-cache"
              : "public, max-age=31536000, immutable",
        },
      });
    },
  });
  return {
    url: `http://127.0.0.1:${server.port ?? options.port ?? 0}/`,
    port: server.port ?? options.port ?? 0,
    stop: () => server.stop(true),
  };
}
