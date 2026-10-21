/**
 * The page is told which runtime to call, and with what token.
 *
 * The 浏览 button did nothing because the shell's runtime client was built
 * against a hardcoded `http://127.0.0.1:8790` with no token. Measured against a
 * live daemon: a bare POST to /rpc answers `401 unauthorized`, and the daemon
 * itself binds 8787 — so the page could neither reach the runtime nor authorize
 * against it. A browser cannot discover either fact, so the server that serves
 * the page injects them.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// test -> web -> apps -> repo root
const repoRoot = join(import.meta.dir, "..", "..", "..");

function source(relative: string): string {
  return readFileSync(join(repoRoot, relative), "utf8");
}

const shell = source("apps/web/src/main-neu.ts");
const serveWeb = source("apps/cli/src/serve-web.ts");
const runtimeCommands = source("apps/cli/src/runtime-commands.ts");

test("the shell reads the runtime endpoint instead of hardcoding a port", () => {
  // The old default was 8790; the daemon binds 8787 and `start-app` puts the
  // runtime wherever it got a free port. A hardcoded value is the bug.
  expect(shell).toContain("__NATALIA_RUNTIME__");
  expect(shell).toContain("runtimeToken");
  expect(shell).not.toMatch(
    /VITE_NATALIA_RUNTIME_URL\s*\|\|\s*"http:\/\/127\.0\.0\.1:8790"/u,
  );
});

test("the shell sends the token it was given", () => {
  expect(shell).toMatch(/token:\s*runtimeToken/u);
});

test("the web server injects the endpoint into the HTML it serves", () => {
  expect(serveWeb).toContain("window.__NATALIA_RUNTIME__");
  expect(serveWeb).toContain("options.bootstrap");
});

test("the runtime publishes its endpoint where the web server reads it", () => {
  expect(runtimeCommands).toContain("runtime-endpoint.json");
  // Written by `serve`, read by `serve-web`: one file, two readers.
  expect(runtimeCommands).toContain("transport.server.url");
  expect(runtimeCommands).toContain("bootstrap");
});
