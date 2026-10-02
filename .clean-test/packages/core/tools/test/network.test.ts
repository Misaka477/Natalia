import { expect, test } from "bun:test";
import { assertNetworkURL } from "../src";
import type { ToolExecutionContext } from "../src";

function ctx(settings: ToolExecutionContext["settings"]): ToolExecutionContext {
  return { workspaceRoot: "/ws", settings };
}

const strict = { allowLocalhost: false, allowPrivate: false };

test("assertNetworkURL allows public http(s) hosts, IPv4 and IPv6", () => {
  expect(() =>
    assertNetworkURL("https://example.com/a", ctx({})),
  ).not.toThrow();
  expect(() => assertNetworkURL("https://8.8.8.8/", ctx({}))).not.toThrow();
  expect(() =>
    assertNetworkURL("https://[2606:4700::1111]/", ctx({})),
  ).not.toThrow();
});

test("assertNetworkURL blocks loopback and private on both IPv4 and IPv6", () => {
  // The IPv6 cases are the point: Node serializes IPv6 hostnames bracketed
  // ([::1]), so a `host === "::1"` check never fires, and an IPv4-only private
  // regex misses fc00::/7 and fe80::/10 — an SSRF bypass when a caller opts out
  // of localhost/private access.
  for (const url of [
    "http://127.0.0.1/",
    "http://10.0.0.5/",
    "http://192.168.1.1/",
    "http://172.16.0.1/",
    "http://[::1]/", // IPv6 loopback
    "http://[fd00::1]/", // IPv6 unique-local fc00::/7
    "http://[fd12:3456::1]/", // IPv6 unique-local (fd..)
    "http://[fe80::1]/", // IPv6 link-local fe80::/10
  ])
    expect(() => assertNetworkURL(url, ctx(strict)), url).toThrow(
      /not allowed/,
    );
});

test("assertNetworkURL permits loopback/private unless explicitly disallowed", () => {
  // Default (unset) allows them; only an explicit false blocks.
  expect(() => assertNetworkURL("http://127.0.0.1/", ctx({}))).not.toThrow();
  expect(() => assertNetworkURL("http://[::1]/", ctx({}))).not.toThrow();
});

test("assertNetworkURL enforces scheme and denied-host rules", () => {
  expect(() => assertNetworkURL("ftp://example.com/", ctx({}))).toThrow(
    /scheme is not allowed/,
  );
  expect(() =>
    assertNetworkURL("https://evil.com/", ctx({ deniedHosts: ["evil.com"] })),
  ).toThrow(/host denied/);
});
