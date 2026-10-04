import { describe, expect, test } from "bun:test";
import { mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { plainStatus, startupDiagnostics } from "../src/index";

/**
 * The first run on an installed copy.
 *
 * The config path is `${process.cwd()}/.natalia/config.json`, so an installed
 * app launched from the Start Menu reads inside its own install directory — a
 * file the installer cannot pre-create, because the directory is created by the
 * first run. Both entry points used the STRICT reader, so the very first launch
 * died with ENOENT, and once that was fixed the next line threw "missing
 * default model" because a fresh config has none.
 *
 * A dev checkout never saw either: its repo root has carried a `.natalia/` for
 * as long as the path has existed, and it has a default model configured.
 */
describe("first run", () => {
  test("status reads a config that does not exist yet, and says so instead of dying", async () => {
    const root = await mkdtemp(join(tmpdir(), "natalia-first-run-"));
    try {
      // Nothing under this root — no .natalia, no config.json.
      const configPath = join(root, ".natalia", "config.json");
      const status = await plainStatus(configPath);
      expect(status.configured).toBe(false);
      expect(status.reason).toContain("no default model");
      // And the SECOND run is a plain read of the file the first one wrote: it
      // still reports the unconfigured state, and its summary no longer claims
      // a creation (that is the first run's line, not a standing one).
      const again = await plainStatus(configPath);
      expect(again.configured).toBe(false);
      expect(again.reason).toContain("no default model");
      expect(again.migrationSummary).not.toContain("created default");
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);

  test("startup diagnostics create the config rather than throwing ENOENT", async () => {
    const root = await mkdtemp(join(tmpdir(), "natalia-first-diag-"));
    try {
      const configPath = join(root, ".natalia", "config.json");
      const diagnostics = await startupDiagnostics(configPath, false);
      expect(diagnostics.configPath).toBe(configPath);
      expect(diagnostics.migrationSummary).toContain("created default");
      expect(diagnostics.automation).toBe(true);
      expect(diagnostics.tty).toBe(false);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  }, 20_000);
});
