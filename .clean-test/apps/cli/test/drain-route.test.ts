import { expect, test } from "bun:test";
import type { RuntimeClient } from "@anthelia/contracts";
import { createHttpTransportHost } from "../src/transport-host";

/**
 * D3b step 1 over the wire: `daemon.drain` dispatches to the surface
 * member with its parsed params (the row↔block scanners cover the
 * table/shape pairing; this covers the live round trip the update
 * orchestrator will make).
 */

test("daemon.drain round-trips params to the surface and validates bad ones", async () => {
  const seen: unknown[] = [];
  const client = {
    drainForUpdate: async (input?: { timeoutMs?: number }) => {
      seen.push(input);
      return { waitedMs: 7 };
    },
  } as unknown as RuntimeClient;
  const host = createHttpTransportHost({
    client,
    port: 0,
    events: false,
    token: "test-token",
  });
  const url = host.server.url.toString();
  try {
    const rpcUrl = `${url}/rpc`;
    const ok = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "daemon.drain",
        params: { timeoutMs: 500 },
      }),
    }).then((response) => response.json());
    expect(ok.result).toEqual({ waitedMs: 7 });
    expect(seen).toEqual([{ timeoutMs: 500 }]);

    const bad = await fetch(rpcUrl, {
      method: "POST",
      headers: {
        "content-type": "application/json",
        authorization: "Bearer test-token",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 2,
        method: "daemon.drain",
        params: { timeoutMs: "soon" },
      }),
    }).then((response) => response.json());
    expect(String(bad.error?.message)).toContain("timeoutMs");
  } finally {
    await host.close();
  }
});
