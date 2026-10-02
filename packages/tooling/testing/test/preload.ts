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
 * A temp dir per PROCESS, not per test: `bun test` runs several files in one
 * process, and tests within a file already isolate their own workspaces. A
 * per-process root keeps files in a process from colliding while leaving the
 * filesystem cheap to clean.
 *
 * WHAT THIS DOES NOT DO, deliberately: it does not set HOME.
 *
 * It did at first, and CI caught it: `rustup could not choose a version of cargo,
 * because one wasn't specified explicitly` — the toolchain lives under `$HOME`,
 * so a test preload that moves HOME hides it from every subprocess the tests
 * spawn. It passed locally only because this host's toolchain is system-wide,
 * which is exactly the environment-specific pass that must not decide a change.
 * HOME stays where the operator put it.
 *
 * The consequence is that the session store is NOT isolated by this preload:
 * `workspaceStoreRoot` takes a `home` parameter defaulting to `homedir()`, which
 * reads HOME. Isolating that path means threading the home through every caller,
 * which is a product change. The gap is named here and in bunfig.toml rather than
 * assumed closed.
 */
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

if (process.env.NATALIA_HOME === undefined)
  process.env.NATALIA_HOME = mkdtempSync(join(tmpdir(), "natalia-test-home-"));

// The session store's own relocation switch. NATALIA_HOME deliberately does not
// cover it (see stateRoot's note in store-paths.ts): reusing it would move an
// existing install's store, so the test-only switch is separate and defaults to
// the real home.
if (process.env.NATALIA_STORE_HOME === undefined)
  process.env.NATALIA_STORE_HOME = process.env.NATALIA_HOME;

// The workspace registry. This one already had a variable —
// `workspaceRegistryPath` reads NATALIA_WORKSPACES_FILE before falling back to
// `~/.config/natalia/workspaces.json` — so no product change was needed, only the
// preload had not been setting it. Without it every test process shared one real
// registry file and could read another test's workspaces.
if (process.env.NATALIA_WORKSPACES_FILE === undefined)
  process.env.NATALIA_WORKSPACES_FILE = join(
    process.env.NATALIA_HOME,
    "workspaces.json",
  );

// The preload's own state root, so a test can assert the isolation holds rather
// than trusting that an env var happens to be read.
export const testStateHome = process.env.NATALIA_HOME!;
