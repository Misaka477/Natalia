/**
 * The event stream must outlive silence.
 *
 * Bun's `idleTimeout` is measured on INCOMING bytes, so the SSE keepalive the
 * server writes does not keep the connection alive, and a front-end subscribed
 * to `/events` sends nothing at all. With the value this used to carry — 255,
 * Bun's maximum — a subscription was cut every 255 seconds regardless of the
 * heartbeat; a browser reports that cut as ERR_INCOMPLETE_CHUNKED_ENCODING and
 * the client reconnects into a UI that looks like it lost its stream.
 *
 * The reproduction is `.btmp/probe-idle-timeout.ts`, outside the product: a
 * server with `idleTimeout: 3` and a 1-second heartbeat, and a client that only
 * reads. Three heartbeats were delivered, and the socket was closed anyway —
 *
 *   PROBE chunk 4 at +3008ms  ": ping"
 *   PROBE stream ended at +4006ms — read rejected: TypeError: The socket
 *   connection was closed unexpectedly.
 *
 * — while the same stream with `idleTimeout: 0` ran past the whole 12-second
 * window. A behavioural test cannot distinguish the two values without waiting
 * the real 255 seconds, so this pins the value itself and names the file to
 * re-measure with.
 */
import { expect, test } from "bun:test";
import { SSE_IDLE_TIMEOUT_SECONDS } from "../src/host";

test("the SSE connection is not cut by an incoming-silence timeout", () => {
  expect(SSE_IDLE_TIMEOUT_SECONDS).toBe(0);
});

test("the keepalive stays well inside the client's tolerance", async () => {
  const source = await Bun.file(
    new URL("../src/http.ts", import.meta.url),
  ).text();
  const heartbeat = Number(
    source.match(/SSE_HEARTBEAT_MS = ([\d_]+)/u)?.[1]?.replaceAll("_", ""),
  );
  expect(Number.isFinite(heartbeat)).toBe(true);
  // dsh pings on the same order and terminates a stream after two missed
  // pings; a keepalive slower than that would let a half-open connection sit
  // unnoticed for minutes.
  expect(heartbeat).toBeLessThanOrEqual(15_000);
  // And every write to a subscriber goes through the one guarded writer, so a
  // dead front-end cannot throw into the runtime's publish path or stay in the
  // fanout for the rest of the session.
  expect(source).toContain("subscriber.controller.enqueue(bytes)");
  expect(source).not.toMatch(/controller\?\.enqueue/u);
});
