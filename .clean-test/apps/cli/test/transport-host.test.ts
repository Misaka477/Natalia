import { expect, test } from "bun:test";
import type { RuntimeClient } from "@anthelia/contracts";
import { createHttpTransportHost } from "../src/transport-host";
import { parseServePort } from "../src/runtime-commands";

const client = {} as RuntimeClient;

test("serve command parses positional ports in both command forms", () => {
  expect(parseServePort(["serve", "9000"])).toBe(9000);
  expect(parseServePort(["--serve", "9000"])).toBe(9000);
  expect(parseServePort(["serve"])).toBe(8787);
});

test("transport host owns the HTTP server lifecycle", async () => {
  const host = createHttpTransportHost({
    client,
    port: 0,
    events: false,
  });
  const url = host.server.url.toString();
  expect(
    await fetch(`${url}/healthz`).then((response) => response.json()),
  ).toEqual({ ok: true, apiVersion: 1 });

  await host.close();
  await host.close();
  const stoppedURL = new URL(url);
  const rebound = Bun.serve({
    hostname: stoppedURL.hostname,
    port: Number(stoppedURL.port),
    fetch: () => new Response("rebound"),
  });
  expect(rebound.port).toBe(Number(stoppedURL.port));
  rebound.stop(true);
});
