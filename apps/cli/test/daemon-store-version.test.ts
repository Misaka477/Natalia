import { expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createRuntimeDaemonStore,
  registerRuntimeDaemon,
  runtimeDaemonStatus,
} from "@natalia/transport/host";
import { daemonStore } from "../src/command-helpers";
import { NATALIA_VERSION } from "../src/version";

/**
 * The daemon registration's `version` is not decoration: `runtimeDaemonStatus`
 * compares it with the asking build's version to answer `incompatible`, which is
 * how an app that was upgraded underneath a live daemon learns not to keep
 * talking to the old one.
 *
 * Every CLI caller used to omit the version, so the transport's TS build marker
 * (`0.0.0-ts7`) was written AND compared on both sides — the shipped 0.0.0-m13
 * binary registered itself as `0.0.0-ts7` (measured on the installed build,
 * 2026-10-18) and the comparison could never fire.
 */
test("the CLI's daemon store carries the real build version, not the TS marker", () => {
  expect(daemonStore().version).toBe(NATALIA_VERSION);
  expect(daemonStore().version).not.toBe("0.0.0-ts7");
  // The dev run resolves the repo's package.json; a release bakes the same
  // value into the binary (version.test.ts pins the precedence order).
  expect(NATALIA_VERSION).toMatch(/^\d+\.\d+\.\d+/u);
});

test("a registration written by this store is readable as this build's", async () => {
  const dir = await mkdtemp(join(tmpdir(), "natalia-daemon-version-"));
  try {
    const store = daemonStore(dir);
    await registerRuntimeDaemon(store, {
      url: "http://127.0.0.1:8787",
      pid: process.pid,
      transport: "http",
    });
    const status = await runtimeDaemonStatus(daemonStore(dir));
    // A live registration from THIS build is `running`, never `incompatible`.
    expect(status.state).toBe("running");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a registration from another build is incompatible, which is the point of the field", async () => {
  const dir = await mkdtemp(join(tmpdir(), "natalia-daemon-version-stale-"));
  try {
    const other = createRuntimeDaemonStore({ dir, version: "0.0.0-ts7" });
    await registerRuntimeDaemon(other, {
      url: "http://127.0.0.1:8787",
      pid: process.pid,
      transport: "http",
    });
    const status = await runtimeDaemonStatus(daemonStore(dir));
    expect(status.state).toBe("incompatible");
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
