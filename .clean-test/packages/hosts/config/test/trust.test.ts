import { expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import {
  fingerprintFile,
  loadTrustStore,
  recordTrust,
  removeTrust,
  verifyTrust,
} from "../src/trust";

test("the trust store records, lists and removes entries", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-trust-"));
  await recordTrust(root, {
    key: "/workspace/extra/extra.family",
    source: "/workspace/extra/extra.family",
    version: "1.0.0",
    installedAt: "2026-08-16T00:00:00.000Z",
  });
  const store = await loadTrustStore(root);
  expect(store["/workspace/extra/extra.family"]?.version).toBe("1.0.0");
  await removeTrust(root, "/workspace/extra/extra.family");
  expect(await loadTrustStore(root)).toEqual({});
});

test("verifyTrust reports a package that changed since install", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-trust-verify-"));
  const dir = join(root, "extra.family");
  await mkdir(dir, { recursive: true });
  const entry = join(dir, "index.ts");
  await writeFile(entry, "export const v = 1;");
  const fingerprint = await fingerprintFile(entry);
  await recordTrust(root, {
    key: dir,
    source: dir,
    version: "1.0.0",
    fingerprint,
    installedAt: new Date().toISOString(),
  });
  // Unchanged: verified.
  expect(await verifyTrust(root, dir, entry)).toMatchObject({
    verified: true,
  });
  // Changed bytes: not verified, and the expected fingerprint is reported.
  await writeFile(entry, "export const v = 2;");
  const mismatch = await verifyTrust(root, dir, entry);
  expect(mismatch.verified).toBe(false);
  expect(mismatch.expected).toBe(fingerprint);
  expect(mismatch.actual).not.toBe(fingerprint);
});

test("verifyTrust reports an unrecorded package as unverified", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-trust-unknown-"));
  const entry = join(root, "index.ts");
  await writeFile(entry, "x");
  expect(await verifyTrust(root, "/somewhere/else", entry)).toEqual({
    verified: false,
  });
});
