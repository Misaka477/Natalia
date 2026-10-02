import { contextMenuStyles } from "@natalia/ui-kit";

/**
 * Styles owned by the file editor UI plugin.
 *
 * These are intentionally injected by this plugin so the main web UI does not
 * need to know about CodeMirror or the file tree.
 */
export const fileEditorStyles =
  `
/* ===== File tree + editor ===== */
.neu-file-pane { flex: 1; display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }
.neu-file-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  padding: 14px 6px 8px;
  font-size: 13px;
  color: var(--neu-text);
}
.neu-file-actions {
  display: flex;
  gap: 6px;
}
.neu-file-action {
  padding: 5px 10px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-size: 11px;
  cursor: pointer;
  box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light);
}
.neu-file-action:hover:not(:disabled) {
  color: var(--neu-accent);
}
.neu-file-action:disabled {
  opacity: 0.4;
  cursor: default;
}
.neu-file-action-danger {
  color: var(--neu-error);
}
.neu-top-row {
  display: flex;
  align-items: flex-start;
  gap: 10px;
  margin-bottom: 8px;
}
.neu-top-row .neu-file-header {
  flex: 0 0 auto;
}
.neu-file-tabs-scroll {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 4px;
  overflow: hidden;
  background: var(--neu-bg);
  border-radius: 16px;
  padding: 6px 8px;
  box-shadow: 3px 3px 8px var(--neu-shadow-dark), -3px -3px 8px var(--neu-shadow-light);
}
.neu-top-row .neu-file-editor-tabs {
  flex: 1;
  min-width: 0;
  margin-bottom: 0;
  overflow-x: auto;
  overflow-y: hidden;
  flex-wrap: nowrap;
  scrollbar-width: none;
}
.neu-top-row .neu-file-editor-tabs::-webkit-scrollbar {
  display: none;
}
.neu-top-row .neu-file-editor-tab {
  flex-shrink: 0;
}
.neu-file-body { flex: 1; display: flex; min-height: 0; overflow: hidden; gap: 10px; }
.neu-file-tree-shell {
  flex: 0 0 auto;
  display: flex;
  flex-direction: column;
  min-width: 120px;
  overflow: hidden;
}
.neu-file-tree-shell .neu-file-tree {
  flex: 1;
  margin-top: 0;
  overflow-y: auto;
  overflow-x: auto;
  background: var(--neu-bg);
  border-radius: 12px;
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
  padding: 6px;
  min-width: 120px;
}
.neu-file-tree {
  flex: 0 0 auto;
  overflow-y: auto;
  overflow-x: auto;
  background: var(--neu-bg);
  border-radius: 12px;
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
  padding: 6px;
  min-width: 120px;
}
.file-pane-resizer { width: 6px; flex: 0 0 6px; cursor: col-resize; background: transparent; touch-action: none; }
.file-pane-resizer:hover { background: var(--neu-resizer-hover); border-radius: 4px; }
.file-tree-item { display: flex; align-items: center; gap: 6px; padding: 5px 8px; width: max-content; min-width: 100%; background: transparent; border: none; border-radius: 10px; color: var(--neu-text); font-family: var(--neu-font-mono); font-size: 12px; text-align: left; cursor: pointer; transition: all 100ms ease; }
.file-tree-item:hover { background: var(--neu-bg-light); }
.file-tree-item[data-active="true"] { background: var(--neu-bg-light); box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light); }
.file-tree-chevron { width: 12px; height: 12px; transition: transform 100ms ease; flex-shrink: 0; color: var(--neu-muted); }
.file-tree-chevron[data-expanded="true"] { transform: rotate(90deg); }
.file-tree-icon { width: 14px; height: 14px; flex-shrink: 0; color: var(--neu-muted); }
.file-tree-file-icon { color: var(--neu-accent); }
.file-tree-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.file-tree-status { font-size: 9px; font-weight: 700; width: 12px; text-align: center; flex-shrink: 0; }
.status-modified { color: var(--neu-warning); }
.status-added { color: var(--neu-success); }
.status-deleted { color: var(--neu-error); }

.neu-file-editor { flex: 1; min-width: 0; display: flex; flex-direction: column; overflow: hidden; }
.neu-file-editor-tabs { display: flex; align-items: center; margin-bottom: 8px; }
.neu-file-editor-tab {
  display: inline-flex; align-items: center; gap: 6px;
  padding: 8px 12px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--neu-text);
  font-size: 12px;
}
.neu-file-editor-tab[data-active="true"] {
  position: relative;
  z-index: 1;
  background: var(--neu-bg-light);
  color: var(--neu-accent);
  border-color: var(--neu-hairline-accent);
  box-shadow: none;
}
.neu-file-editor-tab[data-active="true"] .neu-file-editor-tab-label {
  color: var(--neu-accent);
  font-weight: 600;
}
.neu-file-editor-tab[data-active="true"] .neu-tab-dirty {
  background: var(--neu-accent);
}
.neu-file-editor-tab:hover {
  background: var(--neu-bg-light);
}
.neu-file-editor-tab-label { max-width: 180px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.neu-file-editor-tab .neu-tab-dirty { width: 7px; height: 7px; border-radius: 50%; background: var(--neu-accent); }
.neu-file-editor-tab .neu-tab-close { width: 20px; height: 20px; background: transparent; border: none; color: var(--neu-muted); border-radius: 8px; cursor: pointer; }
.neu-file-breadcrumbs {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 6px 10px;
  margin-bottom: 8px;
  font-size: 12px;
  color: var(--neu-muted);
  background: var(--neu-bg);
  border-radius: 12px;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-file-breadcrumb {
  border: none;
  background: transparent;
  padding: 0;
  font: inherit;
  color: inherit;
  cursor: pointer;
}
.neu-file-breadcrumb:hover { color: var(--neu-text); }
.neu-file-breadcrumb:disabled { cursor: default; }
.neu-file-breadcrumb:disabled:hover { color: var(--neu-muted); }
.neu-file-breadcrumb-separator { color: var(--neu-muted); opacity: 0.6; }
.neu-file-editor-host {
  flex: 1;
  min-width: 0;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
}
.neu-file-editor-area {
  flex: 1; display: flex; min-height: 0; overflow: hidden;
  background: var(--neu-bg-light);
  border-radius: 12px;
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
.neu-line-numbers {
  width: 44px; flex-shrink: 0; overflow: hidden;
  padding: 10px 8px 10px 0; text-align: right;
  font-family: var(--neu-font-mono); font-size: 12px; line-height: 1.6;
  color: var(--neu-muted); opacity: 0.8;
  user-select: none; white-space: pre;
}
.neu-file-codemirror {
  flex: 1; min-width: 0; overflow: hidden;
}
.neu-file-codemirror .cm-editor {
  height: 100%;
  background: transparent;
  color: var(--neu-text);
}
.neu-file-codemirror .cm-scroller {
  font-family: var(--neu-font-mono);
  font-size: 12px;
  line-height: 1.6;
}
.neu-file-textarea {
  flex: 1; min-width: 0; border: none; outline: none; resize: none;
  padding: 10px 12px; background: transparent; color: var(--neu-text);
  font-family: var(--neu-font-mono); font-size: 12px; line-height: 1.6;
  white-space: pre; tab-size: 2; overflow: auto;
}
.neu-file-textarea::selection { background: color-mix(in srgb, var(--neu-accent) 20%, transparent); }

/* Markdown preview */
.neu-markdown-preview {
  flex: 1;
  min-width: 0;
  overflow-y: auto;
  padding: 14px 18px 20px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  line-height: 1.7;
  font-size: 13px;
  border-radius: 12px;
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
.neu-file-editor-area-preview {
  box-shadow: none;
  background: transparent;
}
.neu-markdown-body {
  max-width: 760px;
}
.neu-markdown-body h1,
.neu-markdown-body h2,
.neu-markdown-body h3 {
  color: var(--neu-text);
}
.neu-markdown-body h1 { font-size: 1.8em; }
.neu-markdown-body h2 { font-size: 1.5em; }
.neu-markdown-body h3 { font-size: 1.25em; }
.neu-markdown-body p { margin: 0.6em 0; }
.neu-markdown-body ul { margin: 0.6em 0; padding-left: 1.4em; }
.neu-markdown-body li { margin: 0.2em 0; }
.neu-markdown-body table {
  width: 100%;
  border-collapse: collapse;
  margin: 0.8em 0;
  font-size: 0.95em;
}
.neu-markdown-body th,
.neu-markdown-body td {
  border: 1px solid var(--neu-border, var(--neu-bg-light));
  padding: 5px 10px;
  text-align: left;
}
.neu-markdown-body th {
  color: var(--neu-text);
  background: var(--neu-bg);
}
.neu-markdown-body code {
  background: var(--neu-bg);
  padding: 0.1em 0.35em;
  border-radius: 6px;
  font-family: var(--neu-font-mono);
  font-size: 0.92em;
}
.neu-markdown-body pre {
  background: var(--neu-bg);
  padding: 10px 12px;
  border-radius: 10px;
  overflow-x: auto;
}
.neu-markdown-body pre code {
  background: transparent;
  padding: 0;
}
.neu-markdown-body strong { color: var(--neu-text); }
.neu-markdown-body em { color: var(--neu-muted); }

/* VSCode-like file tree rows */
.file-tree-row {
  position: relative;
  display: block;
  width: 100%;
  min-width: max-content;
  border-radius: 10px;
}
.file-tree-row[data-active="true"] {
  background: var(--neu-bg-light);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.file-tree-row .file-tree-item {
  display: flex;
  align-items: center;
  gap: 6px;
  width: 100%;
  min-width: max-content;
  background: transparent;
  border: none;
}
.file-tree-row[data-active="true"] .file-tree-item {
  background: transparent;
  box-shadow: none;
}
.file-tree-chevron-slot {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  color: var(--neu-muted);
  cursor: default;
}
.file-tree-row .file-tree-chevron-slot {
  cursor: pointer;
}
.file-tree-chevron-slot:empty {
  visibility: hidden;
}

/* Custom dialog */
.neu-file-dialog-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1000;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--neu-overlay);
}
.neu-file-dialog {
  width: min(420px, 90vw);
  background: var(--neu-bg-light);
  border-radius: 16px;
  padding: 18px;
  box-shadow: 8px 8px 20px var(--neu-shadow-dark), -8px -8px 20px var(--neu-shadow-light);
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.neu-file-dialog-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-file-dialog-input {
  width: 100%;
  padding: 10px 12px;
  border: none;
  outline: none;
  border-radius: 12px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-family: inherit;
  font-size: 13px;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-file-dialog-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.neu-file-dialog-button {
  padding: 7px 14px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-size: 12px;
  cursor: pointer;
  box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light);
}
.neu-file-dialog-primary {
  background: var(--neu-accent);
  color: var(--neu-on-accent);
}

/* Context menu */
.neu-file-context-backdrop {
  position: fixed;
  inset: 0;
  z-index: 1001;
}
.neu-file-context-menu {
  position: fixed;
  min-width: 140px;
  background: var(--neu-bg-light);
  border-radius: 12px;
  padding: 6px;
  box-shadow: 4px 4px 12px var(--neu-shadow-dark), -4px -4px 12px var(--neu-shadow-light);
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.neu-file-context-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 7px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--neu-text);
  font-size: 12px;
  cursor: pointer;
}
.neu-file-context-item:hover {
  background: var(--neu-bg);
  color: var(--neu-accent);
}
.neu-file-context-danger {
  color: var(--neu-error);
}
` + contextMenuStyles;
