export const nataliaNeuBaseStyles = `
:root {
  font-family: "Inter", system-ui, -apple-system, sans-serif;
  background: var(--neu-bg);
  color: var(--neu-text);
  --neu-radius: 22px;
  --neu-radius-sm: 12px;
  --neu-font-mono: "JetBrains Mono", "SF Mono", Consolas, monospace;
  --neu-scrollbar: color-mix(in srgb, var(--neu-muted) 45%, transparent);
  --neu-scrollbar-hover: color-mix(in srgb, var(--neu-accent) 60%, transparent);
  --neu-accent-shadow: color-mix(in srgb, var(--neu-accent) 35%, transparent);
  --neu-focus-ring: color-mix(in srgb, var(--neu-accent) 18%, transparent);
  --neu-resizer-hover: color-mix(in srgb, var(--neu-accent) 25%, transparent);
  --neu-hairline-accent: color-mix(in srgb, var(--neu-accent) 15%, transparent);
  --neu-diff-removed-bg: color-mix(in srgb, var(--neu-error) 10%, transparent);
  --neu-diff-added-bg: color-mix(in srgb, var(--neu-success) 10%, transparent);
  --neu-error-soft: color-mix(in srgb, var(--neu-error) 12%, transparent);
  --neu-danger: var(--neu-error);
  --neu-on-accent: #1c211f;
  --neu-on-error: #fff;
  --neu-thumb: #fff;
  --neu-thumb-shadow: 0 1px 3px rgba(0, 0, 0, 0.25);
  --neu-badge-inset: inset 1px 1px 2px rgba(0, 0, 0, 0.1);
  --neu-inset-pressed-dark: rgba(0, 0, 0, 0.18);
  --neu-inset-pressed-light: rgba(255, 255, 255, 0.35);
}

* { box-sizing: border-box; margin: 0; padding: 0; }
html, body, #root { width: 100%; height: 100%; overflow: hidden; }
body { background: var(--neu-bg); color: var(--neu-text); font-size: 14px; }

.neu-shell {
  width: 100vw;
  height: 100vh;
  display: flex;
  flex-direction: column;
  gap: 14px;
  padding: 14px;
  background: var(--neu-bg);
  overflow: hidden;
}
.neu-app {
  flex: 1;
  min-height: 0;
  display: flex;
  align-items: stretch;
  gap: 14px;
  overflow: visible;
}

/* ===== Top bar ===== */
.neu-topbar {
  position: relative;
  flex-shrink: 0;
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 16px;
  min-height: 56px;
  padding: 10px 18px;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 3px 3px 8px var(--neu-shadow-dark), -3px -3px 8px var(--neu-shadow-light);
}
.neu-topbar-left {
  display: flex;
  align-items: center;
  gap: 12px;
  min-width: 0;
}
.neu-topbar-logo {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 12px;
  background: var(--neu-accent);
  color: var(--neu-on-accent);
  font-weight: 700;
  font-size: 14px;
}
.neu-topbar-meta {
  display: flex;
  flex-direction: column;
  min-width: 0;
}
.neu-topbar-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-topbar-sub {
  font-size: 11px;
  color: var(--neu-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.neu-topbar-center {
  display: flex;
  align-items: center;
  gap: 16px;
  flex: 1;
  justify-content: center;
  min-width: 0;
}
.neu-topbar-agent {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 12px;
  border-radius: 999px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-size: 12px;
  white-space: nowrap;
}
.neu-topbar-agent-dot {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--neu-muted);
}
.neu-topbar-agent-dot[data-status="running"] { background: var(--neu-success); }
.neu-topbar-agent-state {
  color: var(--neu-muted);
  font-size: 11px;
}
.neu-topbar-right {
  display: flex;
  align-items: center;
  gap: 8px;
}
.neu-topbar-btn {
  padding: 7px 14px;
  border: none;
  border-radius: 12px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-size: 12px;
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light);
  transition: box-shadow 0.2s ease, background-color 0.2s ease, color 0.2s ease;
}
.neu-topbar-btn:hover { box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light); color: var(--neu-accent); }
.neu-topbar-btn:active { box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light); }
.neu-topbar-btn[data-active="true"] { box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light); color: var(--neu-accent); }
.neu-topbar-group {
  display: flex;
  align-items: center;
  gap: 4px;
  padding-left: 10px;
  border-left: 1px solid var(--neu-hairline-accent);
}
.neu-topbar-group-label {
  font-size: 10px;
  color: var(--neu-muted);
  white-space: nowrap;
}
.neu-topbar-panel-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  right: 12px;
  min-width: 320px;
  max-width: 560px;
  max-height: 70vh;
  display: flex;
  flex-direction: column;
  gap: 8px;
  background: var(--neu-bg-light);
  border-radius: 16px;
  padding: 12px;
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  z-index: 100;
}
.neu-topbar-panel-content {
  flex: 1;
  min-height: 120px;
  max-height: 60vh;
  overflow: auto;
}
.neu-topbar-view-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  right: 150px;
  min-width: 140px;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--neu-bg-light);
  border-radius: 16px;
  padding: 8px;
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  z-index: 100;
}
.neu-topbar-more-dropdown {
  position: absolute;
  top: calc(100% + 6px);
  right: 12px;
  min-width: 200px;
  max-height: 70vh;
  overflow: auto;
  display: flex;
  flex-direction: column;
  gap: 2px;
  background: var(--neu-bg-light);
  border-radius: 16px;
  padding: 8px;
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  z-index: 100;
}
.neu-topbar-more-item {
  display: block;
  width: 100%;
  text-align: left;
  padding: 8px 12px;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--neu-text);
  font-size: 12px;
  cursor: pointer;
}
.neu-topbar-more-item:hover {
  background: var(--neu-bg);
  color: var(--neu-accent);
}
.neu-topbar-more-separator {
  height: 1px;
  margin: 4px 6px;
  background: var(--neu-hairline-accent);
}
.neu-topbar-more-group {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 4px 0;
}

/* ===== Left session sidebar ===== */
.neu-sidebar {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 3px 3px 8px var(--neu-shadow-dark), -3px -3px 8px var(--neu-shadow-light);
  padding: 18px;
  overflow: hidden;
  min-width: 0;
  position: relative;
}
.neu-sidebar-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--neu-muted);
  letter-spacing: 0.04em;
  margin-bottom: 14px;
}
.neu-sidebar-content {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overflow-x: hidden;
  padding-right: 2px;
}
.neu-tree-title {
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--neu-muted);
  padding: 4px 6px 10px;
}
.neu-workspace-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 5px 8px;
  margin: 1px 0;
  color: var(--neu-muted);
  font-size: 11px;
  font-weight: 600;
}
.neu-workspace-row .neu-workspace-name {
  font-size: 11px;
  font-weight: 600;
  color: var(--neu-muted);
}
.neu-workspace-folder {
  display: flex;
  align-items: center;
  gap: 4px;
  padding: 5px 8px;
  margin: 1px 0;
  border-radius: var(--neu-radius-sm);
  cursor: pointer;
  position: relative;
  user-select: none;
  color: var(--neu-text);
  font-size: 13px;
  font-weight: 500;
}
.neu-workspace-folder:hover,
.neu-workspace-folder[data-menu-open="true"] {
  background: var(--neu-bg);
}
.neu-workspace-chevron {
  display: none;
  align-items: center;
  justify-content: center;
  width: 16px;
  height: 16px;
  flex-shrink: 0;
  padding: 0;
  border: none;
  background: transparent;
  color: var(--neu-muted);
  cursor: pointer;
  transition: transform 0.15s ease;
}
.neu-workspace-folder:hover .neu-workspace-chevron,
.neu-workspace-folder:focus-within .neu-workspace-chevron,
.neu-workspace-folder[data-menu-open="true"] .neu-workspace-chevron {
  display: inline-flex;
}
.neu-workspace-chevron[data-open="true"] {
  transform: rotate(90deg);
}
.neu-workspace-folder-icon {
  display: inline-flex;
  flex-shrink: 0;
  color: var(--neu-accent);
  opacity: 0.65;
}
.neu-workspace-folder:hover .neu-workspace-folder-icon,
.neu-workspace-folder:focus-within .neu-workspace-folder-icon,
.neu-workspace-folder[data-menu-open="true"] .neu-workspace-folder-icon {
  display: none;
}
.neu-workspace-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  font-weight: 500;
  color: var(--neu-text);
}
.neu-workspace-folder:hover .neu-workspace-actions,
.neu-workspace-folder:focus-within .neu-workspace-actions,
.neu-workspace-folder[data-menu-open="true"] .neu-workspace-actions,
.neu-workspace-actions:hover {
  display: inline-flex;
}
.neu-workspace-actions {
  display: none;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  flex-shrink: 0;
}
.neu-workspace-rename-input {
  flex: 1;
  min-width: 0;
  height: 22px;
  padding: 0 6px;
  border: none;
  border-radius: 6px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  font-family: inherit;
  font-size: 12px;
  outline: none;
  box-shadow: inset 1px 1px 2px var(--neu-shadow-dark), inset -1px -1px 2px var(--neu-shadow-light);
}
.neu-workspace-menu-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--neu-muted);
  cursor: pointer;
}
.neu-workspace-menu-btn:hover {
  background: var(--neu-bg-light);
  color: var(--neu-text);
}
.neu-workspace-popup {
  position: absolute;
  top: calc(100% + 2px);
  right: 0;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 130px;
  padding: 4px;
  background: var(--neu-bg-light);
  border-radius: 10px;
  box-shadow: 3px 3px 10px var(--neu-shadow-dark), -1px -1px 6px var(--neu-shadow-light);
}
.neu-workspace-popup button {
  display: flex;
  align-items: center;
  gap: 6px;
  padding: 7px 10px;
  border: none;
  border-radius: 6px;
  background: transparent;
  color: var(--neu-text);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
}
.neu-workspace-popup button:hover {
  background: var(--neu-bg);
  color: var(--neu-accent);
}
/* The danger indicator (sandbox study §6b①): pre-attentive, persistent,
   never dismissible by a stray click. The escalated variant is the
   quieter marker — the full-danger session is the loud one. */
.neu-danger-badge {
  display: inline-flex;
  align-items: center;
  margin-left: 10px;
  padding: 2px 8px;
  border-radius: 4px;
  font-size: 11px;
  font-weight: 700;
  letter-spacing: 0.08em;
  cursor: help;
  user-select: none;
}
.neu-danger-badge {
  background: color-mix(in srgb, var(--neu-warning) 22%, transparent);
  color: var(--neu-warning);
  border: 1px solid color-mix(in srgb, var(--neu-warning) 55%, transparent);
}
.neu-danger-badge[data-danger="true"] {
  background: color-mix(in srgb, var(--neu-danger) 22%, transparent);
  color: var(--neu-danger);
  border: 1px solid color-mix(in srgb, var(--neu-danger) 65%, transparent);
}

.neu-workspace-popup-danger {
  color: var(--neu-error);
}
.neu-workspace-popup-danger:hover {
  background: var(--neu-diff-removed-bg);
  color: var(--neu-error);
}
.neu-count {
  font-size: 11px;
  color: var(--neu-muted);
  flex-shrink: 0;
  min-width: 16px;
  text-align: right;
}
.neu-workspace-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 22px;
  height: 22px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--neu-muted);
  font-size: 16px;
  line-height: 1;
  cursor: pointer;
}
.neu-workspace-remove:hover {
  background: var(--neu-bg);
  color: var(--neu-text);
}
.neu-tree-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  min-height: 36px;
  padding: 6px 12px;
  margin: 4px 0;
  border: none;
  border-radius: var(--neu-radius-sm);
  background: transparent;
  color: var(--neu-text);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  white-space: nowrap;
  overflow: hidden;
}
.neu-tree-row:active {
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-tree-row:focus-visible {
  outline: 2px solid var(--neu-accent);
  outline-offset: 2px;
}
.neu-tree-row:hover {
  background: var(--neu-bg);
  color: var(--neu-text);
}
.neu-tree-row[data-selected="true"] {
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
  color: var(--neu-text);
}
.neu-tree-actions {
  display: none;
  align-items: center;
  gap: 4px;
  margin-left: auto;
  flex-shrink: 0;
}
.neu-tree-row:hover .neu-tree-actions,
.neu-tree-row:focus-within .neu-tree-actions {
  display: inline-flex;
}
.neu-tree-edit {
  padding: 2px 4px;
  border: none;
  background: transparent;
  color: var(--neu-muted);
  cursor: pointer;
  font-size: 12px;
}
.neu-tree-edit:hover { color: var(--neu-accent); }
.neu-tree-edit-input {
  flex: 1;
  min-width: 0;
  padding: 3px 6px;
  border: none;
  border-radius: 6px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  font-size: 12px;
  outline: none;
  box-shadow: inset 1px 1px 2px var(--neu-shadow-dark), inset -1px -1px 2px var(--neu-shadow-light);
}
.neu-tree-label {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.neu-session-overflow {
  display: block;
  width: 100%;
  padding: 5px 10px 5px 36px;
  margin: 1px 0;
  border: none;
  border-radius: var(--neu-radius-sm);
  background: transparent;
  color: var(--neu-muted);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.neu-session-overflow:hover {
  background: var(--neu-bg);
  color: var(--neu-accent);
}
.neu-status-dot {
  width: 9px;
  height: 9px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--neu-muted);
  box-shadow: none;
}
.neu-status-dot[data-status="running"] { background: var(--neu-success); }
.neu-status-dot[data-status="error"] { background: var(--neu-error); }
.neu-badge {
  font-size: 10px;
  padding: 2px 8px;
  border-radius: 10px;
  background: var(--neu-bg-light);
  color: var(--neu-muted);
  box-shadow: none;
  white-space: nowrap;
  flex-shrink: 0;
}

/* ===== Resizers ===== */
.neu-resizer,
.neu-right-resizer {
  width: 8px;
  flex-shrink: 0;
  cursor: col-resize;
  background: transparent;
  touch-action: none;
  position: relative;
  z-index: 2;
}
.neu-resizer::after,
.neu-right-resizer::after {
  content: "⋮";
  position: absolute;
  inset: 0;
  display: flex;
  align-items: center;
  justify-content: center;
  color: var(--neu-muted);
  opacity: 0.55;
  font-size: 12px;
  line-height: 1;
}
.neu-resizer:hover::after,
.neu-right-resizer:hover::after {
  color: var(--neu-accent);
  opacity: 1;
}

.neu-resizer:hover,
.neu-right-resizer:hover {
  background: var(--neu-resizer-hover);
  border-radius: 8px;
}
.neu-shell[data-resizing="true"] {
  cursor: col-resize;
  user-select: none;
}
.neu-shell[data-resizing="true"] .neu-sidebar,
.neu-shell[data-resizing="true"] .neu-secondary {
  transition: none;
  contain: layout;
  overflow-anchor: none;
}
.neu-shell[data-resizing="true"] .neu-main {
  contain: layout paint;
  overflow-anchor: none;
}
.neu-shell[data-resizing="true"] .neu-sidebar-content,
.neu-shell[data-resizing="true"] .neu-secondary-content,
.neu-shell[data-resizing="true"] .neu-main {
  pointer-events: none;
}

/* ===== Collapsed side rails ===== */
.neu-collapsed-rail {
  width: 18px;
  flex-shrink: 0;
  align-self: stretch;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--neu-bg-light);
  border: none;
  cursor: pointer;
  padding: 0;
  transition: background-color 0.2s ease, box-shadow 0.2s ease;
}
.neu-collapsed-rail:hover {
  background: var(--neu-bg);
  box-shadow: 2px 2px 6px var(--neu-shadow-dark), -2px -2px 6px var(--neu-shadow-light);
}
.neu-left-rail {
  border-radius: 18px;
  margin-left: 0;
  border: none;
}
.neu-right-rail {
  border-radius: 18px;
  margin-right: 0;
  border: none;
}
.neu-rail-dots {
  width: 4px;
  height: 34px;
  background-image: radial-gradient(circle, var(--neu-muted) 1.4px, transparent 1.8px);
  background-size: 4px 6px;
  background-position: center;
  opacity: 0.9;
}
.neu-collapsed-rail:hover .neu-rail-dots {
  opacity: 1;
}

/* ===== Main dual panes ===== */
.neu-main {
  flex: 1;
  min-width: 0;
  display: flex;
  overflow: visible;
}
.neu-main-panes {
  flex: 1;
  min-width: 0;
  display: flex;
  gap: 14px;
}
.neu-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 3px 3px 8px var(--neu-shadow-dark), -3px -3px 8px var(--neu-shadow-light);
  padding: 14px;
  overflow: hidden;
}
.neu-pane-divider {
  width: 8px;
  flex-shrink: 0;
  align-self: stretch;
  background: transparent;
}
.neu-pane-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 10px;
  margin-bottom: 12px;
  padding: 4px 6px;
}
.neu-pane-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-pane-status {
  font-size: 11px;
  padding: 4px 10px;
  background: var(--neu-bg);
  border-radius: 999px;
  color: var(--neu-muted);
  box-shadow: none;
}
.neu-pane-status[data-running="true"] {
  color: var(--neu-success);
}
.neu-pane-header-right {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
}
.neu-load-older {
  border: 1px solid var(--neu-border);
  border-radius: 999px;
  background: transparent;
  color: var(--neu-muted);
  font: inherit;
  font-size: 11px;
  line-height: 1;
  padding: 4px 8px;
  cursor: pointer;
}
.neu-load-older:disabled {
  opacity: 0.55;
  cursor: default;
}
.neu-load-older:hover:not(:disabled) {
  color: var(--neu-text);
  border-color: var(--neu-accent);
}
.natalia-context-meter {
  --context-meter-color: var(--neu-accent);
  display: inline-flex;
  align-items: center;
  gap: 5px;
  height: 22px;
  color: var(--neu-muted);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
  line-height: 1;
  user-select: none;
  white-space: nowrap;
}
.natalia-context-meter[data-status="warning"] {
  --context-meter-color: var(--neu-warning, #d97706);
}
.natalia-context-meter[data-status="critical"],
.natalia-context-meter[data-status="compacting"] {
  --context-meter-color: var(--neu-error);
}
.natalia-context-meter-ring {
  width: 14px;
  height: 14px;
  border-radius: 50%;
  background:
    conic-gradient(
      var(--context-meter-color) 0 var(--context-percent),
      color-mix(in srgb, var(--neu-muted) 28%, transparent) var(--context-percent) 100%
    );
  box-shadow: inset 0 0 0 3px var(--neu-bg);
}
.natalia-context-meter[data-status="critical"] .natalia-context-meter-label,
.natalia-context-meter[data-status="compacting"] .natalia-context-meter-label {
  color: var(--neu-error);
}
.neu-pane-content {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  overflow: hidden;
  border-radius: var(--neu-radius-sm);
}

/* ===== Transcript + Composer ===== */
.neu-pane .natalia-transcript {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  border-radius: 12px;
  padding: 8px 12px 14px;
  display: flex;
  flex-direction: column;
  gap: 6px;
  color: var(--neu-text);
  scrollbar-width: thin;
  scrollbar-color: var(--neu-scrollbar) transparent;
}
.neu-pane .natalia-transcript > * {
  flex-shrink: 0;
}
.neu-pane .natalia-transcript-content {
  display: flex;
  flex-direction: column;
  gap: 6px;
  min-height: 100%;
}
/* The first scroll-to-end owns the initial frame; showing flow before it
   makes a tail-loading page look like it starts at the oldest row. */
.neu-pane .natalia-transcript[data-scroll-ready="false"] .natalia-transcript-content {
  visibility: hidden;
}
.neu-pane .natalia-transcript-empty {
  margin: auto;
  display: flex;
  flex-direction: column;
  align-items: center;
  gap: 8px;
  color: var(--neu-muted);
  max-width: 380px;
  text-align: center;
}
.neu-pane .natalia-transcript-empty-icon { color: var(--neu-accent); opacity: 0.55; }
.neu-pane .natalia-transcript-empty-title { font-size: 16px; color: var(--neu-text); }
.neu-pane .natalia-transcript-empty-hint { font-size: 13px; color: var(--neu-muted); }
.neu-pane .natalia-message {
  position: relative;
  z-index: 1;
  max-width: 70%;
  min-width: 0;
  padding: 10px 14px;
  border-radius: 16px;
  background: var(--neu-assistant-bubble, var(--neu-bg-light));
  border: 1px solid var(--neu-border);
  box-shadow: 0 4px 12px rgba(0, 0, 0, 0.25);
}
.neu-pane .natalia-message[data-role="user"] {
  align-self: flex-end;
  background: var(--neu-user-bubble);
  border-color: var(--neu-user-bubble-border, var(--neu-border));
  color: var(--neu-user-bubble-text);
}
.neu-pane .natalia-message[data-role="user"] .natalia-message-author,
.neu-pane .natalia-message[data-role="user"] .natalia-message-time,
.neu-pane .natalia-message[data-role="user"] .natalia-message-body {
  color: var(--neu-user-bubble-text);
}
.neu-pane .natalia-message[data-role="system"] {
  max-width: 90%;
  background: var(--neu-bg);
  box-shadow: none;
}
.neu-pane .natalia-message-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
  margin-bottom: 5px;
}
.neu-pane .natalia-message-avatar {
  width: 20px;
  height: 20px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border-radius: 50%;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
  font-size: 10px;
  font-weight: 700;
  color: var(--neu-accent);
}
.neu-pane .natalia-message-meta {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  min-width: 0;
}
.neu-pane .natalia-message-author { font-size: 12px; font-weight: 600; color: var(--neu-text); }
.neu-pane .natalia-message-time { font-size: 10px; color: var(--neu-muted); }
.neu-pane .natalia-message-body {
  font-size: 13px;
  line-height: 1.65;
  color: var(--neu-text);
  min-width: 0;
}
.neu-pane .natalia-message-text,
.neu-pane .natalia-thinking-text {
  min-width: 0;
  max-width: 100%;
  overflow-wrap: break-word;
}
.neu-pane .natalia-message-text p { margin: 0 0 6px; }
.neu-pane .natalia-thinking-block {
  padding: 8px 10px;
  margin: 4px 0;
  border-radius: 10px;
  background: var(--neu-bg-light);
  color: var(--neu-muted);
  font-style: italic;
  font-size: 12px;
  line-height: 1.6;
  min-width: 0;
  max-width: 100%;
  overflow-wrap: break-word;
}
.neu-pane .natalia-thinking-label {
  display: block;
  margin-bottom: 4px;
  font-size: 10px;
  font-weight: 700;
  text-transform: uppercase;
  color: var(--neu-thinking, var(--neu-accent));
  font-style: normal;
}
.neu-pane .natalia-thinking-text { color: var(--neu-muted); }

.neu-pane .natalia-code-block {
  background: var(--neu-bg-light);
  border-radius: 10px;
  margin: 6px 0;
  overflow: hidden;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-pane .natalia-code-header { display: flex; align-items: center; justify-content: space-between; padding: 4px 10px; color: var(--neu-muted); font-size: 11px; }
.neu-pane .natalia-code-block pre { padding: 10px; overflow-x: auto; font-family: var(--neu-font-mono); font-size: 12px; }
.neu-pane .natalia-badge { font-size: 10px; padding: 1px 7px; border-radius: 10px; background: var(--neu-bg-light); color: var(--neu-muted); box-shadow: var(--neu-badge-inset); }
.neu-pane .natalia-badge-running { color: var(--neu-success); }
.neu-pane .natalia-badge-success { color: var(--neu-success); }
.neu-pane .natalia-badge-error { color: var(--neu-error); }
.neu-pane .natalia-badge-steering { color: var(--neu-accent); box-shadow: inset 0 0 0 1px var(--neu-accent-soft); }
.neu-pane .natalia-tool-family {
  font-size: 12px;
  font-weight: 600;
  color: var(--neu-text);
  flex-shrink: 0;
}
/* The model-written sentence, and any title fragment that carries information
   the family label does not (a path, a query). Both trail the label. */
.neu-pane .natalia-tool-title {
  margin-left: auto;
  font-size: 11px;
  color: var(--neu-muted);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.neu-pane .natalia-tool-header .natalia-tool-title {
  font-size: 12px;
  font-weight: 500;
  color: var(--neu-text);
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  min-width: 0;
}
.neu-pane .natalia-tool-card[data-state="error"] .natalia-tool-title {
  color: var(--neu-error);
}
.neu-pane .natalia-tool-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 0 10px 6px;
}
.neu-pane .natalia-tool-meta-item {
  display: inline-flex;
  align-items: baseline;
  gap: 4px;
  font-size: 10px;
  color: var(--neu-muted);
}
.neu-pane .natalia-tool-meta-label {
  text-transform: uppercase;
  letter-spacing: 0.06em;
  opacity: 0.7;
}
.neu-pane .natalia-tool-meta-value {
  font-family: var(--neu-font-mono);
  color: var(--neu-text);
}
.neu-pane .natalia-tool-card {
  border-radius: 12px;
  overflow: hidden;
  background: var(--neu-bg-light);
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
  margin: 6px 0;
  min-width: 0;
  max-width: 100%;
}
.neu-pane .natalia-goal-round {
  margin: 6px 0;
  border-radius: 10px;
  overflow: hidden;
  background: color-mix(in srgb, var(--neu-accent) 10%, transparent);
  box-shadow: inset 0 0 0 1px color-mix(in srgb, var(--neu-accent) 28%, transparent);
}
.neu-pane .natalia-goal-round-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 6px 10px;
  border: none;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 12px;
  text-align: left;
}
.neu-pane .natalia-goal-round-header:hover {
  background: color-mix(in srgb, var(--neu-accent) 8%, transparent);
}
.neu-pane .natalia-goal-round-badge {
  padding: 0 6px;
  border-radius: 999px;
  background: color-mix(in srgb, var(--neu-accent) 26%, transparent);
  color: var(--neu-accent);
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
}
.neu-pane .natalia-goal-round-title {
  font-variant-numeric: tabular-nums;
  font-weight: 600;
}
.neu-pane .natalia-goal-round-objective {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  opacity: 0.75;
}
.neu-pane .natalia-goal-round-toggle {
  margin-left: auto;
  opacity: 0.6;
  font-size: 11px;
}
.neu-pane .natalia-goal-round-detail {
  margin: 0;
  padding: 8px 12px;
  border-top: 1px solid color-mix(in srgb, var(--neu-accent) 18%, transparent);
  font-size: 11px;
  line-height: 1.5;
  white-space: pre-wrap;
  word-break: break-word;
  opacity: 0.85;
}
.neu-pane .natalia-tool-header {
  display: flex;
  align-items: center;
  flex-wrap: wrap;
  gap: 6px;
  padding: 8px 10px;
  font-size: 12px;
  color: var(--neu-text);
  min-width: 0;
}
.neu-pane .natalia-tool-name,
.neu-pane .natalia-tool-title,
.neu-pane .natalia-tool-summary {
  min-width: 0;
  overflow-wrap: break-word;
}
.neu-pane .natalia-tool-output {
  padding: 8px 10px;
  border-top: 1px solid var(--neu-divider);
  font-family: var(--neu-font-mono);
  font-size: 12px;
  color: var(--neu-muted);
  min-width: 0;
  max-width: 100%;
  overflow-x: auto;
}
.neu-pane .natalia-tool-output pre {
  margin: 0;
  min-width: 0;
  max-width: 100%;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
.neu-pane .natalia-tool-output-line {
  display: block;
}
/* A diff body's marked lines, colored. The tool marks removed and added lines
   itself (so a UI without a diff renderer still reads the hunk); this turns
   those marks from readable into scannable. */
.neu-pane .natalia-tool-output-line[data-line-kind="added"] {
  color: var(--neu-success);
  background: color-mix(in srgb, var(--neu-success) 10%, transparent);
}
.neu-pane .natalia-tool-output-line[data-line-kind="removed"] {
  color: var(--neu-error);
  background: color-mix(in srgb, var(--neu-error) 10%, transparent);
}
.neu-pane .natalia-tool-output-toggle {
  display: block;
  margin-top: 6px;
  padding: 3px 0 0;
  border: 0;
  border-top: 1px solid var(--neu-divider);
  color: var(--neu-accent);
  background: transparent;
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.neu-pane .natalia-streaming-indicator { display: flex; align-items: center; gap: 4px; color: var(--neu-muted); font-size: 12px; }
.neu-pane .natalia-streaming-dot { width: 4px; height: 4px; border-radius: 50%; background: var(--neu-accent); animation: neu-blink 1s infinite; }
.neu-pane .natalia-message-actions { display: flex; gap: 6px; margin-top: 6px; }
.neu-pane .natalia-action-btn { padding: 5px 12px; border: none; border-radius: 12px; background: var(--neu-bg); color: var(--neu-text); box-shadow: 4px 4px 8px var(--neu-shadow-dark), -4px -4px 8px var(--neu-shadow-light); font-size: 12px; cursor: pointer; }
.neu-pane .natalia-action-btn:active { box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light); }
.neu-pane .natalia-action-btn-primary { background: var(--neu-accent); color: var(--neu-on-accent); box-shadow: 4px 4px 8px var(--neu-accent-shadow), -4px -4px 8px var(--neu-shadow-light); }
.neu-pane .natalia-message-group {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  min-width: 0;
  max-width: 100%;
}
.neu-pane .natalia-message-group[data-role="user"] {
  align-items: flex-end;
}
.neu-pane .natalia-message-group-actions {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-top: 2px;
  padding: 0 8px;
  position: relative;
  z-index: 5;
  opacity: 0;
  transition: opacity 0.15s ease;
}
.neu-pane .natalia-message-group:hover .natalia-message-group-actions,
.neu-pane .natalia-message-group-actions:focus-within {
  opacity: 1;
}

.neu-pane .natalia-message-footer {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-top: 4px;
}
.neu-pane .natalia-message-header-actions {
  display: flex;
  align-items: center;
  gap: 2px;
  margin-left: auto;
  position: relative;
  z-index: 3;
}

.neu-pane .natalia-message-icon-btn {
  position: relative;
  z-index: 3;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 4px;
  width: auto;
  height: 24px;
  padding: 2px 8px;
  border: none;
  border-radius: 8px;
  background: var(--neu-bg);
  color: var(--neu-muted);
  cursor: pointer;
  opacity: 1;
  transition: color 0.15s ease, background 0.15s ease;
}
.neu-pane .natalia-message-icon-btn:hover {
  background: var(--neu-bg);
  color: var(--neu-accent);
}
.neu-pane .natalia-message-icon-btn span {
  font-size: 11px;
  line-height: 1;
}

 .neu-pane .neu-rollback-banner {
   display: flex;
   align-items: center;
   gap: 8px;
   margin-top: 6px;
   padding: 6px 10px;
   border-radius: 10px;
   background: var(--neu-bg);
   color: var(--neu-text);
   font-size: 12px;
   box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
 }
 .neu-pane .neu-rollback-hint {
   color: var(--neu-muted);
 }
 .neu-pane .neu-rollback-cancel {
   margin-left: auto;
   padding: 3px 8px;
   border: none;
   border-radius: 8px;
   background: var(--neu-bg-light);
   color: var(--neu-text);
   font-family: inherit;
   font-size: 11px;
   cursor: pointer;
 }
 .neu-pane .neu-rollback-cancel:hover {
   color: var(--neu-accent);
 }
 .neu-pane .neu-rollback-redo {
   padding: 3px 8px;
   border: none;
   border-radius: 8px;
   background: var(--neu-bg-light);
   color: var(--neu-accent);
   font-family: inherit;
   font-size: 11px;
   cursor: pointer;
 }

.neu-pane .natalia-composer {
  flex-shrink: 0;
  background: var(--neu-bg);
  border-radius: 16px;
  box-shadow: none;
  padding: 10px 12px 12px;
  margin-top: 6px;
}
.neu-pane .natalia-composer-textarea {
  width: 100%;
  min-height: 46px;
  max-height: 160px;
  resize: none;
  background: transparent;
  border: none;
  outline: none;
  color: var(--neu-text);
  padding: 6px 8px;
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
}
.neu-pane .natalia-composer-toolbar { display: flex; align-items: center; justify-content: space-between; }
.neu-pane .natalia-composer-controls { display: flex; gap: 4px; }
.neu-pane .natalia-composer-icon-btn {
  width: 28px;
  height: 28px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 10px;
  background: transparent;
  color: var(--neu-muted);
  box-shadow: none;
  cursor: pointer;
}
.neu-pane .natalia-composer-icon-btn:hover {
  background: var(--neu-hover-overlay);
  color: var(--neu-text);
}
.neu-pane .natalia-composer-submit {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 12px;
  background: var(--neu-bg-light);
  color: var(--neu-accent);
  box-shadow: 3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light);
  cursor: pointer;
}
.neu-pane .natalia-composer-submit:hover {
  box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light);
  color: var(--neu-accent-soft);
}
.neu-pane .natalia-composer-submit:active {
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
  color: var(--neu-accent);
}
.neu-pane .natalia-composer-submit svg {
  transition: transform 0.15s ease, color 0.15s ease;
}
.neu-pane .natalia-composer-submit:active svg {
  transform: scale(0.82);
  opacity: 0.85;
}
.neu-pane .natalia-composer-submit[data-busy="true"] {
  color: var(--neu-error);
  background: var(--neu-error-soft);
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
.neu-pane .natalia-composer-stop {
  width: 34px;
  height: 34px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 12px;
  margin-right: 6px;
  background: var(--neu-error-soft);
  color: var(--neu-error);
  box-shadow: 3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light);
  cursor: pointer;
}
.neu-pane .natalia-composer-stop:hover {
  box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light);
}
.neu-pane .natalia-composer-stop:active {
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
.neu-pane .natalia-queue-dock {
  margin-bottom: 6px;
  padding: 6px 8px;
  display: flex;
  flex-direction: column;
  gap: 4px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-pane .natalia-queue-head {
  display: flex;
  align-items: center;
  justify-content: space-between;
  font-size: 12px;
  color: var(--neu-muted);
}
.neu-pane .natalia-queue-title { font-weight: 600; }
.neu-pane .natalia-queue-toggle {
  border: none;
  background: transparent;
  color: var(--neu-accent);
  cursor: pointer;
  font-size: 12px;
}
.neu-pane .natalia-queue-row { display: flex; align-items: center; gap: 6px; }
.neu-pane .natalia-queue-chip {
  flex: none;
  padding: 1px 6px;
  border-radius: 8px;
  font-size: 11px;
  background: var(--neu-bg-light);
  color: var(--neu-muted);
}
.neu-pane .natalia-queue-row[data-status="steering"] .natalia-queue-chip {
  color: var(--neu-accent);
}
.neu-pane .natalia-queue-text {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
  font-size: 13px;
  color: var(--neu-text);
}
.neu-pane .natalia-queue-edit {
  flex: 1;
  min-width: 0;
  padding: 2px 6px;
  border: none;
  outline: none;
  border-radius: 8px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  font-family: inherit;
  font-size: 13px;
}
.neu-pane .natalia-queue-actions { flex: none; display: flex; gap: 2px; }
.neu-pane .natalia-queue-action {
  border: none;
  background: transparent;
  color: var(--neu-muted);
  cursor: pointer;
  padding: 2px 6px;
  border-radius: 8px;
  font-size: 12px;
}
.neu-pane .natalia-queue-action:hover {
  background: var(--neu-hover-overlay);
  color: var(--neu-text);
}
.neu-pane .natalia-queue-action[data-danger="true"]:hover { color: var(--neu-error); }
.neu-pane .natalia-attachment-chip { display: inline-flex; align-items: center; gap: 6px; padding: 4px 8px; background: var(--neu-bg); border-radius: 12px; font-size: 12px; color: var(--neu-muted); box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light); }
.neu-pane .natalia-attachment-chip[data-image="true"] {
  padding-right: 6px;
}
.neu-pane .natalia-attachment-thumb {
  width: 36px;
  height: 36px;
  object-fit: cover;
  border-radius: 8px;
  background: var(--neu-bg-light);
}
.neu-pane .natalia-attachment-remove {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 18px;
  height: 18px;
  padding: 0;
  border: none;
  border-radius: 50%;
  background: transparent;
  color: var(--neu-muted);
  cursor: pointer;
}
.neu-pane .natalia-attachment-remove:hover {
  background: var(--neu-bg);
  color: var(--neu-error);
}

/* ===== Right secondary sidebar ===== */
.neu-secondary {
  flex-shrink: 0;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 3px 3px 8px var(--neu-shadow-dark), -3px -3px 8px var(--neu-shadow-light);
  padding: 16px 16px 14px;
  overflow: hidden;
  min-width: 0;
}
.neu-secondary-tabs {
  position: relative;
  z-index: 1;
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 4px 0 12px;
  margin-bottom: 8px;
  flex-shrink: 0;
  overflow: visible;
}
.neu-secondary-tab {
  flex-shrink: 0;
  padding: 8px 14px;
  border: none;
  border-radius: 12px;
  background: var(--neu-bg);
  color: var(--neu-muted);
  font-size: 12px;
  font-weight: 500;
  box-shadow: 4px 4px 8px var(--neu-shadow-dark), -4px -4px 8px var(--neu-shadow-light);
  cursor: pointer;
  white-space: nowrap;
}
.neu-secondary-tab:hover { box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light); color: var(--neu-text); }
.neu-secondary-tab[data-active="true"] {
  background: var(--neu-bg-light);
  color: var(--neu-accent);
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
.neu-secondary-content {
  position: relative;
  z-index: 2;
  flex: 1;
  min-height: 0;
  overflow: hidden;
  display: flex;
  flex-direction: column;
  border-radius: var(--neu-radius-sm);
}
.neu-secondary-content > * { flex: 1; min-height: 0; }
/*
 * The plugin panel slot. It is a percentage-height chain's last definite link:
 * the plugin's root sizes itself against this element, and a plain block here
 * resolves a height of 100% to auto -- which makes a terminal pane's height
 * mutually dependent on the terminal's own content, so the pane stops at its
 * content height and leaves the rest of the sidebar empty (the reported
 * "height is locked"). A flex column gives the plugin root a basis to stretch
 * against instead of a percentage to resolve.
 */
.neu-side-panel-host {
  display: flex;
  flex-direction: column;
  min-height: 0;
  height: 100%;
}

/* ===== Review / Diff ===== */
.review-pane { display: flex; flex-direction: column; flex: 1; min-height: 0; overflow: hidden; }
.review-subtabs { display: flex; gap: 6px; padding: 0 12px 8px; }
.review-subtab {
  flex: 1;
  padding: 6px 8px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-muted);
  font-size: 11px;
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light);
}
.review-subtab:hover {
  color: var(--neu-text);
}
.review-subtab[data-active="true"] {
  background: var(--neu-bg-light);
  color: var(--neu-text);
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
.review-section-label {
  padding: 0 12px 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--neu-muted);
  text-transform: uppercase;
}
.review-git-ranges {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 8px;
}
.review-git-ranges .neu-select {
  flex: 1;
  min-width: 0;
}
.review-git-arrow {
  color: var(--neu-muted);
  font-size: 12px;
  flex-shrink: 0;
}
.review-entity-control {
  padding: 0 12px 8px;
}
.review-checkpoint-rename {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 0 12px 8px;
}
.review-checkpoint-rename-input {
  flex: 1;
  min-width: 0;
  padding: 5px 8px;
  border: none;
  border-radius: 8px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-family: inherit;
  font-size: 11px;
  outline: none;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.review-checkpoint-rename-btn {
  padding: 4px 8px;
  border: none;
  border-radius: 8px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
}
.review-checkpoint-rename-btn:hover {
  color: var(--neu-accent);
}
.review-select {
  width: 100%;
  padding: 6px 8px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-size: 11px;
  outline: none;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.review-diff-raw {
  padding: 8px 12px;
  margin: 6px 12px;
  border-radius: 10px;
  background: var(--neu-bg-light);
}
.review-diff-raw-title {
  font-size: 10px;
  font-weight: 600;
  color: var(--neu-muted);
  margin-bottom: 4px;
}
.review-diff-raw pre {
  margin: 0;
  white-space: pre-wrap;
  word-break: break-word;
}
.review-pr-detail {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px 12px;
  margin: 0 12px 8px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.review-pr-row {
  font-size: 11px;
  color: var(--neu-muted);
}
.review-pr-label {
  font-weight: 700;
  margin-right: 6px;
  color: var(--neu-muted);
}
.review-pr-text {
  color: var(--neu-text);
}
.review-pr-result {
  margin: 4px 0 0;
  padding: 6px 8px;
  max-height: 80px;
  overflow: auto;
  border-radius: 8px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  white-space: pre-wrap;
  font-family: var(--neu-font-mono);
  font-size: 10px;
}
.review-entity-list {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 0 12px 8px;
}
.review-entity-button {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 5px 8px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-muted);
  font-size: 11px;
  cursor: pointer;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.review-entity-button[data-active="true"] {
  background: var(--neu-bg-light);
  color: var(--neu-text);
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
.review-entity-count {
  font-weight: 700;
  color: var(--neu-accent);
}
.review-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px;
  margin-bottom: 10px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
.review-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--neu-text); }
.review-title svg { color: var(--neu-accent); }
.review-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--neu-muted); }
.review-additions { color: var(--neu-success); font-weight: 600; }
.review-deletions { color: var(--neu-error); font-weight: 600; }
.review-body { display: flex; flex: 1; min-height: 0; overflow: hidden; }
.nia-flat-pane {
  background: transparent;
  box-shadow: none;
  padding: 0;
}
.nia-flat-pane .neu-pane-header {
  background: transparent;
  box-shadow: none;
  padding: 10px 14px 4px;
}
.nia-flat-pane .neu-pane-header-actions {
  display: flex;
  align-items: center;
  gap: 8px;
}
.nia-flat-pane .neu-pane-content {
  background: transparent;
  box-shadow: none;
  padding: 0 12px 0;
}
.nia-transcript-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.nia-transcript-wrap .neu-jump-bottom {
  bottom: 16px;
  right: 16px;
}
.main-transcript-wrap,
.chat-transcript-wrap {
  position: relative;
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
}
.main-transcript-wrap .neu-jump-bottom,
.chat-transcript-wrap .neu-jump-bottom {
  bottom: 16px;
  right: 16px;
}

.review-empty {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 10px;
  padding: 24px;
  text-align: center;
  color: var(--neu-muted);
}
.review-empty-icon {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 56px;
  height: 56px;
  border-radius: 18px;
  background: var(--neu-bg);
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
  color: var(--neu-accent);
}
.review-empty-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--neu-text);
}
.review-empty-desc {
  font-size: 12px;
  line-height: 1.6;
  max-width: 320px;
}

.review-resizer {
  width: 6px;
  flex: 0 0 6px;
  cursor: col-resize;
  background: transparent;
  touch-action: none;
  transition: background 0.2s ease;
}
.review-resizer:hover { background: var(--neu-resizer-hover); border-radius: 8px; }
.review-files {
  width: 230px; flex-shrink: 0;
  overflow-y: auto;
  overflow-x: hidden;
  background: var(--neu-bg);
  border-radius: 12px;
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
  padding: 6px;
}
.review-files-heading { padding: 8px 10px; font-size: 10px; font-weight: 600; color: var(--neu-muted); text-transform: uppercase; }
.review-file-row {
  display: flex; align-items: center; gap: 8px; width: 100%;
  padding: 8px 10px;
  background: transparent; border: none;
  border-radius: 10px; color: var(--neu-text);
  font-family: var(--neu-font-mono); font-size: 11px; text-align: left; cursor: pointer;
}
.review-file-row:hover { background: var(--neu-bg-light); }
.review-file-row[data-active="true"] { background: var(--neu-bg-light); box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light); color: var(--neu-text); }
.review-file-status.is-added { color: var(--neu-success); }
.review-file-status.is-modified { color: var(--neu-warning); }
.review-file-name { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review-file-stats { display: flex; gap: 6px; font-size: 10px; }
.review-files[data-narrow="true"] .review-file-stats { display: none; }
.review-diff { flex: 1; min-width: 200px; display: flex; flex-direction: column; gap: 10px; overflow: hidden; margin-left: 10px; }
.review-diff-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 8px 10px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
  font-family: var(--neu-font-mono); font-size: 11px; color: var(--neu-text);
}
.review-diff-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review-diff-actions {
  display: flex;
  flex-wrap: wrap;
  justify-content: flex-end;
  gap: 2px;
}
.review-icon-btn { display: inline-flex; align-items: center; justify-content: center; width: 24px; height: 24px; background: transparent; border: none; color: var(--neu-muted); cursor: pointer; border-radius: 8px; }
.review-icon-btn:hover { background: var(--neu-bg-light); color: var(--neu-text); }
.review-icon-btn[data-active="true"] { background: var(--neu-bg-light); color: var(--neu-accent); }
.review-diff-content { flex: 1; min-height: 0; overflow-y: auto; overflow-x: auto; position: relative; font-family: var(--neu-font-mono); font-size: 11px; line-height: 1.65; background: var(--neu-bg-light); color: var(--neu-text); border-radius: 12px; box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light); padding: 12px 0 14px; }
.diff-hunk-nav {
  position: sticky;
  top: 8px;
  z-index: 5;
  display: flex;
  justify-content: flex-end;
  gap: 4px;
  padding: 4px 10px 4px 0;
  pointer-events: none;
}
.diff-hunk-nav .review-icon-btn { pointer-events: auto; background: var(--neu-bg); box-shadow: var(--neu-badge-inset); }
.review-diff-line { display: flex; min-width: 0; overflow: hidden; align-items: center; }
.review-diff-pos { width: 32px; flex-shrink: 0; text-align: right; padding-right: 6px; user-select: none; color: var(--neu-muted); }
.review-diff-sign { width: 16px; flex-shrink: 0; text-align: center; user-select: none; }
.review-diff-text { flex: 1; white-space: pre; padding-right: 10px; color: var(--neu-text); }
.review-diff-line.is-header { background: transparent; }
.review-diff-line.is-header .review-diff-text {
  color: var(--neu-muted);
  font-size: 10px;
  opacity: 0.82;
}
.review-diff-line.is-header .review-diff-sign,
.review-diff-line.is-header .review-diff-pos {
  color: var(--neu-muted);
  font-size: 10px;
}
.review-diff-line.is-removed { background: var(--neu-diff-removed-bg); }
.review-diff-line.is-removed .review-diff-sign { color: var(--neu-error); }
.review-diff-line.is-added { background: var(--neu-diff-added-bg); }
.review-diff-line.is-added .review-diff-sign { color: var(--neu-success); }
.diff-word-added { background: color-mix(in srgb, var(--neu-success) 38%, transparent); font-weight: 600; }
.diff-word-deleted { background: color-mix(in srgb, var(--neu-error) 38%, transparent); text-decoration: line-through; }
.tok-keyword { color: var(--neu-code-keyword); }
.tok-string { color: var(--neu-code-string); }
.tok-number { color: var(--neu-code-number); }
.tok-comment { color: var(--neu-muted); font-style: italic; }
.tok-ident { color: var(--neu-code-text); }
.ast-diff-list { padding: 8px 12px; display: flex; flex-direction: column; gap: 4px; }
.ast-search-form {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
  padding: 10px 12px;
}
.ast-search-form input {
  flex: 1 1 160px;
  min-width: 120px;
  padding: 5px 8px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  border: 1px solid var(--neu-border);
  border-radius: 8px;
  font-family: var(--neu-font-mono);
  font-size: 11px;
}
.ast-search-form button {
  padding: 5px 10px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  border: 1px solid var(--neu-border);
  border-radius: 8px;
  font-family: var(--neu-font-mono);
  font-size: 11px;
  cursor: pointer;
}
.ast-change-row { display: grid; grid-template-columns: 70px 1fr auto; gap: 8px; padding: 4px 6px; border-radius: 8px; font-family: var(--neu-font-mono); font-size: 11px; }
.ast-change-row[data-kind="added"] { background: var(--neu-diff-added-bg); }
.ast-change-row[data-kind="removed"] { background: var(--neu-diff-removed-bg); }
.ast-change-row[data-kind="moved"] { background: color-mix(in srgb, var(--neu-accent) 12%, transparent); }
.ast-change-kind { color: var(--neu-muted); text-transform: uppercase; }
.ast-change-node { color: var(--neu-text); font-weight: 600; }
.ast-change-pos { color: var(--neu-muted); }
.ast-change-group { margin-bottom: 8px; }
.ast-group-header { display: flex; justify-content: space-between; align-items: center; width: 100%; padding: 4px 8px; background: var(--neu-bg); border: none; border-radius: 8px; box-shadow: var(--neu-badge-inset); font-family: var(--neu-font-mono); font-size: 11px; color: var(--neu-text); font-weight: 600; cursor: pointer; }
.ast-group-count { color: var(--neu-muted); }
.ast-snippet { margin: 6px 12px; padding: 8px 10px; background: var(--neu-bg); border-radius: 8px; font-family: var(--neu-font-mono); font-size: 11px; color: var(--neu-text); white-space: pre-wrap; box-shadow: var(--neu-badge-inset); }
/* Keep virtual rows in normal block flow. A flex column here makes every
   row a shrinkable flex item, so large patches collapse their 22px rows and
   the split renderer visibly overlaps line content. */
.diff-split { display: block; }
.review-diff-split-row {
  display: grid;
  grid-template-columns: 32px 1fr 32px 1fr;
  min-width: 0;
  font-family: var(--neu-font-mono);
  font-size: 11px;
  line-height: 1.65;
  white-space: pre;
  overflow: hidden;
}
.review-diff-split-row.context { background: transparent; }
.review-diff-split-row.modify { background: color-mix(in srgb, var(--neu-warning) 10%, transparent); }
.review-diff-split-row.delete .review-diff-split-cell:first-of-type { background: var(--neu-diff-removed-bg); }
.review-diff-split-row.add .review-diff-split-cell:last-of-type { background: var(--neu-diff-added-bg); }
.review-diff-split-row .review-diff-split-cell {
  padding: 0 8px;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: pre;
}
.review-diff-footer {
  display: flex;
  justify-content: center;
  align-items: center;
  padding: 8px 10px;
  margin-top: 8px;
  overflow: hidden;
  background: var(--neu-bg);
  border-radius: 18px;
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
.review-commit-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  gap: 6px;
  width: auto;
  min-width: 0;
  max-width: calc(100% - 16px);
  margin: 0 8px;
  padding: 7px 14px;
  background: var(--neu-bg-light);
  color: var(--neu-accent);
  border: none;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light);
  transition: box-shadow 0.2s ease, background-color 0.2s ease, color 0.2s ease;
}
.review-commit-btn:hover {
  box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light);
  color: var(--neu-accent-soft);
}
.review-commit-btn:active {
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
  color: var(--neu-accent);
}
.review-commit-btn svg {
  transition: transform 0.15s ease, color 0.15s ease;
}
.review-commit-btn:active svg {
  transform: scale(0.82);
  opacity: 0.85;
}

.agent-panel { display: flex; flex-direction: column; height: 100%; min-height: 0; overflow: hidden; }
.agent-subtabs { display: flex; gap: 6px; padding: 0 12px 8px; flex-shrink: 0; }
.agent-subtab {
  flex: 1;
  padding: 6px 8px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-muted);
  font-size: 11px;
  cursor: pointer;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.agent-subtab[data-active="true"] {
  background: var(--neu-bg-light);
  color: var(--neu-text);
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
.agent-layout { display: flex; flex: 1; min-height: 0; }
.agent-sidebar { width: 220px; flex-shrink: 0; overflow-y: auto; padding: 8px; border-right: 1px solid var(--neu-divider); }
.agent-card { display: block; width: 100%; text-align: left; border: none; border-radius: 10px; padding: 8px 10px; margin-bottom: 6px; background: var(--neu-bg); color: var(--neu-text); cursor: pointer; box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light); }
.agent-card[data-active="true"] { box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light); }
.agent-card-title { font-size: 12px; font-weight: 600; margin-bottom: 2px; }
.agent-card-status { font-size: 10px; color: var(--neu-muted); margin-bottom: 2px; }
.agent-card-detail { font-size: 11px; color: var(--neu-muted); white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
.agent-stream { flex: 1; min-width: 0; min-height: 0; display: flex; flex-direction: column; }
.agent-stream .natalia-transcript { flex: 1; }
.agent-empty { padding: 12px; color: var(--neu-muted); font-size: 12px; }
.agent-tree-child { margin-left: 12px; }
.plan-panel-editor {
  flex: 1;
  min-height: 0;
  width: 100%;
  padding: 10px;
  border: none;
  border-radius: 12px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-family: var(--neu-font-mono);
  font-size: 12px;
  line-height: 1.65;
  resize: none;
  outline: none;
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
.plan-panel-preview {
  flex: 1;
  min-width: 0;
  min-height: 0;
  overflow: auto;
  padding: 14px 16px;
  border-radius: 12px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  font-family: var(--neu-font-mono);
  font-size: 13px;
  line-height: 1.7;
  overflow-wrap: break-word;
}
.plan-panel-preview.markdown-body h1,
.plan-panel-preview.markdown-body h2,
.plan-panel-preview.markdown-body h3,
.plan-panel-preview.markdown-body h4 {
  margin: 0.8em 0 0.4em;
  line-height: 1.3;
}
.plan-panel-preview.markdown-body h1 { font-size: 1.4em; }
.plan-panel-preview.markdown-body h2 { font-size: 1.25em; }
.plan-panel-preview.markdown-body h3 { font-size: 1.1em; }
.plan-panel-preview.markdown-body p { margin: 0.5em 0; }
.plan-panel-preview.markdown-body ul,
.plan-panel-preview.markdown-body ol { margin: 0.5em 0; padding-left: 1.4em; }
.plan-panel-preview.markdown-body li { margin: 0.15em 0; }
.plan-panel-preview.markdown-body code {
  padding: 0.1em 0.35em;
  border-radius: 4px;
  background: var(--neu-bg);
  font-family: var(--neu-font-mono);
  font-size: 0.9em;
  overflow-wrap: break-word;
}
.plan-panel-preview.markdown-body pre {
  padding: 10px;
  border-radius: 8px;
  background: var(--neu-bg);
  max-width: 100%;
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.plan-panel-preview.markdown-body blockquote {
  margin: 0.6em 0;
  padding: 0.2em 1em;
  border-left: 3px solid var(--neu-accent);
  color: var(--neu-muted);
}
.plan-panel-preview.markdown-body table {
  display: block;
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  margin: 0.6em 0;
}
.plan-panel-preview.markdown-body th,
.plan-panel-preview.markdown-body td {
  padding: 4px 8px;
  border: 1px solid var(--neu-divider);
  overflow-wrap: break-word;
}
.plan-panel-doc-meta {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  font-size: 10px;
  color: var(--neu-muted);
  padding: 2px 0 6px;
}
.plan-panel-doc-buttons {
  display: flex;
  gap: 6px;
  padding-bottom: 8px;
}
.plan-panel-notice {
  padding: 10px 12px;
  font-size: 11px;
  color: var(--neu-success);
}
.plan-panel-error {
  padding: 10px 12px;
  font-size: 11px;
  color: var(--neu-error);
}
.plan-panel-btn {
  padding: 5px 10px;
  border: none;
  border-radius: 8px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-family: inherit;
  font-size: 11px;
  cursor: pointer;
  flex-shrink: 0;
  box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light);
}
.plan-panel-btn:hover {
  color: var(--neu-accent);
}
.plan-panel-btn:active {
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.todo-row {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 8px;
  border-radius: 8px;
  font-size: 12px;
  color: var(--neu-text);
}
.todo-row:hover { background: var(--neu-bg-light); }
.todo-dot {
  width: 10px;
  height: 10px;
  border-radius: 50%;
  flex-shrink: 0;
  background: var(--neu-muted);
}
.todo-dot[data-status="in_progress"] { background: var(--neu-accent); }
.todo-dot[data-status="completed"] { background: var(--neu-success); }
.todo-text { flex: 1; min-width: 0; }
.todo-status { font-size: 10px; color: var(--neu-muted); }
.todo-completed-header {
  margin: 12px 0 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--neu-muted);
  text-transform: uppercase;
}
.todo-completed-text { color: var(--neu-muted); text-decoration: line-through; }
.agent-empty-full {
  flex: 1;
  min-height: 0;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  color: var(--neu-muted);
  text-align: center;
  padding: 24px;
}
.agent-tree-child { margin-left: 12px; }
.agent-stream-header { padding: 8px 12px; border-bottom: 1px solid var(--neu-divider); }
.agent-stream-title { font-size: 13px; font-weight: 600; }
.agent-stream-meta { font-size: 11px; color: var(--neu-muted); margin-top: 2px; }
.team-panel { flex: 1; min-height: 0; overflow-y: auto; padding: 10px; }
.team-header { font-size: 13px; font-weight: 600; margin-bottom: 8px; }
.team-stat { display: flex; justify-content: space-between; padding: 6px 10px; border-radius: 10px; background: var(--neu-bg); margin-bottom: 8px; font-size: 12px; }
.team-card { padding: 8px 10px; border-radius: 10px; background: var(--neu-bg); margin-bottom: 6px; box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light); }
.team-card-title { font-size: 12px; font-weight: 600; }
.team-card-detail { font-size: 11px; color: var(--neu-muted); }
.team-card-result { font-size: 11px; color: var(--neu-success); margin-top: 4px; }
.team-queue-card { padding: 10px 12px; border-radius: 12px; background: var(--neu-bg); margin-bottom: 8px; box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light); }
.team-queue-title { font-size: 12px; font-weight: 600; margin-bottom: 4px; }
.team-queue-meta { display: flex; gap: 8px; flex-wrap: wrap; font-size: 11px; color: var(--neu-muted); }
.team-queue-result { margin-top: 6px; font-size: 11px; color: var(--neu-text); white-space: pre-wrap; }
.natalia-tool-summary { flex: 1; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; font-size: 11px; color: var(--neu-muted); }
.team-card-result { font-size: 11px; color: var(--neu-success); margin-top: 4px; }
.team-card-error { font-size: 11px; color: var(--neu-error); margin-top: 4px; }
/* ===== Scrollbars ===== */
*::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
*::-webkit-scrollbar:horizontal {
  height: 6px;
}
*::-webkit-scrollbar-track {
  background: transparent;
}
*::-webkit-scrollbar-thumb {
  background: var(--neu-scrollbar);
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
*::-webkit-scrollbar-thumb:horizontal {
  border: 0;
  border-radius: 999px;
}
*::-webkit-scrollbar-track:horizontal {
  margin: 0 10px;
}
*::-webkit-scrollbar-thumb:hover {
  background: var(--neu-scrollbar-hover);
  background-clip: padding-box;
}
*::-webkit-scrollbar-thumb:horizontal:hover {
  border: 0;
  border-radius: 999px;
}

/* ===== Settings panel ===== */
.neu-plugin-window {
  width: min(520px, 90vw);
  max-height: 80vh;
  overflow-y: auto;
  border-radius: 18px;
  background: var(--neu-bg);
  box-shadow: 8px 8px 16px var(--neu-shadow-dark), -8px -8px 16px var(--neu-shadow-light);
  padding: 16px;
  scrollbar-width: thin;
  scrollbar-color: var(--neu-scrollbar) transparent;
}
.neu-plugin-window::-webkit-scrollbar {
  width: 8px;
  height: 8px;
}
.neu-plugin-window::-webkit-scrollbar-track {
  background: transparent;
}
.neu-plugin-window::-webkit-scrollbar-thumb {
  background: var(--neu-scrollbar);
  border-radius: 999px;
  border: 2px solid transparent;
  background-clip: padding-box;
}
.neu-plugin-window::-webkit-scrollbar-thumb:hover {
  background: var(--neu-scrollbar-hover);
  background-clip: padding-box;
}
.neu-plugin-body { display: flex; flex-direction: column; gap: 10px; margin-top: 10px; }
.neu-plugin-section-title { font-size: 12px; font-weight: 700; color: var(--neu-muted); text-transform: uppercase; }
.neu-plugin-row { display: flex; align-items: center; gap: 8px; padding: 8px 10px; border-radius: 12px; background: var(--neu-bg-light); }
.neu-plugin-main { flex: 1; min-width: 0; display: flex; flex-direction: column; gap: 2px; }
.neu-plugin-name { color: var(--neu-text); font-size: 12px; font-weight: 600; }
.neu-plugin-meta { color: var(--neu-muted); font-size: 10px; font-family: var(--neu-font-mono); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.neu-plugin-btn {
  padding: 5px 10px;
  border: 1px solid var(--neu-hairline);
  border-radius: 10px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  font-size: 11px;
  cursor: pointer;
  box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light);
}
.neu-confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: var(--neu-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
}
.neu-confirm-box {
  width: min(360px, 84vw);
  padding: 16px;
  border-radius: 16px;
  background: var(--neu-bg);
  box-shadow: 8px 8px 20px var(--neu-shadow-dark), -8px -8px 20px var(--neu-shadow-light);
}
.neu-confirm-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--neu-text);
  margin-bottom: 8px;
}
.neu-confirm-text {
  font-size: 12px;
  color: var(--neu-muted);
  margin-bottom: 14px;
}
.neu-confirm-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
.neu-confirm-danger {
  color: var(--neu-on-error);
  background: var(--neu-error);
  border-color: transparent;
}
.neu-plugin-btn:active {
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
  transform: translateY(1px);
}
.neu-plugin-switch {
  display: inline-flex;
  align-items: center;
  cursor: pointer;
}
.neu-plugin-switch input {
  display: none;
}
.neu-plugin-switch-track {
  width: 38px;
  height: 22px;
  border-radius: 999px;
  background: var(--neu-muted);
  opacity: 0.5;
  position: relative;
  transition: background 0.2s ease, opacity 0.2s ease;
}
.neu-plugin-switch-thumb {
  position: absolute;
  top: 2px;
  left: 2px;
  width: 18px;
  height: 18px;
  border-radius: 999px;
  background: var(--neu-thumb);
  box-shadow: var(--neu-thumb-shadow);
  transition: left 0.2s ease;
}
.neu-plugin-switch input:checked + .neu-plugin-switch-track {
  background: var(--neu-success);
  opacity: 1;
}
.neu-plugin-switch input:checked + .neu-plugin-switch-track .neu-plugin-switch-thumb {
  left: 18px;
}
.neu-plugin-empty { color: var(--neu-muted); font-size: 12px; }
.neu-plugin-error { color: var(--neu-error); font-size: 12px; }
.neu-plugin-install { display: flex; gap: 8px; }
.neu-plugin-input {
  flex: 1;
  min-width: 0;
  padding: 8px 10px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  font-size: 12px;
  outline: none;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-settings-backdrop {
  position: fixed;
  inset: 0;
  z-index: 50;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--neu-overlay-scrim);
  backdrop-filter: blur(2px);
}
.neu-settings-window {
  width: min(920px, 90vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  overflow: hidden;
}
.neu-settings-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  padding: 16px 20px;
  border-bottom: 1px solid var(--neu-hairline);
  flex-shrink: 0;
}
.neu-settings-title {
  font-size: 16px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-settings-close {
  width: 32px;
  height: 32px;
  display: inline-flex;
  align-items: center;
  justify-content: center;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-muted);
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light);
}
.neu-settings-close:active {
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-settings-body {
  flex: 1;
  min-height: 0;
  display: flex;
  overflow: hidden;
}
.neu-settings-categories {
  width: 200px;
  flex-shrink: 0;
  padding: 14px;
  border-right: 1px solid var(--neu-hairline);
  overflow-y: auto;
}
.neu-settings-category {
  display: block;
  width: 100%;
  padding: 10px 12px;
  margin-bottom: 4px;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: var(--neu-muted);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.neu-settings-category:hover {
  background: var(--neu-bg);
  color: var(--neu-text);
}
.neu-settings-category[data-active="true"] {
  background: var(--neu-bg);
  color: var(--neu-accent);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-settings-content {
  flex: 1;
  min-width: 0;
  padding: 18px 20px;
  overflow-y: auto;
}
.neu-settings-content-title {
  font-size: 14px;
  font-weight: 600;
  color: var(--neu-text);
  margin-bottom: 14px;
}
.neu-settings-footer {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 8px 20px;
  border-top: 1px solid var(--neu-hairline);
  font-size: 11px;
  color: var(--neu-muted);
}
.neu-settings-footer-title {
  font-weight: 700;
  color: var(--neu-text);
  white-space: nowrap;
}
.neu-settings-footer-sub {
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.neu-settings-footer-quote {
  margin-left: auto;
  font-style: italic;
  white-space: nowrap;
  overflow: hidden;
  text-overflow: ellipsis;
}
.neu-settings-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 12px 14px;
  margin-bottom: 8px;
  background: var(--neu-bg);
  border-radius: 12px;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-settings-item-main {
  display: flex;
  flex-direction: column;
  gap: 2px;
  min-width: 0;
}
.neu-settings-item-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-settings-item-description {
  font-size: 12px;
  color: var(--neu-muted);
}
.neu-settings-item-value {
  font-size: 12px;
  color: var(--neu-accent);
  white-space: nowrap;
  padding: 4px 10px;
  border-radius: 10px;
  background: var(--neu-bg-light);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
button.neu-settings-item.neu-settings-item-button {
  width: 100%;
  border: none;
  text-align: left;
  font-family: inherit;
  cursor: pointer;
}
button.neu-settings-item.neu-settings-item-button:active {
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
/* The exit. It reads as an action among settings, not as one more toggle —
   the one row whose default press is destructive. */
button.neu-settings-item.neu-settings-item-button.neu-settings-item-danger
  .neu-settings-item-label {
  color: var(--neu-danger, #c0392b);
  font-weight: 600;
}
button.neu-settings-item.neu-settings-item-button.neu-settings-item-danger:active {
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
.neu-settings-plugin-panel {
  margin-bottom: 8px;
}
.neu-settings-plugin-panel .neu-settings-item {
  margin-bottom: 0;
}
.neu-settings-plugin-panel button.neu-settings-item[data-active="true"] {
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
.neu-settings-plugin-panel button.neu-settings-item[data-active="true"] .neu-settings-item-label {
  color: var(--neu-accent);
}
.neu-plugin-panel-body {
  display: block;
  margin-top: 8px;
  margin-left: 14px;
  margin-bottom: 8px;
  padding: 10px 12px;
}

/* ===== Bulk session select ===== */
.neu-bulk-bar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
  padding: 6px;
  border-radius: 10px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-bulk-count {
  font-size: 11px;
  color: var(--neu-muted);
  padding: 0 2px;
}
.neu-bulk-actions {
  display: flex;
  flex-wrap: wrap;
  gap: 4px;
}
.neu-bulk-btn {
  flex: 1 1 auto;
  min-width: 0;
  padding: 5px 6px;
  border: none;
  border-radius: 8px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  font-family: inherit;
  font-size: 11px;
  text-align: center;
  cursor: pointer;
}
.neu-bulk-btn:hover {
  color: var(--neu-accent);
}
.neu-bulk-btn-danger {
  color: var(--neu-error);
}
.neu-bulk-check {
  width: 14px;
  height: 14px;
  flex-shrink: 0;
  border-radius: 4px;
  border: 1.5px solid var(--neu-muted);
  background: transparent;
}
.neu-bulk-check[data-checked="true"] {
  background: var(--neu-accent);
  border-color: var(--neu-accent);
  box-shadow: inset 0 0 0 2px var(--neu-bg-light);
}
/* ===== Left sidebar compact header ===== */
.neu-sidebar-header .neu-sidebar-title {
  margin-bottom: 0;
}
.neu-sidebar-header {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 8px;
  margin-bottom: 10px;
}
.neu-sidebar-actions {
  display: flex;
  align-items: center;
  gap: 4px;
}
.neu-icon-btn {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  width: 26px;
  height: 26px;
  padding: 0;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--neu-muted);
  cursor: pointer;
  transition: color 0.15s ease, background 0.15s ease;
}
.neu-icon-btn:hover {
  background: var(--neu-bg);
  color: var(--neu-accent);
}
.neu-icon-btn[data-active="true"] {
  background: var(--neu-bg);
  color: var(--neu-accent);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-new-workspace-btn:hover {
  color: var(--neu-accent);
}
.neu-icon-btn[data-tooltip] {
  position: relative;
}
.neu-icon-btn[data-tooltip]::after {
  content: attr(data-tooltip);
  position: absolute;
  top: calc(100% + 6px);
  right: 0;
  z-index: 40;
  padding: 4px 8px;
  border-radius: 6px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  font-size: 11px;
  line-height: 1.4;
  white-space: nowrap;
  opacity: 0;
  visibility: hidden;
  transform: translateY(-2px);
  box-shadow: 2px 2px 6px var(--neu-shadow-dark), -1px -1px 4px var(--neu-shadow-light);
  transition: opacity 0.12s ease, transform 0.12s ease, visibility 0s linear 0.12s;
  pointer-events: none;
}
.neu-icon-btn[data-tooltip]:hover::after {
  opacity: 1;
  visibility: visible;
  transform: translateY(0);
  transition-delay: 0s;
}
.neu-session-search {
  width: 100%;
  margin-bottom: 8px;
  padding: 6px 10px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  font-family: inherit;
  font-size: 12px;
  outline: none;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-sidebar-menu {
  position: absolute;
  top: 56px;
  right: 18px;
  z-index: 20;
  display: flex;
  flex-direction: column;
  gap: 4px;
  min-width: 148px;
  padding: 6px;
  background: var(--neu-bg-light);
  border-radius: 12px;
  box-shadow: 4px 4px 12px var(--neu-shadow-dark), -4px -4px 12px var(--neu-shadow-light);
}
.neu-sidebar-menu-item {
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--neu-text);
  font-family: inherit;
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.neu-sidebar-menu-item:hover {
  background: var(--neu-bg);
  color: var(--neu-accent);
}
.neu-sidebar-menu-toggle[data-active="true"] {
  background: var(--neu-bg);
  color: var(--neu-accent);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}

/* ===== Session action toolbar / panel ===== */
.neu-session-toolbar {
  display: flex;
  align-items: center;
  justify-content: space-between;
  margin-bottom: 8px;
  padding: 2px 4px;
}
.neu-session-toolbar-label {
  font-size: 11px;
  color: var(--neu-muted);
}
.neu-session-toolbar-btn {
  padding: 5px 10px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-size: 12px;
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light);
}
.neu-session-toolbar-btn:hover {
  box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light);
  color: var(--neu-accent);
}
.neu-session-toolbar-btn:active {
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-session-window {
  width: min(420px, 90vw);
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  overflow: hidden;
}
.neu-session-current {
  margin: 14px 20px 0;
  padding: 12px 14px;
  font-size: 13px;
  color: var(--neu-muted);
  background: var(--neu-bg);
  border-radius: 12px;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-session-current strong {
  color: var(--neu-text);
}
.neu-session-actions {
  padding: 14px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.neu-session-action-row {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 12px 14px;
  border: none;
  border-radius: 12px;
  background: var(--neu-bg);
  color: var(--neu-text);
  text-align: left;
  cursor: pointer;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-session-action-row:hover {
  background: var(--neu-bg-light);
}
.neu-session-action-label {
  font-size: 13px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-session-action-description {
  font-size: 12px;
  color: var(--neu-muted);
}

/* ===== Checkpoint panel ===== */
.neu-checkpoint-window {
  width: min(620px, 90vw);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  overflow: hidden;
}
.neu-checkpoint-current {
  padding: 12px 14px;
  margin: 14px 20px 0;
  border-radius: 12px;
  background: var(--neu-bg);
  font-size: 13px;
  color: var(--neu-muted);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-checkpoint-current strong { color: var(--neu-text); }
.neu-checkpoint-list {
  flex: 1;
  min-height: 0;
  padding: 14px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.neu-checkpoint-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-checkpoint-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.neu-checkpoint-title {
  display: flex;
  align-items: center;
  gap: 8px;
  font-size: 13px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-checkpoint-time {
  font-size: 11px;
  color: var(--neu-muted);
}
.neu-checkpoint-id {
  font-size: 11px;
  color: var(--neu-muted);
  font-family: var(--neu-font-mono);
}
.neu-checkpoint-status {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 8px;
  background: var(--neu-bg-light);
  color: var(--neu-muted);
}
.neu-checkpoint-status[data-current="true"] {
  color: var(--neu-accent);
}
.neu-checkpoint-action {
  padding: 5px 10px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  font-size: 12px;
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light);
}
.neu-checkpoint-action:active {
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-checkpoint-action:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
  background: var(--neu-bg);
}
.neu-checkpoint-actions {
  padding: 0 20px 18px;
  display: flex;
  justify-content: flex-end;
}
.neu-checkpoint-create {
  padding: 8px 16px;
  border: none;
  border-radius: 12px;
  background: var(--neu-accent);
  color: var(--neu-on-accent);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--neu-accent-shadow), -3px -3px 6px var(--neu-shadow-light);
}
.neu-checkpoint-create:active {
  box-shadow: inset 3px 3px 6px var(--neu-inset-pressed-dark), inset -3px -3px 6px var(--neu-inset-pressed-light);
}

/* ===== Permission approval panel ===== */
.neu-permission-window {
  width: min(520px, 90vw);
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  overflow: hidden;
}
.neu-permission-body {
  padding: 16px 20px 14px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.neu-permission-tool {
  display: flex;
  align-items: center;
  gap: 8px;
}
.neu-permission-tool-name {
  font-size: 15px;
  font-weight: 600;
  color: var(--neu-text);
  font-family: var(--neu-font-mono);
}
.neu-permission-tool-badge {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 8px;
  background: var(--neu-bg);
  color: var(--neu-warning);
}
.neu-permission-command {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 12px 14px;
  background: var(--neu-bg);
  border-radius: 12px;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-permission-label {
  font-size: 11px;
  color: var(--neu-muted);
  text-transform: uppercase;
}
.neu-permission-command-text {
  font-family: var(--neu-font-mono);
  font-size: 13px;
  color: var(--neu-text);
  white-space: pre-wrap;
  word-break: break-all;
}
.neu-permission-info {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 12px;
  color: var(--neu-muted);
}
.neu-permission-actions {
  display: flex;
  gap: 8px;
  padding: 0 20px 20px;
}
.neu-permission-btn {
  flex: 1;
  padding: 9px 12px;
  border: none;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light);
  transition: box-shadow 0.2s ease, background-color 0.2s ease, color 0.2s ease;
}
.neu-permission-btn:active {
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
.neu-permission-deny {
  background: var(--neu-bg);
  color: var(--neu-error);
}
.neu-permission-allow {
  background: var(--neu-bg);
  color: var(--neu-success);
}
.neu-permission-allow-session {
  background: var(--neu-accent);
  color: var(--neu-on-accent);
}

/* ===== Permission reject reason ===== */
.neu-permission-reject-box {
  padding: 0 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 10px;
}
.neu-permission-reject-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-permission-reason {
  width: 100%;
  min-height: 72px;
  resize: none;
  border: none;
  outline: none;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-family: inherit;
  font-size: 13px;
  line-height: 1.5;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-permission-reason::placeholder {
  color: var(--neu-muted);
}
.neu-permission-reject-submit {
  background: var(--neu-bg);
  color: var(--neu-error);
}

/* ===== Status & diagnostics panel ===== */
.neu-status-window {
  width: min(720px, 90vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  overflow: hidden;
}
.neu-status-tabs {
  display: flex;
  gap: 8px;
  padding: 14px 20px 0;
}
.neu-status-tabs .neu-settings-category {
  width: auto;
  padding: 8px 16px;
  background: var(--neu-bg);
}
.neu-status-content {
  flex: 1;
  min-height: 0;
  padding: 14px 20px 20px;
  overflow-y: auto;
}
.neu-status-grid {
  display: grid;
  grid-template-columns: repeat(2, minmax(0, 1fr));
  gap: 10px;
}
.neu-status-card {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 14px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-status-card-label {
  font-size: 11px;
  color: var(--neu-muted);
}
.neu-status-card-value {
  font-size: 14px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-status-diagnostics {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.neu-diagnostic-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-diagnostic-level {
  width: 48px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
}
.neu-diagnostic-row[data-level="info"] .neu-diagnostic-level { color: var(--neu-success); }
.neu-diagnostic-row[data-level="warn"] .neu-diagnostic-level { color: var(--neu-warning); }
.neu-diagnostic-row[data-level="error"] .neu-diagnostic-level { color: var(--neu-error); }
.neu-diagnostic-message {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--neu-text);
}
.neu-diagnostic-time {
  font-size: 11px;
  color: var(--neu-muted);
}
.neu-status-section-title {
  margin: 8px 0 4px;
  font-size: 11px;
  font-weight: 600;
  text-transform: uppercase;
  color: var(--neu-muted);
}
.neu-status-tools {
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.neu-status-tool-row,
.neu-status-cap-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-status-tool-row {
  width: 100%;
  border: none;
  text-align: left;
  cursor: pointer;
}
.neu-status-tool-arrow {
  margin-left: auto;
  color: var(--neu-muted);
  font-size: 10px;
  flex-shrink: 0;
}
.neu-status-tool-detail {
  margin: 4px 0 8px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--neu-bg-light);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-status-tool-detail-summary {
  font-size: 12px;
  color: var(--neu-text);
  white-space: pre-wrap;
  line-height: 1.6;
}
.neu-status-tool-detail-raw {
  margin: 8px 0 0;
  padding: 8px;
  max-height: 220px;
  overflow: auto;
  border-radius: 8px;
  background: var(--neu-bg);
  font-size: 11px;
  color: var(--neu-muted);
  white-space: pre-wrap;
  word-break: break-word;
}
.neu-status-tool-name,
.neu-status-cap-name {
  width: 100px;
  font-size: 12px;
  font-weight: 600;
  color: var(--neu-text);
  font-family: var(--neu-font-mono);
}
.neu-status-tool-description,
.neu-status-cap-grants {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--neu-muted);
}
.neu-status-tool-status {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 8px;
  background: var(--neu-bg-light);
  color: var(--neu-muted);
}
.neu-status-tool-status[data-pending="true"] {
  color: var(--neu-warning);
}
.neu-status-cap-version {
  font-size: 11px;
  color: var(--neu-accent);
}

/* ===== Providers & models panel ===== */
.neu-model-window {
  width: min(620px, 90vw);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  overflow: hidden;
}
.neu-model-tabs {
  display: flex;
  gap: 8px;
  padding: 14px 20px 0;
}
.neu-model-tabs .neu-settings-category {
  width: auto;
  padding: 8px 16px;
  background: var(--neu-bg);
}
.neu-model-content {
  flex: 1;
  min-height: 0;
  padding: 14px 20px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.neu-model-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-model-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--neu-text);
  font-family: var(--neu-font-mono);
}
.neu-model-kind {
  font-size: 12px;
  color: var(--neu-muted);
}
.neu-model-status {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 8px;
  background: var(--neu-bg-light);
  color: var(--neu-muted);
}
.neu-model-status[data-connected="true"] {
  color: var(--neu-success);
}
.neu-model-default {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 8px;
  background: var(--neu-bg-light);
  color: var(--neu-accent);
}
.neu-model-set-default {
  padding: 5px 10px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  font-size: 12px;
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light);
}
.neu-model-set-default:active {
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-model-set-default:disabled {
  opacity: 0.4;
  cursor: not-allowed;
  box-shadow: none;
}
.neu-model-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
}
.neu-model-add {
  padding: 8px 16px;
  border: none;
  border-radius: 12px;
  background: var(--neu-accent);
  color: var(--neu-on-accent);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--neu-accent-shadow), -3px -3px 6px var(--neu-shadow-light);
}
.neu-model-add:active {
  box-shadow: inset 3px 3px 6px var(--neu-inset-pressed-dark), inset -3px -3px 6px var(--neu-inset-pressed-light);
}

/* ===== Model tree ===== */
.neu-model-tree {
  flex: 1;
  min-height: 0;
  padding: 14px 20px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.neu-model-provider {
  border-radius: 14px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
  padding: 4px;
}
.neu-model-provider-header {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
  padding: 10px 12px;
  border: none;
  border-radius: 12px;
  background: transparent;
  color: var(--neu-text);
  font-size: 13px;
  font-weight: 600;
  text-align: left;
  cursor: pointer;
}
.neu-model-provider-header:hover {
  background: var(--neu-bg-light);
}
.neu-model-chevron {
  width: 12px;
  height: 12px;
  color: var(--neu-muted);
  transition: transform 0.2s ease;
  flex-shrink: 0;
}
.neu-model-chevron[data-expanded="true"] { transform: rotate(90deg); }
.neu-model-provider-name { flex: 1; min-width: 0; }
.neu-model-edit {
  flex-shrink: 0;
  padding: 5px 10px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-accent);
  font-size: 11px;
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light);
}
.neu-model-edit:hover {
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}

.neu-model-children {
  padding: 2px 6px 6px 34px;
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.neu-model-add-secondary {
  margin-left: 8px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  box-shadow: 3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light);
}

/* ===== Model form ===== */
.neu-form {
  flex: 1;
  min-height: 0;
  padding: 14px 20px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.neu-form-field {
  display: flex;
  flex-direction: column;
  gap: 5px;
}
.neu-form-label {
  font-size: 12px;
  color: var(--neu-muted);
}
.neu-form-input {
  width: 100%;
  padding: 9px 12px;
  border: none;
  outline: none;
  border-radius: 12px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-family: inherit;
  font-size: 13px;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-form-input::placeholder {
  color: var(--neu-muted);
}
.neu-form-select {
  appearance: none;
  -webkit-appearance: none;
  padding-right: 34px;
  background-image: url("data:image/svg+xml,%3Csvg xmlns='http://www.w3.org/2000/svg' width='14' height='14' viewBox='0 0 24 24' fill='none' stroke='%23888c8f' stroke-width='2' stroke-linecap='round' stroke-linejoin='round'%3E%3Cpath d='m6 9 6 6 6-6'/%3E%3C/svg%3E");
  background-repeat: no-repeat;
  background-position: right 12px center;
  background-size: 14px;
  cursor: pointer;
}
.neu-form-select option {
  background: var(--neu-bg-light);
  color: var(--neu-text);
}


.neu-select {
  position: relative;
  width: 100%;
}
.neu-select-trigger {
  display: flex;
  align-items: center;
  justify-content: space-between;
  width: 100%;
  padding: 9px 12px;
  border: none;
  outline: none;
  border-radius: 12px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-select-trigger:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.neu-select-value {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.neu-select-chevron {
  flex-shrink: 0;
  color: var(--neu-muted);
  transition: transform 0.2s ease;
}
.neu-select-chevron[data-open="true"] {
  transform: rotate(180deg);
}
.neu-select-menu {
  position: absolute;
  z-index: 50;
  top: calc(100% + 6px);
  left: 0;
  right: 0;
  max-height: 240px;
  overflow-y: auto;
  padding: 4px;
  border-radius: 12px;
  background: var(--neu-bg-light);
  box-shadow: 4px 4px 10px var(--neu-shadow-dark), -4px -4px 10px var(--neu-shadow-light);
}
.neu-select-option {
  display: block;
  width: 100%;
  padding: 8px 10px;
  border: none;
  border-radius: 8px;
  background: transparent;
  color: var(--neu-text);
  font-family: inherit;
  font-size: 13px;
  text-align: left;
  cursor: pointer;
}
.neu-select-option:hover,
.neu-select-option[data-active="true"] {
  background: var(--neu-bg);
  color: var(--neu-accent);
}
.neu-form-checkboxes {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
}
.neu-form-checkbox {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 6px 10px;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-size: 12px;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
  cursor: pointer;
}
.neu-form-checkbox input[type="checkbox"] {
  appearance: none;
  -webkit-appearance: none;
  width: 16px;
  height: 16px;
  border-radius: 50%;
  border: none;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
  cursor: pointer;
  flex-shrink: 0;
}
.neu-form-checkbox input[type="checkbox"]:checked {
  background: var(--neu-accent);
  box-shadow:
    inset 2px 2px 4px var(--neu-inset-pressed-dark),
    inset -2px -2px 4px var(--neu-inset-pressed-light),
    0 0 0 3px var(--neu-focus-ring);
}
.neu-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 6px;
}
.neu-form-btn {
  padding: 8px 16px;
  border: none;
  border-radius: 12px;
  font-size: 12px;
  font-weight: 500;
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light);
  transition: box-shadow 0.2s ease, background-color 0.2s ease, color 0.2s ease;
}
.neu-form-btn:active {
  box-shadow: inset 3px 3px 6px var(--neu-shadow-dark), inset -3px -3px 6px var(--neu-shadow-light);
}
.neu-form-cancel {
  background: var(--neu-bg);
  color: var(--neu-text);
}
.neu-form-primary {
  background: var(--neu-accent);
  color: var(--neu-on-accent);
}

/* ===== Provider edit form extensions ===== */
.neu-form-section-title {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-model-edit-row {
  display: flex;
  align-items: center;
  gap: 8px;
  flex-wrap: wrap;
}
.neu-model-edit-row .neu-form-input {
  flex: 1;
  min-width: 120px;
}
.neu-model-remove {
  padding: 6px 10px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-error);
  font-size: 12px;
  cursor: pointer;
  box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light);
}
.neu-model-remove:active {
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-model-add-full {
  display: flex;
  align-items: center;
  justify-content: center;
  width: 100%;
  margin: 0;
}

/* ===== Extensions panel ===== */
.neu-extensions-window {
  width: min(640px, 90vw);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  overflow: hidden;
}
.neu-extensions-tabs {
  display: flex;
  gap: 8px;
  padding: 14px 20px 0;
}
.neu-extensions-tabs .neu-settings-category {
  width: auto;
  padding: 8px 16px;
  background: var(--neu-bg);
}
.neu-extensions-content {
  flex: 1;
  min-height: 0;
  padding: 14px 20px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.neu-extension-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-extension-name {
  width: 110px;
  font-size: 12px;
  font-weight: 600;
  color: var(--neu-text);
  font-family: var(--neu-font-mono);
}
.neu-extension-description {
  flex: 1;
  min-width: 0;
  font-size: 12px;
  color: var(--neu-muted);
}
.neu-extension-status,
.neu-extension-toggle {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 8px;
  background: var(--neu-bg-light);
  color: var(--neu-muted);
  white-space: nowrap;
}
.neu-extension-status[data-connected="true"],
.neu-extension-toggle[data-enabled="true"] {
  color: var(--neu-success);
}
.neu-extension-toggle[data-enabled="false"] {
  color: var(--neu-error);
}
/*
 * The skill row's switch (iOS shape): a pill with a knob, so "off" is a
 * position, not a colour. The pill's own track colour follows the state; the
 * knob slides. A disabled attribute keeps the busy row from being toggled
 * twice.
 */
.neu-extension-switch {
  display: inline-flex;
  align-items: center;
  gap: 6px;
  padding: 3px 8px 3px 4px;
  border: none;
  border-radius: 999px;
  background: var(--neu-bg-light);
  color: var(--neu-muted);
  font-size: 11px;
  white-space: nowrap;
  cursor: pointer;
  box-shadow:
    inset 2px 2px 4px var(--neu-shadow-dark),
    inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-extension-switch:disabled {
  opacity: 0.6;
  cursor: default;
}
.neu-extension-switch-knob {
  width: 12px;
  height: 12px;
  border-radius: 50%;
  background: var(--neu-muted);
  transition: transform 120ms ease;
}
.neu-extension-switch[data-enabled="true"] {
  color: var(--neu-success);
}
.neu-extension-switch[data-enabled="true"] .neu-extension-switch-knob {
  background: var(--neu-success);
  transform: translateX(2px);
}
.neu-extension-actions {
  display: flex;
  justify-content: flex-end;
  margin-top: 6px;
}
.neu-extension-add {
  padding: 8px 16px;
  border: none;
  border-radius: 12px;
  background: var(--neu-accent);
  color: var(--neu-on-accent);
  font-size: 12px;
  font-weight: 600;
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--neu-accent-shadow), -3px -3px 6px var(--neu-shadow-light);
}
.neu-extension-add:active {
  box-shadow: inset 3px 3px 6px var(--neu-inset-pressed-dark), inset -3px -3px 6px var(--neu-inset-pressed-light);
}

/* ===== Inline extensions in settings ===== */
.neu-extension-inline-section {
  margin-bottom: 14px;
}
.neu-extension-inline-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--neu-text);
  margin-bottom: 8px;
}

/* ===== Extension row actions ===== */
.neu-extension-btn {
  padding: 5px 10px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  font-size: 12px;
  cursor: pointer;
  box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light);
  white-space: nowrap;
}
.neu-extension-btn:active {
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-extension-remove {
  color: var(--neu-error);
}
.neu-extension-primary-btn {
  background: var(--neu-accent);
  color: var(--neu-on-accent);
}
.neu-extension-add-row {
  display: flex;
  gap: 8px;
  align-items: center;
  padding: 8px 0 4px;
  flex-wrap: wrap;
}
.neu-extension-add-row .neu-form-input {
  flex: 1;
  min-width: 120px;
}

/* ===== Extension add forms ===== */
.neu-extension-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 0 4px;
}
.neu-extension-form-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}

/* ===== Workspace search panel ===== */
.neu-search-window {
  width: min(620px, 90vw);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  overflow: hidden;
}
.neu-search-body {
  flex: 1;
  min-height: 0;
  padding: 14px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.neu-search-input {
  flex-shrink: 0;
}
.neu-search-results {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.neu-search-result {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  padding: 10px 12px;
  border: none;
  border-radius: 12px;
  background: var(--neu-bg);
  color: var(--neu-text);
  text-align: left;
  cursor: pointer;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-search-result:hover {
  background: var(--neu-bg-light);
}
.neu-search-path {
  font-size: 12px;
  font-weight: 600;
  color: var(--neu-accent);
  font-family: var(--neu-font-mono);
}
.neu-search-snippet {
  font-size: 12px;
  color: var(--neu-muted);
  font-family: var(--neu-font-mono);
}

/* ===== Help panel ===== */
.neu-help-window {
  width: min(560px, 90vw);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  overflow: hidden;
}
.neu-help-body {
  flex: 1;
  min-height: 0;
  padding: 14px 20px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.neu-help-section-title {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-help-item {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-help-item-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-help-item-text {
  font-size: 12px;
  color: var(--neu-muted);
}
.neu-help-shortcut {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 8px 12px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-help-shortcut-keys {
  min-width: 130px;
  font-size: 12px;
  font-weight: 600;
  color: var(--neu-accent);
  font-family: var(--neu-font-mono);
}
.neu-help-shortcut-desc {
  font-size: 12px;
  color: var(--neu-muted);
}

/* ===== Stash panel ===== */
.neu-stash-window {
  width: min(620px, 90vw);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  overflow: hidden;
}
.neu-stash-body {
  flex: 1;
  min-height: 0;
  padding: 14px 20px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.neu-stash-item {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-stash-item-main {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  gap: 2px;
}
.neu-stash-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-stash-content {
  font-size: 12px;
  color: var(--neu-muted);
}
.neu-stash-time {
  font-size: 11px;
  color: var(--neu-muted);
}
.neu-stash-btn {
  padding: 5px 10px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg-light);
  color: var(--neu-text);
  font-size: 12px;
  cursor: pointer;
  box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light);
}
.neu-stash-btn:active {
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-stash-remove {
  color: var(--neu-error);
}
.neu-stash-form {
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 8px 0 4px;
}
.neu-stash-textarea {
  min-height: 72px;
  resize: none;
}

/* ===== Flow / Task panel ===== */
.neu-flow-window {
  width: min(620px, 90vw);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  overflow: hidden;
}
.neu-flow-tabs {
  display: flex;
  gap: 8px;
  padding: 14px 20px 0;
}
.neu-flow-tabs .neu-settings-category {
  width: auto;
  padding: 8px 16px;
  background: var(--neu-bg);
}
.neu-flow-content {
  flex: 1;
  min-height: 0;
  padding: 14px 20px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.neu-flow-row {
  display: flex;
  align-items: center;
  gap: 10px;
  padding: 12px 14px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-flow-name {
  flex: 1;
  min-width: 0;
  font-size: 13px;
  font-weight: 600;
  color: var(--neu-text);
  font-family: var(--neu-font-mono);
}
.neu-flow-detail {
  font-size: 12px;
  color: var(--neu-muted);
}
.neu-flow-status {
  font-size: 11px;
  padding: 3px 8px;
  border-radius: 8px;
  background: var(--neu-bg-light);
  color: var(--neu-muted);
  white-space: nowrap;
}
.neu-flow-status[data-running="true"] {
  color: var(--neu-success);
}

/* ===== Flow / Task detail ===== */
.neu-flow-card {
  display: flex;
  flex-direction: column;
  align-items: flex-start;
  gap: 2px;
  width: 100%;
  padding: 12px 14px;
  border: none;
  border-radius: 12px;
  background: var(--neu-bg);
  color: var(--neu-text);
  text-align: left;
  cursor: pointer;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-flow-card:hover {
  background: var(--neu-bg-light);
}
.neu-flow-card-title {
  font-size: 13px;
  font-weight: 600;
}
.neu-flow-card-id {
  font-size: 11px;
  color: var(--neu-muted);
  font-family: var(--neu-font-mono);
}
.neu-flow-card-meta {
  font-size: 11px;
  color: var(--neu-muted);
}
.neu-flow-back {
  align-self: flex-start;
  padding: 5px 10px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-size: 12px;
  cursor: pointer;
  box-shadow: 2px 2px 4px var(--neu-shadow-dark), -2px -2px 4px var(--neu-shadow-light);
}
.neu-flow-detail-title {
  font-size: 15px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-flow-detail-id {
  font-size: 11px;
  color: var(--neu-muted);
  font-family: var(--neu-font-mono);
}
.neu-flow-detail-field {
  font-size: 12px;
  color: var(--neu-muted);
  margin-top: 2px;
}
.neu-flow-module {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-flow-module-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.neu-flow-module-name {
  font-size: 13px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-flow-module-type {
  font-size: 11px;
  color: var(--neu-accent);
  font-family: var(--neu-font-mono);
}
.neu-flow-module-enabled {
  margin-left: auto;
  font-size: 11px;
  color: var(--neu-muted);
}
.neu-flow-module-enabled[data-enabled="true"] {
  color: var(--neu-success);
}
.neu-flow-module-instructions {
  font-size: 12px;
  color: var(--neu-muted);
}
.neu-flow-prompt {
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--neu-bg);
  color: var(--neu-text);
  font-size: 12px;
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}

/* ===== Flow editor section title ===== */
.neu-flow-section-title {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--neu-text);
}

/* ===== Flow preview & problems ===== */
.neu-flow-preview {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-flow-preview-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--neu-text);
}
.neu-flow-problems {
  display: flex;
  flex-direction: column;
  gap: 4px;
}
.neu-flow-problem {
  padding: 6px 10px;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-warning);
  font-size: 12px;
}

/* ===== Sandbox panel ===== */
.neu-sandbox-window {
  width: min(620px, 90vw);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  overflow: hidden;
}
.neu-sandbox-body {
  flex: 1;
  min-height: 0;
  padding: 14px 20px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.neu-sandbox-change {
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-warning);
  font-size: 12px;
}

/* ===== Governance panel ===== */
.neu-governance-window {
  width: min(720px, 90vw);
  max-height: 80vh;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  overflow: hidden;
}
.neu-governance-tabs {
  display: flex;
  flex-wrap: wrap;
  gap: 8px;
  padding: 14px 20px 0;
}
.neu-governance-tabs .neu-settings-category {
  width: auto;
  padding: 8px 14px;
  background: var(--neu-bg);
}
/* The pane must pass a bounded height down to neu-governance-content, or the
   nested scrollports (work-graph virtual window, tab lists) never resolve and
   every tab renders unbounded content. */
.governance-pane {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.neu-governance-content {
  flex: 1;
  min-height: 0;
  padding: 14px 20px 20px;
  overflow-y: auto;
  display: flex;
  flex-direction: column;
  gap: 8px;
}
.neu-gov-row {
  display: flex;
  flex-direction: column;
  gap: 2px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-gov-title {
  font-size: 12px;
  font-weight: 600;
  color: var(--neu-accent);
  font-family: var(--neu-font-mono);
}
.neu-gov-title[data-priority="critical"],
.neu-gov-title[data-priority="failed"],
.neu-gov-title[data-priority="high"] {
  color: var(--neu-error);
}
.neu-gov-title[data-priority="warning"],
.neu-gov-title[data-priority="superseded"] {
  color: var(--neu-warning);
}
.neu-gov-title[data-priority="accepted"],
.neu-gov-title[data-priority="validated"] {
  color: var(--neu-success);
}
.neu-gov-text {
  font-size: 13px;
  color: var(--neu-text);
}
.neu-gov-meta {
  font-size: 11px;
  color: var(--neu-muted);
}
.neu-gov-section-title {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--neu-text);
}
.gov-card {
  margin-bottom: 6px;
  padding: 7px 9px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07);
  font-size: 12px;
}
.gov-scope-switch {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.gov-scope-btn {
  padding: 2px 8px;
  border-radius: 999px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  background: transparent;
  color: var(--neu-muted);
  cursor: pointer;
  font-size: 11px;
}
.gov-scope-btn[data-active="true"] {
  color: var(--neu-text);
  border-color: rgba(140, 180, 255, 0.65);
  background: rgba(140, 180, 255, 0.14);
}
.gov-completion-card {
  border-left: 3px solid rgba(120, 200, 150, 0.7);
}
.gov-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.gov-card-meta {
  color: var(--neu-muted);
  font-size: 10px;
  white-space: nowrap;
}
.gov-card-section {
  margin-top: 5px;
  padding-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.gov-card-label {
  margin-bottom: 2px;
  color: var(--neu-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.gov-card-text {
  white-space: pre-wrap;
  word-break: break-word;
  line-height: 1.45;
}
.neu-gov-empty {
  margin-top: 8px;
  padding: 14px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.03);
  color: var(--neu-muted);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
}
.neu-gov-error {
  margin-bottom: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(220, 80, 80, 0.14);
  color: #e6a0a0;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
}
.neu-gov-action-note {
  margin-bottom: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  background: rgba(120, 160, 255, 0.12);
  color: #a9c2ff;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ===== Workspace add panel ===== */
.neu-workspace-window {
  width: min(480px, 90vw);
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: 6px 6px 16px var(--neu-shadow-dark), -6px -6px 16px var(--neu-shadow-light);
  overflow: hidden;
}
.neu-workspace-body {
  padding: 14px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}
.neu-workspace-list {
  display: flex;
  flex-direction: column;
  gap: 8px;
  max-height: 180px;
  overflow-y: auto;
}
.neu-workspace-item {
  display: flex;
  align-items: center;
  justify-content: space-between;
  gap: 12px;
  padding: 10px 12px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}
.neu-workspace-item-info {
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  flex: 1;
}
.neu-workspace-item-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--neu-text);
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.neu-workspace-item-badge {
  flex-shrink: 0;
  padding: 2px 8px;
  border-radius: 999px;
  background: var(--neu-accent);
  color: var(--neu-on-accent);
  font-size: 11px;
  font-weight: 600;
}
.neu-workspace-item-actions {
  display: flex;
  align-items: center;
  gap: 6px;
  flex-shrink: 0;
}
.neu-workspace-item-actions .neu-workspace-switch {
  padding: 6px 14px;
  min-width: 58px;
  background: var(--neu-bg);
  color: var(--neu-text);
  border: 1px solid var(--neu-hairline);
  font-size: 12px;
  font-weight: 600;
  box-shadow: 2px 2px 5px var(--neu-shadow-dark), -2px -2px 5px var(--neu-shadow-light);
}
.neu-workspace-item-actions .neu-workspace-switch:hover:not(:disabled) {
  color: var(--neu-accent);
  border-color: var(--neu-accent);
}
.neu-workspace-item-actions .neu-workspace-switch:disabled {
  opacity: 0.5;
  cursor: not-allowed;
}
.neu-workspace-item-actions .neu-workspace-remove {
  padding: 6px 14px;
  min-width: 58px;
  background: color-mix(in srgb, var(--neu-error) 10%, var(--neu-bg));
  color: var(--neu-error);
  border: 1px solid color-mix(in srgb, var(--neu-error) 35%, transparent);
  font-size: 12px;
  font-weight: 600;
  box-shadow: 2px 2px 5px var(--neu-shadow-dark), -2px -2px 5px var(--neu-shadow-light);
}
.neu-workspace-item-actions .neu-workspace-remove:hover {
  background: color-mix(in srgb, var(--neu-error) 18%, var(--neu-bg));
}

/* ===== Workspace success ===== */
.neu-workspace-success {
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-success);
  font-size: 12px;
}

/* ===== Workspace error ===== */
.neu-workspace-error {
  padding: 8px 10px;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-error);
  font-size: 12px;
}

/* ===== Smooth transitions ===== */
.neu-workspace-row,
.neu-tree-row,
.neu-secondary-tab,
.neu-pane .natalia-action-btn,
.neu-pane .natalia-composer-icon-btn,
.neu-pane .natalia-composer-submit,
.file-tree-item,
.review-file-row,
.review-icon-btn,
.neu-file-editor-tab {
  transition:
    box-shadow 0.25s ease,
    background-color 0.25s ease,
    color 0.25s ease,
    transform 0.25s ease;
}

@keyframes neu-blink {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.4; }
}

/* ===== Responsive ===== */
@media (max-width: 1200px) {
  .neu-shell { padding: 10px; gap: 10px; }
  .neu-app { gap: 10px; }
  .neu-pane { padding: 12px; }
  .neu-secondary { max-width: 380px; }
  .neu-sidebar { max-width: 240px; }
}
@media (max-width: 1700px) {
  .neu-shell[data-compact="true"] .neu-sidebar {
    width: min(320px, 32vw);
  }
  .neu-shell[data-compact="true"] .neu-secondary {
    width: min(720px, 66vw);
  }
  .neu-shell[data-compact="true"] .neu-resizer {
    display: block;
  }
  .neu-shell[data-compact="true"] .neu-main-panes {
    flex-direction: column;
  }
  .neu-shell[data-compact="true"] .neu-pane-divider {
    height: 8px;
    width: auto;
  }
  .neu-shell[data-compact="true"] .neu-pane {
    min-height: 220px;
  }
  .neu-main-panes { gap: 10px; }
}

/* Compact but short viewports: horizontal main panes are better than
   stacking two panes vertically when height is at or below 1000px. */
@media (max-width: 1700px) and (min-width: 1001px) and (max-height: 1000px) {
  .neu-shell[data-compact="true"] .neu-main-panes {
    flex-direction: row;
  }
  .neu-shell[data-compact="true"] .neu-pane-divider {
    height: auto;
    width: 8px;
  }
}
@media (max-width: 1000px) {
  .neu-shell { padding: 6px; gap: 6px; }
  .neu-app { gap: 6px; }
  .neu-main-panes { gap: 6px; }
  .neu-pane-divider { height: 8px; width: auto; }
  .neu-pane { min-height: 220px; }
  .neu-shell[data-tiny="true"] .neu-main-panes { flex-direction: column; }
  .neu-secondary-tabs { flex-wrap: nowrap; overflow-x: auto; }
  .neu-secondary-tab { white-space: nowrap; flex-shrink: 0; }

  /* Tiny mode: right sidebar takes the whole content area when opened. */
  .neu-shell[data-tiny="true"][data-right-open="true"] .neu-main {
    display: none;
  }
  .neu-shell[data-tiny="true"][data-right-open="true"] .neu-secondary {
    flex: 1;
    width: auto !important;
    max-width: none;
    min-width: 0;
  }
  .neu-shell[data-tiny="true"][data-right-open="true"] .neu-right-resizer {
    display: none;
  }
}

.neu-edit-window {
  width: min(480px, 90vw);
}
.neu-edit-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  max-height: min(70vh, 720px);
  overflow-y: auto;
}}





.neu-tool-family-list {
  display: flex;
  flex-direction: column;
  gap: 10px;
  max-height: 360px;
  overflow-y: auto;
  padding: 6px;
}
.neu-tool-family {
  display: flex;
  flex-direction: column;
  gap: 6px;
}
.neu-tool-family-check {
  display: flex;
  align-items: center;
  gap: 10px;
  width: 100%;
  min-height: 38px;
  padding: 8px 12px;
  border-radius: 12px;
}
.neu-tool-family-name {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  font-weight: 600;
}
.neu-tool-family-count {
  flex-shrink: 0;
  font-size: 11px;
  opacity: 0.62;
}
.neu-tool-family-title {
  padding: 0 4px;
  font-size: 11px;
  font-weight: 600;
  opacity: 0.68;
}
.neu-tool-family-empty {
  padding: 10px 12px;
  font-size: 12px;
  opacity: 0.65;
}
.neu-tool-select-grid {
  display: grid;
  grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
  gap: 6px;
  padding: 0;
}
.neu-tool-check {
  width: auto;
  min-height: 32px;
  margin-bottom: 0;
  padding: 6px 10px;
  font-size: 12px;
  gap: 8px;
  border-radius: 10px;
}
.neu-tool-check span {
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
}

.neu-permission-row {
  display: flex;
  align-items: center;
  gap: 8px;
  width: 100%;
}
.neu-permission-row .neu-settings-item {
  flex: 1;
  min-width: 0;
}
.neu-permission-edit {
  flex-shrink: 0;
  padding: 8px 12px;
  border: none;
  border-radius: 10px;
  background: var(--neu-bg);
  color: var(--neu-accent);
  font-size: 12px;
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light);
}
.neu-permission-edit:hover {
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light);
}

.neu-main-toolbar {
  display: flex;
  gap: 8px;
  padding: 8px 12px;
  border-bottom: 1px solid var(--neu-hairline-accent);
}
.neu-main-toolbar .neu-select {
  flex: 1;
  min-width: 0;
}

.neu-select-menu-top {
  top: auto;
  bottom: calc(100% + 6px);
}

/* Question panel (unified with permission panel) */
.neu-question-item { display: flex; flex-direction: column; gap: 8px; margin-bottom: 12px; }
.neu-question-header { font-size: 14px; font-weight: 600; color: var(--neu-text); }
.neu-question-options { display: flex; flex-direction: column; gap: 8px; }
.neu-question-option-active { color: var(--neu-accent) !important; box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light) !important; }
.neu-question-option-description { display: block; font-size: 12px; color: var(--neu-muted); }
.neu-question-custom { width: 100%; box-sizing: border-box; padding: 10px 12px; border: none; border-radius: 12px; background: var(--neu-bg); color: var(--neu-text); font-family: inherit; font-size: 13px; box-shadow: inset 2px 2px 4px var(--neu-shadow-dark), inset -2px -2px 4px var(--neu-shadow-light); outline: none; }

/* Live status pulse */
@keyframes neu-pulse {
  0%, 100% { opacity: 1; }
  50% { opacity: 0.25; }
}
.neu-pane-status[data-running="true"]::before {
  content: "";
  display: inline-block;
  width: 8px;
  height: 8px;
  margin-right: 6px;
  border-radius: 50%;
  background: var(--neu-accent);
  animation: neu-pulse 1s infinite;
}

/* Activity bar above composer */
.neu-activity-bar {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 10px 0;
  font-size: 12px;
  color: var(--neu-muted);
}
.neu-activity-pulse {
  width: 8px;
  height: 8px;
  border-radius: 50%;
  background: var(--neu-muted);
}
.neu-activity-bar[data-running="true"] .neu-activity-pulse {
  background: var(--neu-accent);
  animation: neu-pulse 1s infinite;
}
/* Goal pill: one pause/resume toggle + inline edit + clear */
.neu-goal-slot {
  position: relative;
  display: inline-flex;
  align-items: center;
}
.neu-goal-control {
  display: inline-flex;
  align-items: center;
  gap: 1px;
  padding: 2px;
  border-radius: 999px;
  background: rgba(120, 160, 255, 0.14);
  box-shadow: inset 0 0 0 1px rgba(120, 160, 255, 0.22);
}
.neu-goal-control[data-phase="paused"] {
  background: rgba(230, 180, 90, 0.16);
  box-shadow: inset 0 0 0 1px rgba(230, 180, 90, 0.32);
}
.neu-goal-control[data-phase="blocked"] {
  background: rgba(220, 90, 90, 0.2);
  box-shadow: inset 0 0 0 1px rgba(220, 90, 90, 0.36);
}
.neu-goal-control[data-phase="complete"] {
  opacity: 0.7;
}
.neu-goal-chip {
  display: inline-flex;
  align-items: baseline;
  gap: 6px;
  max-width: 320px;
  overflow: hidden;
  padding: 1px 8px 2px 10px;
  white-space: nowrap;
}
.neu-goal-chip-label {
  font-size: 9px;
  letter-spacing: 0.08em;
  text-transform: uppercase;
  color: var(--neu-accent);
  opacity: 0.85;
}
.neu-goal-chip-text {
  overflow: hidden;
  text-overflow: ellipsis;
}
.neu-goal-chip-round {
  opacity: 0.65;
  font-variant-numeric: tabular-nums;
}
.session-usage-bar {
  display: flex;
  flex-wrap: nowrap;
  align-items: center;
  gap: 6px;
  width: 100%;
  box-sizing: border-box;
  min-height: 26px;
  padding: 3px 10px;
  margin: 0 0 4px;
  border-radius: 8px;
  background: rgba(255, 255, 255, 0.04);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
  font-size: 11px;
  line-height: 1.5;
  opacity: 0.82;
  font-variant-numeric: tabular-nums;
  overflow-x: auto;
  scrollbar-width: none;
}
.session-usage-bar::-webkit-scrollbar {
  display: none;
}
.session-usage-seg {
  white-space: nowrap;
  flex-shrink: 0;
}
.session-usage-sep {
  opacity: 0.4;
  flex-shrink: 0;
}
/* Work Graph: one fixed-height row model shared by the virtual window
   (WORK_GRAPH_ROW_HEIGHT). Rows are positioned by the virtualizer, never
   DOM-measored, so the height here is the estimate too. */
.wg-tree,
.wg-graph {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
  gap: 1px;
  font-size: 12px;
}
.wg-tab {
  display: flex;
  flex-direction: column;
  flex: 1;
  min-height: 0;
}
.wg-scroll {
  flex: 1;
  min-height: 0;
  overflow-y: auto;
  overscroll-behavior: contain;
}
.wg-view-toggle {
  display: flex;
  gap: 6px;
  margin-bottom: 6px;
}
.wg-view-toggle .constitution-btn[data-active="true"] {
  box-shadow: inset 2px 2px 4px var(--neu-shadow-dark),
    inset -2px -2px 4px var(--neu-shadow-light);
  color: var(--neu-accent);
}
.wg-search {
  display: flex;
  align-items: center;
  gap: 4px;
  margin-bottom: 5px;
}
.wg-search-input {
  flex: 1;
  min-width: 0;
  padding: 4px 7px;
  border: none;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.06);
  color: inherit;
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.08);
  font-size: 11px;
}
.wg-search-clear {
  border: none;
  background: transparent;
  color: var(--neu-muted);
  cursor: pointer;
  font-size: 10px;
}
.wg-search-results {
  display: flex;
  flex-direction: column;
  gap: 2px;
  margin-bottom: 6px;
}
.wg-search-result {
  display: flex;
  align-items: baseline;
  gap: 5px;
  padding: 3px 5px;
  border: none;
  border-radius: 5px;
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
  cursor: pointer;
  text-align: left;
}
.wg-search-result:hover {
  background: rgba(255, 255, 255, 0.09);
}
/* One row height for every section header and tree node (12px × 1.5 line +
   2×2px padding); the virtualizer's fixed-height estimate must match. */
.wg-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  box-sizing: border-box;
  width: 100%;
  height: 22px;
  flex: none;
  padding: 2px 4px;
  border: none;
  border-radius: 4px;
  background: transparent;
  color: inherit;
  text-align: left;
  font: inherit;
  overflow: hidden;
}
.wg-row-section {
  align-items: center;
}
/* Flattened rows keep their causal depth as an indent (the tree hierarchy the
   recursive renderer used to express by nesting); the indent itself is set as
   an inline padding because it depends on the row's depth. */
.wg-node-row {
  border-left: 1px solid rgba(255, 255, 255, 0.08);
}
.wg-node-row[data-depth="0"] {
  border-left-color: transparent;
}
.wg-node-row[data-unattributed="true"] {
  background: rgba(230, 180, 90, 0.08);
}
.wg-row-section[data-tone="inbound"] {
  color: color-mix(in srgb, var(--neu-accent) 70%, var(--neu-text));
}
.wg-row-section[data-tone="outbound"] {
  color: color-mix(in srgb, var(--neu-success) 70%, var(--neu-text));
}
.wg-row-section[data-tone="unattributed"] {
  color: color-mix(in srgb, #e6b45a 80%, var(--neu-text));
}
/* Pagination is scroll-driven (no button, no status line): reaching the end of
   the window appends the next page. */
button.wg-node-row:not(:disabled) {
  cursor: pointer;
}
button.wg-node-row:disabled {
  cursor: default;
}
button.wg-node-row:hover {
  background: rgba(255, 255, 255, 0.05);
}
.wg-twisty {
  flex: none;
  width: 12px;
  opacity: 0.6;
  font-size: 10px;
}
.wg-kind {
  flex: none;
  padding: 0 5px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.07);
  font-size: 10px;
  letter-spacing: 0.03em;
  opacity: 0.85;
}
.wg-summary {
  flex: 1;
  min-width: 0;
  overflow: hidden;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.wg-via {
  flex: none;
  opacity: 0.5;
  font-size: 10px;
}
.wg-section-title {
  font-size: 10px;
  letter-spacing: 0.06em;
  text-transform: uppercase;
  opacity: 0.7;
  margin-bottom: 0;
}
/* The active plan's applicable constitution constraints (ledger plan §5):
   the plan is judged against these, so the header names them. */
.plan-constraints {
  margin: 6px 0 0;
  padding: 6px 10px;
  border: 1px solid var(--neu-border, rgba(128, 128, 128, 0.3));
  border-radius: 6px;
  font-size: 12px;
}
.plan-constraints-title {
  font-weight: 600;
  opacity: 0.75;
  margin-bottom: 4px;
}
.plan-constraint-row {
  display: flex;
  gap: 8px;
  padding: 2px 0;
}
.plan-constraint-row[data-priority="critical"] .plan-constraint-id {
  color: var(--neu-danger);
  font-weight: 700;
}
.plan-constraint-row[data-priority="high"] .plan-constraint-id {
  color: var(--neu-warning);
  font-weight: 600;
}
.plan-constraint-id {
  flex: none;
  font-family: var(--neu-font-mono, monospace);
}
.plan-constraint-text {
  opacity: 0.85;
}

.plan-contract-bar {
  display: flex;
  flex-wrap: wrap;
  align-items: baseline;
  gap: 4px 8px;
  padding: 3px 8px;
  margin: 0 0 6px;
  border-radius: 6px;
  background: rgba(120, 160, 255, 0.1);
  box-shadow: inset 0 0 0 1px rgba(120, 160, 255, 0.2);
  font-size: 11px;
  font-variant-numeric: tabular-nums;
}
.plan-contract-seg {
  white-space: nowrap;
}
.plan-contract-seg[data-status="current"] {
  color: #8fd48f;
}
.plan-contract-seg[data-status="draft"] {
  opacity: 0.75;
}
.plan-contract-seg[data-status="stale"] {
  color: #e6b45a;
}
.plan-task-states {
  flex: 0 0 auto;
  max-height: min(45%, 280px);
  overflow-y: auto;
  overscroll-behavior: contain;
  padding: 4px 8px;
  margin: 0 0 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.06);
}
.plan-task-summary {
  display: flex;
  align-items: baseline;
  gap: 8px;
  width: 100%;
  padding: 0;
  border: none;
  background: none;
  color: inherit;
  cursor: pointer;
  font: inherit;
  text-align: left;
}
.plan-task-counts {
  flex: 1 1 auto;
  min-width: 0;
  overflow: hidden;
  color: var(--neu-muted);
  font-size: 11px;
  text-overflow: ellipsis;
  white-space: nowrap;
}
.plan-task-toggle {
  flex: 0 0 auto;
  color: var(--neu-accent);
  font-size: 10px;
  opacity: 0.85;
}
.plan-task-row {
  display: flex;
  align-items: baseline;
  gap: 6px;
  padding: 1px 0;
  font-size: 11px;
}
.plan-task-badge {
  flex: 0 0 auto;
  padding: 0 6px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 10px;
  white-space: nowrap;
}
.plan-task-badge[data-state="verified"] {
  background: rgba(143, 212, 143, 0.16);
  color: #8fd48f;
}
.plan-task-badge[data-state="gap"] {
  background: rgba(230, 120, 120, 0.18);
  color: #e78a8a;
}
.plan-task-badge[data-state="in_progress"] {
  background: rgba(120, 160, 255, 0.18);
  color: #8ab4f8;
}
.plan-task-badge[data-state="skipped"] {
  opacity: 0.6;
}
.plan-task-text {
  min-width: 0;
  word-break: break-word;
}
.plan-task-text strong {
  font-weight: 600;
}
.plan-task-text code {
  padding: 0 3px;
  border-radius: 3px;
  background: rgba(255, 255, 255, 0.08);
  font-family: var(--neu-font-mono);
  font-size: 10px;
}
.plan-task-text a {
  color: var(--neu-accent);
}
.drift-card {
  padding: 6px 8px;
  margin-bottom: 6px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
  box-shadow: inset 0 0 0 1px rgba(255, 255, 255, 0.07);
  font-size: 12px;
}
.drift-card-head {
  display: flex;
  align-items: baseline;
  justify-content: space-between;
  gap: 8px;
}
.drift-card-status {
  padding: 0 6px;
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.08);
  font-size: 10px;
  opacity: 0.8;
}
.drift-card-status[data-status="explained"] {
  color: #8fd48f;
}
.drift-card-status[data-status="disputed"] {
  color: #e6b45a;
}
.drift-card-goal,
.drift-card-current {
  margin-top: 2px;
  white-space: pre-wrap;
  word-break: break-word;
}
.drift-card-meta {
  margin-top: 2px;
  opacity: 0.72;
  font-size: 11px;
}
.drift-card-section {
  margin-top: 5px;
  padding-top: 4px;
  border-top: 1px solid rgba(255, 255, 255, 0.08);
}
.drift-card-section-title {
  margin-bottom: 2px;
  color: var(--neu-muted);
  font-size: 10px;
  text-transform: uppercase;
  letter-spacing: 0.04em;
}
.drift-card-rule,
.drift-card-evidence {
  padding-left: 6px;
  opacity: 0.85;
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
}
.drift-card-evidence::before {
  content: "· ";
  opacity: 0.6;
}
.drift-card-rationale {
  margin-top: 3px;
  padding-left: 8px;
  border-left: 2px solid rgba(255, 255, 255, 0.15);
  opacity: 0.75;
  font-style: italic;
}
.drift-card-actions {
  display: flex;
  gap: 6px;
  margin-top: 5px;
}
.drift-card-btn {
  padding: 2px 10px;
  border: none;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.1);
  color: inherit;
  cursor: pointer;
  font-size: 11px;
}
.drift-card-btn:hover {
  background: rgba(255, 255, 255, 0.18);
}
.drift-card-btn:disabled {
  opacity: 0.5;
  cursor: default;
}
.drift-card-btn[data-kind="dispute"] {
  background: rgba(230, 180, 90, 0.18);
}
.drift-card-btn[data-kind="dismiss"] {
  background: rgba(255, 255, 255, 0.06);
}
.drift-card-btn[data-kind="reopen"] {
  background: rgba(143, 212, 143, 0.16);
}
.drift-card-reopened {
  padding: 0 6px;
  border-radius: 4px;
  background: rgba(143, 212, 143, 0.14);
  color: #8fd48f;
  font-size: 10px;
}
.drift-card-expand {
  margin-left: 6px;
  padding: 0 7px;
  border: none;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.08);
  color: var(--neu-accent);
  cursor: pointer;
  font-size: 10px;
  opacity: 0.85;
}
.drift-card-expand:hover {
  background: rgba(255, 255, 255, 0.16);
  opacity: 1;
}
.constitution-row {
  display: flex;
  align-items: flex-start;
  justify-content: space-between;
  gap: 8px;
  padding: 5px 8px;
  margin-bottom: 4px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.03);
}
.constitution-toolbar {
  display: flex;
  justify-content: flex-end;
  margin-bottom: 6px;
}
.constitution-editor {
  display: flex;
  flex-direction: column;
  gap: 6px;
  padding: 8px;
  margin-bottom: 8px;
  border-radius: 6px;
  background: rgba(255, 255, 255, 0.04);
}
.constitution-editor-row {
  display: flex;
  flex-wrap: wrap;
  gap: 6px;
}
.constitution-input {
  flex: 1 1 140px;
  min-width: 0;
  padding: 4px 8px;
  border: 1px solid rgba(255, 255, 255, 0.14);
  border-radius: 4px;
  background: rgba(255, 255, 255, 0.04);
  color: inherit;
  font-size: 12px;
}
.constitution-textarea {
  width: 100%;
  min-height: 56px;
  resize: vertical;
  font-family: inherit;
  line-height: 1.4;
}
.constitution-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 6px;
}
.constitution-row-main {
  display: flex;
  flex-direction: column;
  gap: 1px;
  min-width: 0;
  font-size: 12px;
}
.constitution-row-actions {
  display: flex;
  flex: none;
  gap: 5px;
}
.constitution-btn {
  padding: 2px 9px;
  border: none;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.09);
  color: inherit;
  cursor: pointer;
  font-size: 11px;
}
.constitution-btn:hover {
  background: rgba(255, 255, 255, 0.16);
}
.constitution-btn[data-danger] {
  background: rgba(220, 90, 90, 0.18);
}
.constitution-btn[data-danger]:hover {
  background: rgba(220, 90, 90, 0.3);
}
/* EI Phase 1 panel pagination: scrolling to the end of the pane appends the
   next durable page (unified-scroll plan §9); there is no per-page affordance
   in the markup. */
/* A release-scope (runtime self-protection) rule: not an empty action slot but
   an explicit label, so the panel explains why it cannot be edited. */
.constitution-protected {
  flex: none;
  align-self: center;
  padding: 2px 9px;
  border-radius: 999px;
  background: rgba(255, 255, 255, 0.05);
  color: rgba(255, 255, 255, 0.55);
  font-size: 11px;
  cursor: help;
  user-select: none;
}
.neu-goal-action {
  display: inline-flex;
  align-items: center;
  justify-content: center;
  min-width: 22px;
  height: 22px;
  padding: 0 7px;
  border: none;
  border-radius: 999px;
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 11px;
  line-height: 1;
  transition: background 120ms ease, color 120ms ease, transform 120ms ease;
}
.neu-goal-action:hover:not(:disabled) {
  background: rgba(255, 255, 255, 0.14);
}
.neu-goal-action:active:not(:disabled) {
  transform: scale(0.94);
}
.neu-goal-action:disabled {
  opacity: 0.45;
  cursor: default;
}
.neu-goal-toggle {
  font-size: 9px;
  letter-spacing: 0.02em;
}
.neu-goal-toggle[data-phase="paused"],
.neu-goal-toggle[data-phase="blocked"] {
  background: rgba(120, 160, 255, 0.3);
  color: var(--neu-accent);
}
.neu-goal-clear:hover:not(:disabled) {
  background: rgba(220, 90, 90, 0.24);
}
.neu-goal-notice {
  padding: 1px 8px;
  border-radius: 999px;
  background: rgba(220, 90, 90, 0.16);
  color: var(--neu-danger, #e88);
  font-size: 11px;
}
.neu-goal-editor {
  position: absolute;
  left: 0;
  bottom: calc(100% + 8px);
  z-index: 20;
  width: 330px;
  display: flex;
  flex-direction: column;
  gap: 8px;
  padding: 10px 12px;
  border-radius: 10px;
  border: 1px solid var(--neu-border, rgba(255, 255, 255, 0.14));
  background: var(--neu-bg);
  box-shadow: 0 12px 32px rgba(0, 0, 0, 0.45);
}
.neu-goal-editor-field {
  display: flex;
  flex-direction: column;
  gap: 4px;
  font-size: 11px;
}
.neu-goal-editor-field > span {
  color: var(--neu-muted);
}
.neu-goal-editor-field textarea,
.neu-goal-editor-field input {
  width: 100%;
  box-sizing: border-box;
  padding: 5px 7px;
  border-radius: 6px;
  border: 1px solid var(--neu-border, rgba(255, 255, 255, 0.18));
  background: rgba(0, 0, 0, 0.22);
  color: inherit;
  font: inherit;
  resize: vertical;
}
.neu-goal-editor-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
}
.neu-goal-editor-actions button {
  padding: 3px 12px;
  border-radius: 6px;
  border: 1px solid var(--neu-border, rgba(255, 255, 255, 0.18));
  background: transparent;
  color: inherit;
  cursor: pointer;
  font-size: 11px;
}
.neu-goal-editor-save {
  border-color: transparent;
  background: var(--neu-accent);
  color: #0b0d12;
  font-weight: 600;
}

/* Jump-to-bottom floating button */
.neu-jump-bottom {
  position: absolute;
  right: 16px;
  bottom: 48px;
  width: 32px;
  height: 32px;
  border: none;
  border-radius: 50%;
  background: var(--neu-bg);
  color: var(--neu-accent);
  font-size: 16px;
  cursor: pointer;
  box-shadow: 3px 3px 6px var(--neu-shadow-dark), -3px -3px 6px var(--neu-shadow-light);
  z-index: 2;
}
.neu-pane-content { position: relative; }

/* Message containment is host-agnostic: every Transcript mount (Natalia,
   Navi, Nia, AgentPanel, plugin panes) gets the same narrow-width guards. */
.natalia-message,
.natalia-message-group,
.natalia-message-header,
.natalia-message-meta,
.natalia-message-body,
.natalia-message-text,
.natalia-thinking-block,
.natalia-thinking-text,
.natalia-tool-card,
.natalia-tool-header,
.natalia-tool-output {
  min-width: 0;
}
.natalia-message-text,
.natalia-thinking-text {
  max-width: 100%;
  overflow-wrap: break-word;
}
/* Scroll Phase 5's clamp, removed on 2026-10-10 (the user's ruling, third
   screenshot): the markdown body was clamped to the fixed-height row model's
   line budget so the rendered row matched the deterministic fixedRowHeight
   estimate and the virtualizer needed no DOM measurement -- and the cost was a
   fixed box with an inner scrollbar in the middle of every long reply. The row
   model it served is gone with it (fixedRowHeight is the content's real height
   now), so there is nothing left for this to match. A reply renders at its own
   height and the conversation's single scrollbar is the pane's. */
.natalia-message-header,
.natalia-message-meta,
.natalia-tool-header {
  flex-wrap: wrap;
}
.natalia-tool-output {
  max-width: 100%;
  overflow-x: auto;
}
.natalia-tool-output pre {
  max-width: 100%;
  white-space: pre-wrap;
  overflow-wrap: break-word;
}
.natalia-tool-output-toggle {
  display: block;
  margin-top: 6px;
  padding: 3px 0 0;
  border: 0;
  border-top: 1px solid var(--neu-divider);
  color: var(--neu-accent);
  background: transparent;
  cursor: pointer;
  font: inherit;
  text-align: left;
}

/* Markdown tables and blocks */
.natalia-message-text table,
.natalia-thinking-text table {
  display: block;
  width: 100%;
  max-width: 100%;
  overflow-x: auto;
  border-collapse: collapse;
  margin: 8px 0;
}
.natalia-message-text th,
.natalia-message-text td,
.natalia-thinking-text th,
.natalia-thinking-text td {
  border: 1px solid var(--neu-border);
  padding: 6px 8px;
  text-align: left;
}
/* A message's own code block renders at its full height (the 2026-10-10
   ruling: no fixed height, no inner scrollbar, render naturally). The clamp
   this replaces put a scrollbar inside a long reply: any block markdown
   parsed into a pre -- an indented quote, a fenced block -- became a fixed box
   the reader had to scroll INSIDE, which is exactly what the reference
   implementation does not do (its markdown payload carries no height bound at
   all). The transcript's own scroll is the pane's: one scrollbar for the whole
   conversation. */
.natalia-message-text pre,
.natalia-thinking-text pre {
  background: var(--neu-bg);
  border-radius: 8px;
  padding: 10px;
  max-width: 100%;
  /* Wrapped, not scrolled: the reference implementation's markdown payload
     carries pre-wrap and no overflow at all, so a wide code line reflows
     instead of growing a scrollbar inside a reply. */
  white-space: pre-wrap;
  overflow-wrap: anywhere;
}
.natalia-message-text code,
.natalia-thinking-text code {
  background: transparent;
  border: none;
  padding: 0 2px;
  color: var(--neu-code-text, var(--neu-text));
  overflow-wrap: break-word;
}
.natalia-message-text pre code,
.natalia-thinking-text pre code { background: transparent; padding: 0; }
.natalia-message-text ul,
.natalia-message-text ol,
.natalia-thinking-text ul,
.natalia-thinking-text ol { padding-left: 20px; }
.natalia-message-text blockquote,
.natalia-thinking-text blockquote {
  margin: 8px 0;
  padding: 4px 12px;
  border-left: 3px solid var(--neu-accent);
  color: var(--neu-muted);
}
.natalia-message-text a,
.natalia-thinking-text a {
  color: var(--neu-accent);
  overflow-wrap: break-word;
}
.natalia-message-text img,
.natalia-thinking-text img { max-width: 100%; height: auto; }

.review-file {
  display: flex;
  flex-direction: column;
  gap: 4px;
  padding: 8px 10px;
  border-radius: 8px;
  background: var(--neu-bg-light);
  margin-bottom: 4px;
  font-size: 12px;
}
.review-file[data-operation="added"] { border-left: 3px solid var(--neu-success); }
.review-file[data-operation="modified"] { border-left: 3px solid var(--neu-warning); }
.review-file[data-operation="deleted"] { border-left: 3px solid var(--neu-danger); }
.review-file[data-operation="renamed"] { border-left: 3px solid var(--neu-accent); }
.review-file-name { font-weight: 600; color: var(--neu-text); word-break: break-all; }
.review-file-meta { display: flex; gap: 8px; font-size: 10px; color: var(--neu-muted); }
.review-file-op { font-weight: 600; text-transform: uppercase; }
.review-section-title { font-size: 12px; font-weight: 600; color: var(--neu-muted); margin: 10px 0 4px; }

.review-drift-card {
  padding: 10px 12px;
  border-radius: 8px;
  background: var(--neu-bg-light);
  margin-bottom: 6px;
  font-size: 12px;
}
.review-drift-card[data-severity="high"] { border-left: 3px solid var(--neu-danger); }
.review-drift-card[data-severity="warning"] { border-left: 3px solid var(--neu-warning); }
.review-drift-card[data-severity="advisory"] { border-left: 3px solid var(--neu-accent); }
.review-drift-header { display: flex; justify-content: space-between; margin-bottom: 6px; font-size: 11px; color: var(--neu-muted); }
.review-severity, .review-drift-status { text-transform: uppercase; font-weight: 600; }
.review-drift-activity { color: var(--neu-text); font-weight: 500; margin-bottom: 6px; word-break: break-word; max-height: 72px; overflow: hidden; }
.review-drift-evidence { margin: 0; padding-left: 18px; color: var(--neu-muted); font-size: 11px; }
.review-drift-evidence li { margin-bottom: 2px; word-break: break-word; }

/* --- Pending takeover (R4(a)(c)) ---------------------------------------
 * The styles the composer-takeover card renders with. They live here rather
 * than in the pending-inbox panel plugin because that plugin's panel is
 * gone (T4-4): the card is the surface now, so the card's host owns the
 * rules. The natalia-pending-* block below is the same set the side panel
 * used, moved verbatim — a second copy under a different name is how a
 * stylesheet ends up with two rules fighting over one element.
 * ---------------------------------------------------------------------- */
.natalia-pending-takeover {
  display: flex;
  flex-direction: column;
  gap: 10px;
  padding: 10px 12px;
  background: var(--neu-bg-light);
  border: 1px solid var(--neu-hairline-accent);
  border-radius: 12px;
  max-height: 46vh;
  overflow-y: auto;
}
.natalia-pending-takeover-head {
  display: flex;
  align-items: center;
  gap: 8px;
}
.natalia-pending-takeover-title {
  flex: 1;
  font-size: 13px;
  font-weight: 600;
  color: var(--neu-text);
}
.natalia-pending-takeover-minimize,
.natalia-pending-takeover-min-expand {
  padding: 4px 10px;
  background: transparent;
  border: 1px solid var(--neu-hairline);
  border-radius: 8px;
  color: var(--neu-muted);
  font-size: 11px;
  cursor: pointer;
}
.natalia-pending-takeover-hint {
  margin: 0;
  font-size: 11px;
  color: var(--neu-muted);
}
.natalia-pending-takeover-list {
  display: flex;
  flex-direction: column;
  gap: 4px;
  list-style: none;
  margin: 0;
  padding: 0;
  max-height: 30%;
  overflow-y: auto;
}
.natalia-pending-takeover-row {
  flex: 1;
  display: flex;
  align-items: center;
  gap: 8px;
  min-width: 0;
  padding: 6px 10px;
  background: transparent;
  border: 1px solid transparent;
  border-radius: 8px;
  color: var(--neu-text);
  font-size: 12px;
  text-align: left;
  cursor: pointer;
}
.natalia-pending-takeover-row[data-active="true"] {
  background: var(--neu-bg);
  border-color: var(--neu-hairline-accent);
  color: var(--neu-accent);
}
.natalia-pending-takeover-min {
  display: flex;
  align-items: center;
  gap: 8px;
  padding: 6px 12px;
  background: var(--neu-bg-light);
  border: 1px solid var(--neu-hairline-accent);
  border-radius: 10px;
}
.natalia-pending-takeover-min-count {
  flex: 1;
  font-size: 12px;
  color: var(--neu-accent);
}

/* The pending detail/list/badge rules the shared kit renders with; moved
 * here with the takeover card because the side panel that owned them is
 * gone (T4-4). */

.natalia-pending-panel { display:flex; flex-direction:column; gap:10px; height:100%; overflow:hidden; padding:8px; }
.natalia-pending-list { display:flex; flex-direction:column; gap:4px; list-style:none; margin:0; padding:0; max-height:40%; overflow-y:auto; }
.natalia-pending-list-item { display:flex; align-items:center; gap:4px; }
.natalia-pending-row { flex:1; display:flex; align-items:center; gap:8px; min-width:0; padding:8px 10px; background:transparent; border:1px solid transparent; border-radius:8px; color:var(--neu-text); font-size:12px; text-align:left; cursor:pointer; }
.natalia-pending-row[data-active="true"] { background:var(--neu-bg-light); border-color:var(--neu-hairline-accent); color:var(--neu-accent); }
.natalia-pending-row-kind { font-size:10px; text-transform:uppercase; letter-spacing:0.04em; color:var(--neu-muted); flex-shrink:0; }
.natalia-pending-row-title { flex:1; min-width:0; overflow:hidden; text-overflow:ellipsis; white-space:nowrap; }
.natalia-pending-dismiss { flex-shrink:0; padding:4px 8px; background:transparent; border:1px solid var(--neu-hairline); border-radius:8px; color:var(--neu-muted); font-size:11px; cursor:pointer; }
.natalia-pending-detail { flex:1; display:flex; flex-direction:column; gap:10px; min-height:0; overflow-y:auto; }
.natalia-pending-detail-header { display:flex; align-items:flex-start; gap:8px; }
.natalia-pending-detail-title { flex:1; font-size:13px; font-weight:600; color:var(--neu-text); }
.natalia-pending-fields { display:flex; flex-direction:column; gap:8px; }
.natalia-pending-field { display:flex; flex-direction:column; gap:2px; }
.natalia-pending-field-label { font-size:10px; text-transform:uppercase; letter-spacing:0.04em; color:var(--neu-muted); }
.natalia-pending-field-value { font-size:12px; color:var(--neu-text); }
.natalia-pending-field-pre { margin:0; padding:8px; background:var(--neu-bg); border-radius:8px; font-family:var(--neu-font-mono); font-size:11px; white-space:pre-wrap; word-break:break-word; max-height:220px; overflow:auto; }
.natalia-pending-control { display:flex; flex-direction:column; gap:6px; }
.natalia-pending-control-label { font-size:11px; color:var(--neu-muted); }
.natalia-pending-options { display:flex; flex-direction:column; gap:6px; }
.natalia-pending-option { display:flex; flex-direction:column; gap:2px; padding:8px 10px; background:transparent; border:1px solid var(--neu-hairline); border-radius:10px; color:var(--neu-text); font-size:12px; text-align:left; cursor:pointer; }
.natalia-pending-option[data-active="true"] { border-color:var(--neu-hairline-accent); color:var(--neu-accent); background:var(--neu-bg-light); }
.natalia-pending-option-desc { font-size:11px; color:var(--neu-muted); }
.natalia-pending-input { width:100%; padding:8px 10px; background:var(--neu-bg); border:1px solid var(--neu-hairline); border-radius:8px; color:var(--neu-text); font-size:12px; }
.natalia-pending-actions { display:flex; gap:8px; flex-wrap:wrap; }
.natalia-pending-action { padding:8px 12px; border-radius:8px; border:1px solid var(--neu-hairline); background:var(--neu-bg-light); color:var(--neu-text); font-size:12px; cursor:pointer; }
.natalia-pending-action[data-tone="primary"] { border-color:var(--neu-hairline-accent); color:var(--neu-accent); }
.natalia-pending-action[data-tone="danger"] { color:var(--neu-error); }
.natalia-pending-empty { padding:24px; text-align:center; color:var(--neu-muted); font-size:12px; }
`;

export const confirmDialogCss = `
.neu-confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: rgba(0, 0, 0, 0.55);
  backdrop-filter: blur(2px);
}
.neu-confirm-dialog {
  min-width: 280px;
  max-width: 420px;
  background: #25272b;
  color: #e8e8e8;
  border: 1px solid rgba(255, 255, 255, 0.12);
  border-radius: 10px;
  padding: 18px;
  box-shadow: 0 18px 48px rgba(0, 0, 0, 0.45);
}
.neu-confirm-title {
  font-size: 14px;
  font-weight: 600;
  margin-bottom: 10px;
}
.neu-confirm-message {
  font-size: 13px;
  line-height: 1.6;
  color: #c9c9c9;
  white-space: pre-wrap;
}
.neu-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: 8px;
  margin-top: 16px;
}
.neu-confirm-cancel,
.neu-confirm-ok {
  border: 1px solid rgba(255, 255, 255, 0.16);
  border-radius: 6px;
  padding: 6px 14px;
  font-size: 13px;
  cursor: pointer;
  background: transparent;
  color: #e8e8e8;
}
.neu-confirm-ok {
  background: #3b82f6;
  border-color: #3b82f6;
}
.neu-confirm-ok[data-danger="true"] {
  background: #b91c1c;
  border-color: #b91c1c;
}
`;
