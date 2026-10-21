/**
 * The shell a command runs in is a PERSISTED choice, in one place only.
 *
 * `NATALIA_SHELL` — an environment variable — used to be the only way to pick
 * pwsh over bash, and it was deleted: an environment variable is not a
 * persisted configuration (a human who chose lost the choice on the next
 * start), it was the same decision through a channel neither the settings row
 * nor `config.get` can see, and nothing in the tree ever read it. The chain
 * now is
 *
 *   settings panel → config.runtime.shell.executable → setConfiguredShell
 *     → selectExecutor → BashLocalExecutor | PwshLocalExecutor
 *
 * and absent means 自动, the platform's own shell.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");

const foundation = await Bun.file(
  join(
    repoRoot,
    "packages",
    "core",
    "contracts",
    "src",
    "schema-foundation.ts",
  ),
).text();
const select = await Bun.file(
  join(repoRoot, "packages", "core", "shell", "src", "select.ts"),
).text();
const catalog = await Bun.file(
  join(
    repoRoot,
    "packages",
    "framework",
    "client",
    "src",
    "runtime",
    "initialize",
    "config-catalog.ts",
  ),
).text();
const reload = await Bun.file(
  join(
    repoRoot,
    "packages",
    "framework",
    "client",
    "src",
    "runtime",
    "config-reload.ts",
  ),
).text();
const panel = await Bun.file(
  join(
    repoRoot,
    "packages",
    "plugins",
    "ui",
    "web",
    "src",
    "settings-panel.tsx",
  ),
).text();

test("the shell choice is a persisted config field", () => {
  const at = foundation.indexOf("export const shellConfigSchema");
  expect(at).toBeGreaterThan(0);
  const schema = foundation.slice(at, at + 900);
  expect(schema).toContain('executable: z.enum(["bash", "pwsh", "zsh"])');
  // It lives in the runtime section, beside the two path rows.
  expect(foundation).toContain("shell: shellConfigSchema.default({})");
});

test("the selector reads no environment", () => {
  const at = select.indexOf("export function selectExecutor(");
  expect(at).toBeGreaterThan(0);
  // To the end of the file: `selectExecutor` is its last declaration, and a
  // fixed window silently stops covering the expression under a long comment.
  const body = select.slice(at);
  // The first parameter is the config's answer, and it is consulted FIRST.
  expect(body).toContain("configured?:");
  // Matched on the operands, not on one spelling: prettier may wrap the line.
  expect(body).toMatch(/configured\s*\?\?\s*configuredShell/u);
  // And the environment is GONE: `NATALIA_SHELL` was a read-only deployment
  // default consulted when nothing was configured, and it was deleted — the
  // config file already expresses a deployment default visibly, an env var is
  // the same decision through a channel the settings row cannot see, and no
  // reader existed.
  expect(body).not.toContain("env.NATALIA_SHELL");
  expect(body).not.toContain("process.env");
});

test("the choice is recorded at load AND at reload", () => {
  // Load: a fresh start honours what was persisted.
  expect(catalog).toContain(
    "setConfiguredShell(runtimeConfig.runtime?.shell?.executable)",
  );
  // Reload: the change takes effect on the write that made it, not next start.
  expect(reload).toContain("tsConfig.config.runtime?.shell?.executable");
  expect(reload).toContain("setConfiguredShell(");
});

test("nothing writes a choice into the environment anywhere", async () => {
  // `NATALIA_SHELL` was the DEPLOYMENT's default. Writing a human's choice
  // there made it outlive the session that made it and collide with the
  // deployment's own default — which is why 自动 could not get back to the
  // platform shell. The variable is gone; this pins that no path reintroduces
  // it.
  expect(catalog).not.toContain("process.env.NATALIA_SHELL");
  expect(reload).not.toContain("process.env.NATALIA_SHELL");
  const shellSwitch = await Bun.file(
    join(
      repoRoot,
      "packages",
      "framework",
      "client",
      "src",
      "runtime",
      "shell-switch.ts",
    ),
  ).text();
  expect(shellSwitch).not.toContain("process.env.NATALIA_SHELL");
  expect(shellSwitch).toContain("setConfiguredShell(");
  // And the managed-environment marker it was one letter away from is gone
  // too: `NATIALIA_SHELL=1` had no reader in the tree.
  const shellEnv = await Bun.file(
    join(repoRoot, "packages", "core", "shell", "src", "shell-env.ts"),
  ).text();
  expect(shellEnv).not.toContain("SHELL` as const");
  expect(shellEnv).toContain("NATALIA_HOME_ENV");
});

test("the settings panel offers the shell, and 自动 is a real answer", () => {
  expect(panel).toContain('"Shell 类型"');
  // The four answers. 自动 names the deployment's default rather than a blank,
  // and the row says the choice takes effect immediately — which is the whole
  // point of the session-scoped switch. Matched on the label text rather than
  // one spelling, because prettier decides where the object wraps.
  expect(panel).toMatch(/value:\s*"auto",\s*label:\s*"自动（跟随部署默认）"/u);
  expect(panel).toContain("pwsh（PowerShell 7）");
  expect(panel).toContain("bash（Git Bash / WSL）");
  expect(panel).toContain("立即生效");
  // A concrete choice moves the SESSION's shell rather than writing config: a
  // workspace's own config outranks the global file, and a config write reloads
  // the whole runtime.
  expect(panel).toContain("props.runtime?.setSessionShell?.(");
  // Clearing the choice restores the platform default. The row sends `null`
  // — `undefined` would be dropped by the JSON transport before the runtime
  // ever sees it, so the merge deleted nothing and the reload re-pinned the
  // previous choice (measured: the row said 自动, the config still said bash).
  // Matched on the operands, because prettier wraps the object across lines.
  expect(panel).toMatch(/executable:\s*null/u);
  // A fixed set of answers gets a select, not a text box that invites a typo.
  expect(panel).toContain("function openSelect(");
  expect(panel).toContain("editFieldOptions");
});
