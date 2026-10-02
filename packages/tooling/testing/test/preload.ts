/**
 * Test-process preload: an isolated state root.
 *
 * Registered from bunfig.toml `[test] preload`, so it runs before every test file
 * in every process. It exists because constructing a real runtime client
 * otherwise writes to the OPERATOR'S `~/.natalia`:
 *
 *   - the vault (`$NATALIA_HOME/vault`, else `$HOME/.natalia/vault`)
 *   - the operation log (`$NATALIA_HOME/logs`, else the home's own)
 *   - the session store (`workspaceStoreRoot`'s `home`, which is `homedir()`)
 *
 * All 40 client test files did that, to the same real directory, with no
 * isolation from each other or from the operator's own data — and on a host
 * whose home is read-only it fails outright: `generation-tools.test.ts` failed
 * deterministically with `SQLiteError: attempt to write a readonly database`.
 *
 * WHAT THIS DOES NOT COVER, deliberately: the session store. `workspaceStoreRoot`
 * takes a `home` parameter defaulting to `homedir()` and does not read
 * NATALIA_HOME, so pointing one variable at a temp dir covers the vault and the
 * log but not that path. Isolating it means threading the home through every
 * caller, which is a product change and not something a test preload should
 * paper over. It is recorded here and in bunfig.toml so the gap is visible rather
 * than assumed closed.
 *
 * A temp dir per PROCESS, not per test: `bun test` runs several files in one
 * process, and tests within a file already isolate their own workspaces. A
 * per-process root keeps files in a process from colliding while leaving the
 * filesystem cheap to clean.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.NATALIA_HOME === undefined) {
  const home = mkdtempSync(join(tmpdir(), "natalia-test-home-"));
  process.env.NATALIA_HOME = home;
  // Some paths read HOME rather than NATALIA_HOME; covering both is what makes
  // the isolation hold for a runtime that computes its state root either way.
  if (process.env.HOME !== undefined) process.env.HOME = home;
}

// The preload's own state root, so a test can assert the isolation holds rather
// than trusting that an env var happens to be read.
export const testStateHome = process.env.NATALIA_HOME!;
