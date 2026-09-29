import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The settings panel's wiring pins. Three rows were reported dead from the
 * field: the response-cache row, compaction, and the skill rows' switch/delete.
 * Each failed a different way, and each way is a silent one — a click that
 * renders nothing and reports nothing.
 */
const source = readFileSync(
  join(import.meta.dir, "..", "src", "settings-panel.tsx"),
  "utf8",
);

test("the panel derives a config writer instead of waiting for one", () => {
  // The app mounts WorkspaceSettingsPanel WITHOUT onUpdateConfig (it passes only
  // the runtime), and every config row's clickable branch was gated on that
  // prop — so compaction, the threshold, the terminal mode, max steps and max
  // retry all rendered as inert spans. The runtime carries `config.update`.
  expect(source).toContain("props.runtime?.updateConfig");
  // The writer must feed the rows' own writes, not a parallel path.
  expect(source).not.toMatch(/props\.onUpdateConfig\?\./u);
});

test("the panel derives a config writer instead of waiting for one", () => {
  // The app mounts WorkspaceSettingsPanel WITHOUT onUpdateConfig (it passes only
  // the runtime), and every config row's clickable branch was gated on that
  // prop — so compaction, the threshold, the terminal mode, max steps and max
  // retry all rendered as inert spans. The runtime carries `config.update`.
  expect(source).toContain("props.runtime?.updateConfig");
  // The writer must feed the rows' own writes, not a parallel path.
  expect(source).not.toMatch(/props\.onUpdateConfig\?\./u);
});

test("every row that writes config derives its writer, inline gates included", () => {
  // The compaction row had its OWN gate (not the shared editableActions one),
  // and that gate also read `props.onUpdateConfig` — so the previous fix, which
  // rewired only the shared gate, left compaction (and the terminal mode) inert
  // exactly as before. Both are rewired to the derived writer now.
  expect(source).not.toMatch(/props\.onUpdateConfig &&/u);
  expect(source).toMatch(/item\.label === "Compaction" &&\s*updateConfig &&/u);
  expect(source).toMatch(
    /item\.label === "Terminal Window Mode" &&\s*updateConfig &&/u,
  );
});

test("the panel reads the runtime's config itself instead of trusting the app's snapshot", () => {
  // The reported failure was "press it and nothing happens, no feedback, is it
  // off, on, or unchanged". Both rows were inert for a reason no gate explains:
  // `props.config` is the app's SNAPSHOT, and it is undefined until the app's
  // own load finishes — which can be after the panel opens. While undefined,
  // every row shows the category's static literal (compaction's is a hardcoded
  // "开启") and the config-gated rows do not render as buttons at all. The
  // writes were fine all along; the panel was rendering a snapshot that had not
  // arrived, and never re-read it after a write.
  expect(source).toContain("props.runtime?.configGet?.()");
  // The effective view must PREFER the panel's own read, or the snapshot's
  // undefined wins and the panel is inert exactly as before.
  expect(source).toMatch(
    /const effectiveConfig = \(\)[^=]*=>\s*\n?\s*\(ownConfig\(\) as ConfigV3 \| undefined\) \?\? props\.config/u,
  );
  // And the rows must read it, not the prop.
  expect(source).not.toMatch(/const config = props\.config;/u);
  expect(source).not.toMatch(/String\(props\.config\.runtime/u);
});

test("the row's value is a getter, not a frozen const", () => {
  // The console proved the write side works end to end (write -> applied ->
  // re-read returns the new value), and the row still showed the old one. The
  // cause is Solid-specific: `{value}` with `const value = ...` inserts static
  // text, so the expression runs once and the cell never moves again — no
  // matter how many times the config signal it reads changes. `{value()}` with
  // a getter re-runs on that dependency.
  expect(source).toMatch(
    /const value = \(\) =>\s*\n?\s*runtimeValue\(item\.label\)/u,
  );
  // Every JSX site must call it; a bare `{value}` is the frozen form.
  expect(source).not.toMatch(/\{value\}/u);
  expect(source.match(/\{value\(\)\}/gu)?.length ?? 0).toBeGreaterThanOrEqual(
    4,
  );
});
