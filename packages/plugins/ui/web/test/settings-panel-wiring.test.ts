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

test("an action that does not write config is not gated on the writer", () => {
  // The response cache flips the runtime's live switch; it has nothing to do
  // with the config file, so gating it on a config writer was simply wrong.
  const gate = source.slice(
    source.indexOf('updateConfig || item.label === "Response Cache"') - 200,
    source.indexOf('updateConfig || item.label === "Response Cache"') + 80,
  );
  expect(gate).toContain('item.label === "Response Cache"');
});

test("an unwired runtime face is reported, never silently ignored", () => {
  // The cache row used to accept a click and do nothing. It now checks the face
  // exists and writes the failure into the value cell.
  expect(source).toContain("typeof props.runtime?.responseCache");
  expect(source).toContain("responseCacheError()");
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

test("a config write re-reads the runtime rather than trusting the snapshot", () => {
  // The panel's config prop is a snapshot taken at open; a compose-time row
  // changes the live runtime, not that snapshot, so the value cell must be fed
  // the runtime's own answer.
  expect(source).toContain("props.runtime?.configGet?.()");
  expect(source).toContain("props.onConfig?.");
});
