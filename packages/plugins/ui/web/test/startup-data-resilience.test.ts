/**
 * The startup data that fails to arrive must say so, and be retried.
 *
 * Measured on the user's machine: the permission dropdown rendered its
 * empty menu while the config on disk carried all three agent modes (the
 * schema default) — so the dropdown was empty because the RPC never
 * delivered, not because there was nothing to choose. The fetch used to
 * swallow every failure (`.catch(() => undefined)`), ran exactly once,
 * and nothing on screen distinguished "no data" from "data never
 * arrived".
 *
 * There is no DOM harness in this repo, so — as with the pending-takeover
 * and tool-row pins — the guard is the wiring itself.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..", "..", "..");

function source(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

test("the secondary startup data is retried, not fetched once", () => {
  const app = source("packages/plugins/ui/web/src/app-neu.tsx");
  // A bounded retry loop with a pause, because the first attempt races
  // the runtime's own startup on a fresh install.
  expect(app).toContain("SECONDARY_STARTUP_ATTEMPTS = 3");
  expect(app).toContain("SECONDARY_STARTUP_RETRY_MS = 1_000");
  expect(app).toMatch(
    /for \(\s*let attempt = 1;\s*attempt <= SECONDARY_STARTUP_ATTEMPTS;/u,
  );
  // Each source settles on its own: one failure no longer discards the
  // other four, and the failed ones are named rather than dropped.
  expect(app).toContain("settle(");
  expect(app).toMatch(/failed: string\[\]/u);
  // And the give-up is LOUD: a warning naming what never arrived.
  expect(app).toContain("startup data unavailable after");
});

test("the permission dropdown never renders a silent empty state", () => {
  const app = source("packages/plugins/ui/web/src/app-neu.tsx");
  // The dropdown branches on the degraded flag: it offers a retry
  // instead of an empty menu that reads as "this config has no modes".
  expect(app).toContain("startupDataDegraded()");
  expect(app).toContain("配置加载失败，点击重试");
  expect(app).toContain('if (permission === "__retry")');
  // The options are no longer an unconditional read of the config.
  expect(app).not.toMatch(/options=\{permissionOptions\(\)\}/u);
});

test("a workspace listing that fails is shown, not implied", () => {
  const editor = source("packages/plugins/ui/file-editor/src/file-editor.tsx");
  // reloadWorkspace used to let the rejection escape a void call: the
  // tree stayed at its initial empty state and looked like an empty
  // workspace. It now catches, names the failure, and offers the retry.
  expect(editor).toMatch(/catch \(error\) \{[\s\S]*setListError\(/u);
  expect(editor).toContain("无法读取工作区文件列表");
  expect(editor).toContain("工作区列表读取失败");
  expect(editor).toContain("void reloadWorkspace()");
  // And the banner is styled, so it is visible rather than structurally
  // present only.
  const styles = source("packages/plugins/ui/file-editor/src/styles.ts");
  expect(styles).toContain(".neu-file-list-error {");
});
