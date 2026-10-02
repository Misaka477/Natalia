import { afterAll, expect, test } from "bun:test";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  CHANNEL_SCHEMA,
  compareVersions,
  resolveChannel,
} from "../src/channel";

/**
 * D5 — the channel contract: local descriptors (usable today), HTTP
 * descriptors (the plan's curl shape) behind a hard bound, and the
 * minimal version comparison that powers up-to-date/downgrade.
 */

const dirs: string[] = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterAll(() => {
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
  for (const server of servers) server.stop(true);
});

function tmp(): string {
  const dir = mkdtempSync(join(tmpdir(), "channel-"));
  dirs.push(dir);
  return dir;
}
const descriptor = (dir: string, body: unknown, name = "channel.json") => {
  const path = join(dir, name);
  writeFileSync(path, JSON.stringify(body));
  return path;
};

test("a local channel resolves its source against its own directory", async () => {
  const dir = tmp();
  mkdirSync(join(dir, "0.2.0"), { recursive: true });
  const path = descriptor(dir, {
    schema: CHANNEL_SCHEMA,
    latest: "0.2.0",
    source: "0.2.0/",
  });
  const resolved = await resolveChannel(path);
  expect(resolved.channel.latest).toBe("0.2.0");
  expect(resolved.source).toBe(join(dir, "0.2.0"));
});

test("bad channels fail with the file named and the reason given", async () => {
  const dir = tmp();
  const wrongSchema = descriptor(dir, {
    schema: "other/9",
    latest: "1.0.0",
    source: "x",
  });
  await expect(resolveChannel(wrongSchema)).rejects.toThrow(
    /channel\.json: channel schema "other\/9"/u,
  );
  const noLatest = descriptor(
    dir,
    { schema: CHANNEL_SCHEMA, source: "x" },
    "thin.json",
  );
  await expect(resolveChannel(noLatest)).rejects.toThrow(
    /thin\.json: channel lacks "latest"/u,
  );
  await expect(resolveChannel(join(dir, "absent.json"))).rejects.toThrow(
    /channel unreadable/u,
  );
  writeFileSync(join(dir, "broken.json"), "{not json");
  await expect(resolveChannel(join(dir, "broken.json"))).rejects.toThrow(
    /not valid JSON/u,
  );
});

// The bound being tested is the channel's own hard timeout
// (CHANNEL_FETCH_TIMEOUT_MS = 15s): the test must outlive it.
test("an HTTP channel resolves absolutely and is hard-bounded", async () => {
  // a channel that answers
  const ok = Bun.serve({
    port: 0,
    fetch: () =>
      Response.json({
        schema: CHANNEL_SCHEMA,
        latest: "3.0.0",
        source: "releases/3.0.0/",
      }),
  });
  servers.push(ok);
  const resolved = await resolveChannel(
    `http://127.0.0.1:${ok.port}/channels/stable/channel.json`,
  );
  expect(resolved.channel.latest).toBe("3.0.0");
  expect(resolved.source).toBe(
    `http://127.0.0.1:${ok.port}/channels/stable/releases/3.0.0/`,
  );

  // a socket that accepts and never answers — the bound must fail it
  const hang = Bun.serve({
    port: 0,
    fetch: () => new Promise<Response>(() => undefined),
  });
  servers.push(hang);
  const started = Date.now();
  await expect(
    resolveChannel(`http://127.0.0.1:${hang.port}/channel.json`),
  ).rejects.toThrow();
  const elapsed = Date.now() - started;
  expect(elapsed).toBeLessThan(20_000); // bounded, not hung
}, 30_000);

test("compareVersions: the two shapes we ship, honestly ordered", () => {
  expect(compareVersions("0.0.0-m14", "0.0.0-m13")).toBeGreaterThan(0);
  expect(compareVersions("0.0.0-m13", "0.0.0-m14")).toBeLessThan(0);
  expect(compareVersions("0.0.0-m13", "0.0.0-m13")).toBe(0);
  expect(compareVersions("1.2.3", "1.2.2")).toBeGreaterThan(0);
  expect(compareVersions("1.2.3", "2.0.0")).toBeLessThan(0);
  // a release ranks above its own prerelease (semver's rule)
  expect(compareVersions("1.0.0", "1.0.0-rc1")).toBeGreaterThan(0);
  expect(() => compareVersions("banana", "1.0.0")).toThrow(/unrecognised/u);
});
