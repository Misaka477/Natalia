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
  // rewired only the shared gate, left compaction inert exactly as before.
  expect(source).not.toMatch(/props\.onUpdateConfig &&/u);
  expect(source).toMatch(/item\.label === "Compaction" &&\s*updateConfig &&/u);
});

test("the terminal window mode is gone, not merely unwired", () => {
  // `runtime.terminal.windowMode` named how the terminal window opened and
  // nothing ever read it: the PTY controller declared the field and never
  // consulted it, and every spawn is `windowsHide: true` outright. The row, the
  // schema field, the controller input and the framework's wiring are all
  // deleted — a setting that changes nothing is worse than no setting, because
  // it reads as a choice.
  expect(source).not.toContain("Terminal Window Mode");
  expect(source).not.toMatch(/windowMode/u);
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
    /const effectiveConfig = \(\)[^=]*=>\s*\n?\s*\(ownConfig\(\) as ConfigV4 \| undefined\) \?\? props\.config/u,
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

test("the shell row switches hot for every value, 自动 included, and offers no zsh", () => {
  // Two measured failures of this one row.
  //
  // (1) Picking 自动 wrote the config and skipped the hot call entirely (the
  // `if (value !== "auto")` gate), while the route's whitelist rejected
  // `auto` anyway — so the pane kept the old shell until the next start,
  // while the row's own comment promised "the next command uses the new
  // shell without a restart". 自动 is a real answer to the contract (the
  // platform's own shell: pwsh on Windows, bash elsewhere), not a blank.
  expect(source).not.toContain('if (value !== "auto")');
  expect(source).toMatch(
    /shell: value as "bash" \| "pwsh" \| "zsh" \| "auto"/u,
  );
  // (2) The row offered zsh, which the runtime does not support: a choice
  // the product cannot honour reads as a choice (the UI-honesty rule).
  expect(source).not.toContain('{ value: "zsh"');
});

test("the config write path re-reads, so a row shows what the runtime answers", () => {
  // Measured: the panel had ONE writeConfig that read back and refreshed
  // `ownConfig`, and twelve rows that called the writer directly — including
  // the shell row. A direct write never re-read, so the row kept its OLD
  // value on screen until the panel was closed and reopened (the human picked
  // bash and the row still said 自动). The read-back is now part of the one
  // writer every row goes through.
  expect(source).not.toContain("async function writeConfig");
  // The writer itself reads the runtime back and broadcasts it.
  expect(source).toMatch(
    /props\.runtime\?\.updateConfig\?\.\(\{[\s\S]*?props\.runtime\?\.configGet\?\.\(\)/u,
  );
  expect(source).toContain("setOwnConfig(next as never)");
  expect(source).toContain("props.onConfig?.(next as never)");
});

test("every config write carries the panel's own write scope", () => {
  // Measured: the panel offered a 运行时配置保存范围 preference (default
  // "global") and every row dropped it — `updateConfig(patch)` with no scope
  // defaults to "project" at the runtime, so the shell row's 自动 deleted the
  // PROJECT's shell key while the human's choice lived in the GLOBAL file and
  // showed straight through. The row said 自动, the merged config still said
  // bash, the pane still said PS.
  expect(source).toContain("scope: runtimeWriteScope()");
  // And it rides the runtime path only: an embedder's own writer
  // (`onUpdateConfig`) is theirs to call however they like.
  expect(source).toMatch(
    /props\.runtime\?\.updateConfig\?\.\(\{\s*patch,\s*\n?\s*\/\/[\s\S]*?scope: runtimeWriteScope\(\)/u,
  );
});

test("the shell row's 自动 writes null, not undefined", () => {
  // The patch crosses the RPC as JSON, and `JSON.stringify` DROPS a key
  // whose value is undefined: the runtime merged `{shell:{}}`, deleted
  // nothing, and the reload that follows re-pinned the PREVIOUS choice —
  // measured: the row said 自动, the config still said bash, the pane still
  // said PS, with no restart helping. `null` is the only spelling of "unset"
  // that survives JSON; the runtime's updateConfig turns it into the delete
  // the merge understands.
  expect(source).not.toContain("{ executable: undefined }");
  expect(source).toContain("{ executable: null }");
});
