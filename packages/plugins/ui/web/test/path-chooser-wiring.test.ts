/**
 * The runtime surface really carries the chooser.
 *
 * The settings panel's 浏览 button calls `props.runtime.pickDirectory?.()`, and
 * an optional call on a missing member is a silent no-op — which is exactly how
 * the button shipped dead: the methods were written into `workspace-manager.ts`,
 * a module nothing constructs, instead of the surface `createWorkspaceRuntime`
 * assembles. This pins them where the panel reads them.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

// test -> web -> ui -> plugins -> packages -> repo root
const repoRoot = join(import.meta.dir, "..", "..", "..", "..", "..");

function source(relative: string): string {
  return readFileSync(join(repoRoot, relative), "utf8");
}

const surface = source(
  "packages/framework/client/src/runtime/workspace-runtime.ts",
);
const assembly = source(
  "packages/framework/client/src/runtime/client-surface.ts",
);
const panel = source("packages/plugins/ui/web/src/settings-panel.tsx");

test("the chooser lives on the surface the client assembles", () => {
  // `createWorkspaceRuntime` is spread into the surface by `createClientSurface`,
  // so a method defined there is reachable as `props.runtime.<name>`.
  expect(assembly).toContain("...createWorkspaceRuntime(ctx)");
  expect(surface).toContain("async pickDirectory()");
  expect(surface).toContain("async pickFile()");
  // And the Pick that types the return object names them, so a missing member
  // is a typecheck failure rather than a dead button.
  expect(surface).toMatch(/\|\s*"pickDirectory"/u);
  expect(surface).toMatch(/\|\s*"pickFile"/u);
});

test("the panel calls the runtime's chooser, not a local guess", () => {
  expect(panel).toContain("props.runtime?.pickDirectory?.()");
  expect(panel).toContain("props.runtime?.pickFile?.()");
});

test("the chooser is not duplicated into the unconstructed manager", () => {
  // `createWorkspaceManager` has no call site, so a method written only there is
  // unreachable. The chooser belongs on the surface and nowhere else.
  const manager = source("packages/framework/client/src/workspace-manager.ts");
  expect(manager).not.toContain("async pickDirectory()");
  expect(manager).not.toContain("async pickFile()");
});

test("the browse button shares the action row instead of adding one", () => {
  // A second `neu-form-actions` between the field and 取消/确定 added a whole
  // line to every path editor. The button rides the same row, so no new row
  // opens between it and 取消. Anchored on the JSX text node, not the word,
  // because a comment elsewhere in the file also says 浏览.
  const at = panel.indexOf(
    ">\n                      浏览…\n                    </button>",
  );
  expect(at).toBeGreaterThan(0);
  const cancelAt = panel.indexOf("取消", at);
  expect(cancelAt).toBeGreaterThan(at);
  const between = panel.slice(at, cancelAt);
  expect(between).not.toContain('<div class="neu-form-actions">');
  // And it IS inside an actions row, so it is not floating on its own.
  const before = panel.slice(0, at);
  expect(before).toContain('<div class="neu-form-actions">');
});
