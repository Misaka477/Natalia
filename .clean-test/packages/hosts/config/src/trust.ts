/**
 * The trust database (分发层 P11, local half).
 *
 * Installing an out-of-tree tool family or plugin records where it came from
 * and a fingerprint of its entry file, so loading can verify the package on
 * disk is the one that was installed — a changed or replaced package is
 * reported instead of silently running whatever is there now.
 *
 * The store lives at `.natalia/trust.json` and is keyed by the family/plugin
 * id. It is an audit-and-verify record, not a permission gate: the operator who
 * configures a source has already opted in, and the store tells them when the
 * bytes changed.
 */
import { createHash } from "node:crypto";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { resolve } from "node:path";

export type TrustEntry = {
  /** The family or plugin id this record is for. */
  key: string;
  /** Where it was installed from (a path or a package spec). */
  source: string;
  version?: string;
  /** sha256 of the entry file at install time, for drift detection. */
  fingerprint?: string;
  installedAt: string;
};

export type TrustStore = Record<string, TrustEntry>;

export const TRUST_FILE = ".natalia/trust.json";

export function trustStorePath(workspaceRoot: string) {
  return resolve(workspaceRoot, TRUST_FILE);
}

export async function loadTrustStore(
  workspaceRoot: string,
): Promise<TrustStore> {
  try {
    const parsed = JSON.parse(
      await readFile(trustStorePath(workspaceRoot), "utf8"),
    ) as TrustStore;
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return {};
    throw error;
  }
}

export async function saveTrustStore(
  workspaceRoot: string,
  store: TrustStore,
): Promise<void> {
  await mkdir(resolve(workspaceRoot, ".natalia"), { recursive: true });
  await writeFile(
    trustStorePath(workspaceRoot),
    `${JSON.stringify(store, null, 2)}\n`,
    { mode: 0o600 },
  );
}

export async function recordTrust(
  workspaceRoot: string,
  entry: TrustEntry,
): Promise<TrustStore> {
  const store = await loadTrustStore(workspaceRoot);
  store[entry.key] = entry;
  await saveTrustStore(workspaceRoot, store);
  return store;
}

export async function removeTrust(
  workspaceRoot: string,
  key: string,
): Promise<TrustStore> {
  const store = await loadTrustStore(workspaceRoot);
  delete store[key];
  await saveTrustStore(workspaceRoot, store);
  return store;
}

/** sha256 of a file's bytes, the fingerprint a trust record pins. */
export async function fingerprintFile(path: string): Promise<string> {
  return createHash("sha256")
    .update(await readFile(path))
    .digest("hex");
}

/**
 * Whether a family/plugin's on-disk entry matches the trust record. Returns
 * `undefined` when there is no record (never installed), `true` when it
 * matches, and the expected fingerprint when the bytes changed.
 */
export async function verifyTrust(
  workspaceRoot: string,
  key: string,
  entryPath: string,
): Promise<{ verified: boolean; expected?: string; actual?: string }> {
  const store = await loadTrustStore(workspaceRoot);
  const record = store[key];
  if (!record?.fingerprint) return { verified: false };
  const actual = await fingerprintFile(entryPath);
  return {
    verified: actual === record.fingerprint,
    expected: record.fingerprint,
    actual,
  };
}
