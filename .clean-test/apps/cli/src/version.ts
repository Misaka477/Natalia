import { readFileSync } from "node:fs";
import { resolve } from "node:path";

/**
 * The version `natalia --version` prints (study D1: "natalia --version
 * 正确").
 *
 * Release builds BAKE the value — ts:build defines it from the root
 * package.json into the bundle, and build-standalone re-defines it when
 * compiling the binary — so a shipped binary never reads files it does
 * not carry. The package.json read is the dev-run fallback (the same
 * `import.meta.dir` walk official-plugins uses for its dev assets) and
 * degrades to "dev" rather than throwing: --version must answer even
 * from an exotic layout.
 */
export function pickVersion(
  baked: string | undefined,
  pkgVersion: string | undefined,
): string {
  if (baked) return baked;
  if (pkgVersion) return pkgVersion;
  return "dev";
}

function readPackageVersion(): string | undefined {
  try {
    const raw = readFileSync(
      resolve(import.meta.dir, "../../../package.json"),
      "utf8",
    );
    const parsed = JSON.parse(raw) as { version?: unknown };
    return typeof parsed.version === "string" ? parsed.version : undefined;
  } catch {
    return undefined;
  }
}

export const NATALIA_VERSION = pickVersion(
  process.env.NATALIA_TS_VERSION,
  readPackageVersion(),
);
