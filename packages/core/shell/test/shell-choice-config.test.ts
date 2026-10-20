/**
 * The shell a command runs in is a PERSISTED choice, not only an env var.
 *
 * `NATALIA_SHELL` was the only way to pick pwsh over bash, and an environment
 * variable is not a persisted configuration: a human who chose lost the choice
 * on the next start. The chain now is
 *
 *   settings panel → config.runtime.shell.executable → process.env.NATALIA_SHELL
 *     → selectExecutor → BashLocalExecutor | PwshLocalExecutor
 *
 * and the config OUTRANKS the variable, because the panel is the human's and
 * the variable is the deployment's.
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

test("the configured shell outranks the environment variable", () => {
  const at = select.indexOf("export function selectExecutor(");
  expect(at).toBeGreaterThan(0);
  // To the end of the file: `selectExecutor` is its last declaration, and a
  // fixed window silently stops covering the expression under a long comment.
  const body = select.slice(at);
  // The third parameter is the config's answer, and it is consulted FIRST.
  expect(body).toContain("configured?:");
  // Matched on the operands, not on one spelling: prettier may wrap the line.
  expect(body).toMatch(/configured\s*\?\?\s*env\.NATALIA_SHELL/u);
});

test("the choice is applied at load AND at reload", () => {
  // Load: a fresh start honours what was persisted.
  expect(catalog).toContain(
    "applyConfiguredShell(runtimeConfig.runtime?.shell?.executable)",
  );
  expect(catalog).toContain("process.env.NATALIA_SHELL = executable");
  // Reload: the change takes effect on the write that made it, not next start.
  expect(reload).toContain("tsConfig.config.runtime?.shell?.executable");
  expect(reload).toContain("process.env.NATALIA_SHELL =");
});

test("the settings panel offers the shell, and 自动 is a real answer", () => {
  expect(panel).toContain('"Shell 类型"');
  // The four answers, with the platform default named rather than blank.
  expect(panel).toContain(
    '{ value: "auto", label: "自动（Windows 用 pwsh，其他用 bash）" }',
  );
  expect(panel).toContain('{ value: "pwsh", label: "pwsh（PowerShell 7）" }');
  expect(panel).toContain('{ value: "bash", label: "bash（Git Bash / WSL）" }');
  // Clearing the row writes "discover", not a value nobody chose.
  expect(panel).toContain("{ executable: undefined }");
  // A fixed set of answers gets a select, not a text box that invites a typo.
  expect(panel).toContain("function openSelect(");
  expect(panel).toContain("editFieldOptions");
});
