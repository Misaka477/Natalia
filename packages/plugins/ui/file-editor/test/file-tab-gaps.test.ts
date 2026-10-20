/**
 * The file tab's three reported gaps, pinned against the source.
 *
 * 1. The selected row painted `--neu-bg-light` — a LIGHT surface — under
 *    `--neu-text`, which in the dark skin is light text on a light ground: the
 *    row was obviously "the selected one" and its name was not readable
 *    (reported with a screenshot). It now uses the accent tint, which is
 *    designed to sit under text, plus a left bar for the "this one" signal.
 * 2. The right-click menu offered create/rename/delete only. Copy, cut, paste,
 *    copy-relative-path and copy-absolute-path were missing.
 * 3. Every non-Markdown file went to CodeMirror, so an image opened as
 *    mojibake and a video as binary noise.
 *
 * These are shape assertions because the component is Solid JSX; the
 * behavioural halves (the clipboard actually holding a path, the media URL
 * actually loading) need a DOM host and are covered by the web layer.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const editor = await Bun.file(
  join(repoRoot, "plugins", "ui", "file-editor", "src", "file-editor.tsx"),
).text();
const styles = await Bun.file(
  join(repoRoot, "plugins", "ui", "file-editor", "src", "styles.ts"),
).text();

test("the selected row keeps its label readable", () => {
  const at = styles.indexOf('.file-tree-row[data-active="true"] {');
  expect(at).toBeGreaterThan(0);
  const rule = styles.slice(at, at + 400);
  // The accent tint, not the light surface that cost the text its contrast.
  expect(rule).toContain("--neu-accent-soft");
  expect(rule).not.toContain("--neu-bg-light");
  // And the bar that carries the "this one" signal on its own.
  expect(styles).toContain('.file-tree-row[data-active="true"]::before');
});

test("the right-click menu copies, cuts, pastes and names both paths", () => {
  for (const label of [
    "复制",
    "剪切",
    "复制相对路径",
    "复制绝对路径",
    "重命名",
    "删除",
    "新建文件夹",
  ])
    expect(editor).toContain(`label: "${label}"`);
  // 粘贴 names which kind it is, so the label is built rather than literal.
  expect(editor).toContain('"粘贴（移动）"');
  expect(editor).toContain('"粘贴（复制）"');
  // The clipboard is real state, so 粘贴 only exists while something is on it.
  expect(editor).toContain("const [clipboard, setClipboard] = createSignal");
  expect(editor).toContain("if (clipboard())");
  // The absolute path is built from the active workspace's root, not guessed.
  expect(editor).toContain("function absolutePathFor");
  expect(editor).toContain("active?.root");
});

test("an image or a video gets a viewer instead of the text editor", () => {
  expect(editor).toContain("function mediaKindFor");
  expect(editor).toContain('return "image"');
  expect(editor).toContain('return "video"');
  // The viewer is rendered, and the editor is not reached for those files.
  expect(editor).toContain("neu-file-media-image");
  expect(editor).toContain("neu-file-media-video");
  expect(editor).toContain("if (media) {");
  // The blob URL is revoked, so a long session does not leak one per asset.
  expect(editor).toContain("URL.revokeObjectURL");
});
