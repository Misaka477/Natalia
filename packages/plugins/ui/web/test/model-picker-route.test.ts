/**
 * With no model configured, clicking a model control opens the model settings
 * instead of an empty menu — and the control itself never changes shape.
 *
 * The user's requirement, in their words: "没配模型的时候点击不要出现下拉，
 * 跳转到模型设置" and "原本长什么样就给老子长什么样". Both halves are pinned
 * here, because the two halves have each been wrong in isolation: the picker
 * was once replaced by a line of text (`1832af3c`, reverted) and once by a
 * differently-styled button (`09be6cc1`, `c9e8e58e`, `d7216269`, reverted) —
 * both changed the appearance, which is what the user rejected.
 *
 * There is no DOM harness in this repo, so — as with the startup-data pins —
 * the guard is the wiring itself.
 */
import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..", "..", "..", "..", "..");

function source(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

test("all four model controls route a modelless click to the model settings", () => {
  const app = source("packages/plugins/ui/web/src/app-neu.tsx");
  const nia = source("packages/plugins/ui/web/src/nia-panel.tsx");

  // The shell carries three of them: the main toolbar, Navi's Chat model and
  // Navi's expert model.
  expect((app.match(/onActivate=\{/gu) ?? []).length).toBe(3);
  expect((app.match(/: openModelSettings/gu) ?? []).length).toBe(3);
  // Nia's is the fourth, routed through the prop it was given.
  expect((nia.match(/onActivate=\{/gu) ?? []).length).toBe(1);
  expect(nia).toContain("props.onOpenSettings?.()");
  expect(app).toContain("onOpenSettings={openModelSettings}");

  // The destination is the MODEL page of the settings, requested on open and
  // given back when it closes so it stays a request, not a new default.
  expect(app).toContain('setSettingsCategory("model")');
  expect(app).toContain("category={settingsCategory()}");
  expect(app).toContain("setSettingsCategory(undefined)");
  expect(source("packages/plugins/ui/web/src/settings-panel.tsx")).toContain(
    "if (props.open && requested)",
  );
});

test("the model controls themselves are untouched", () => {
  const app = source("packages/plugins/ui/web/src/app-neu.tsx");
  const nia = source("packages/plugins/ui/web/src/nia-panel.tsx");
  // Each control still renders as the select it always was, with its own
  // placeholder: no substituted button, no substituted label.
  for (const placeholder of ["选择模型", "Chat 模型", "专家模型"] as const)
    expect(app).toContain(`placeholder="${placeholder}"`);
  expect(nia).toContain('placeholder="Nia 模型"');
  expect(app).not.toContain("未配置模型");
  expect(nia).not.toContain("未配置模型");
  expect(app).not.toContain("去设置");
  // And only the modelless case takes the route: with a model to choose the
  // menu opens exactly as before.
  expect(app.match(/modelOptions\(\)\.length > 0/gu)?.length).toBe(3);
  expect(nia.match(/modelOptions\(\)\.length > 0/gu)?.length).toBe(1);
});
