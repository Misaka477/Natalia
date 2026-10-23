/**
 * THE CSS MODULES MIGRATION — the plan, written where the work happens.
 *
 * This file is one global stylesheet, and the architecture wants it one
 * module per region. The order and the rules, so the migration is
 * mechanical rather than a rewrite:
 *
 *  1. ONE MODULE PER REGION, cut along the controller boundaries the
 *     shell already has: topbar, session-tree, transcript, input-area,
 *     workbench, modals, and one module per panel the modals open. A
 *     region's rules move verbatim; nothing is re-authored.
 *  2. TOKENS ONLY. A module consumes `--neu-*` semantic vars and never
 *     a literal color — the same rule the token guard enforces today,
 *     and it must keep enforcing it per module (the guard reads every
 *     module, not just this file).
 *  3. CLASS NAMES GO LOCAL. A component imports its module and reads
 *     `styles.foo`; a name that crosses a region boundary (a parent
 *     styling a child's internals) is the one case that stays global,
 *     and it is called out in a comment where it lives.
 *  4. THE CASCADE ORDER IS THE RISK. Today's order — theme, base,
 *     dialogs, palette, then the appended blocks — is load-bearing for
 *     specificity ties. A module's rules are appended in the same
 *     order the regions appear in the shell, so a tie resolves the same
 *     way it does now.
 *  5. THIS FILE SHRINKS, IT DOES NOT DIE. What remains global: the
 *     reset, the `:root` derived aliases, and the kit's own surface
 *     (the kit ships its styles; the shell does not restyle it).
 *
 * The first module is the command palette (already an isolated block at
 * the bottom of this file), which proves the pattern end to end before
 * the regions move.
 */

export const nataliaNeuBaseStyles = `
:root {
  font-family: "Inter", system-ui, -apple-system, sans-serif;
  background: var(--neu-bg);
  color: var(--neu-text);
  /* Palette values and shape tokens are written by the theme layer
     (src/theme): palettes.ts owns every color value, shape.ts owns radius,
     spacing, typography, motion and elevation. Only derived aliases that
     compose palette slots live here. */
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

/* ===== Left session sidebar ===== */
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
.neu-shell[data-resizing="true"] .neu-main {
  contain: layout paint;
  overflow-anchor: none;
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
  box-shadow: var(--neu-elevation-1);
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
/* SHARED VOCABULARY — the pane (with its header, title, status and
   content) is the shell's one shape for "a panel with a header", used by
   the transcript, the Nia panel, the agent panel and the shell itself;
   neu-main and neu-main-toolbar are shared by the transcript and Nia.
   They stay global under the migration plan's cross-region rule —
   localizing them would give four surfaces four copies of one shape.
   The transcript's own classes (the panes wrapper and its divider with
   their responsive passes, the header's right cluster and the two
   transcript wraps) have moved into the transcript module. */
.neu-main {
  flex: 1;
  min-width: 0;
  display: flex;
  overflow: visible;
}
.neu-pane {
  flex: 1;
  min-width: 0;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: var(--neu-elevation-3);
  padding: 14px;
  overflow: hidden;
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
  --context-meter-color: var(--neu-warning);
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
  background: var(--neu-assistant-bubble);
  border: 1px solid var(--neu-border);
  box-shadow: var(--neu-elevation-flat);
}
.neu-pane .natalia-message[data-role="user"] {
  align-self: flex-end;
  background: var(--neu-user-bubble);
  border-color: var(--neu-user-bubble-border);
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
  box-shadow: var(--neu-inset-2);
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
  color: var(--neu-thinking);
  font-style: normal;
}
.neu-pane .natalia-thinking-text { color: var(--neu-muted); }

.neu-pane .natalia-code-block {
  background: var(--neu-bg-light);
  border-radius: 10px;
  margin: 6px 0;
  overflow: hidden;
  box-shadow: var(--neu-inset-2);
}
.neu-pane .natalia-code-header { display: flex; align-items: center; justify-content: space-between; padding: 4px 10px; color: var(--neu-muted); font-size: 11px; }
.neu-pane .natalia-code-block pre { padding: 10px; overflow-x: auto; font-family: var(--neu-font-mono); font-size: 12px; }
.neu-pane .natalia-badge { font-size: 10px; padding: 1px 7px; border-radius: 10px; background: var(--neu-bg-light); color: var(--neu-muted); box-shadow: var(--neu-badge-inset); }
.neu-pane .natalia-badge-running { color: var(--neu-success); }
.neu-pane .natalia-badge-success { color: var(--neu-success); }
.neu-pane .natalia-badge-error { color: var(--neu-error); }
.neu-pane .natalia-badge-steering { color: var(--neu-accent); box-shadow: var(--neu-ring-accent); }
/* What the call cost, in the runner's own measurement. Monospaced figures so a
   column of cards reads down, and muted so the status badge stays the loudest
   thing on the header. */
.neu-pane .natalia-tool-duration {
  margin-left: 6px;
  flex-shrink: 0;
  font-family: var(--neu-font-mono);
  font-size: 10px;
  color: var(--neu-muted);
  font-variant-numeric: tabular-nums;
}
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
  box-shadow: var(--neu-inset-3);
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
.neu-pane .natalia-action-btn { padding: 5px 12px; border: none; border-radius: 12px; background: var(--neu-bg); color: var(--neu-text); box-shadow: var(--neu-elevation-4); font-size: 12px; cursor: pointer; }
.neu-pane .natalia-action-btn:active { box-shadow: var(--neu-inset-3); }
.neu-pane .natalia-action-btn-primary { background: var(--neu-accent); color: var(--neu-on-accent); box-shadow: var(--neu-elevation-accent); }
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



/* ===== Review / Diff ===== */
/* SHARED VOCABULARY — the review surface (pane, header, title, subtabs,
   diff, file rows, entity lists, empty states, section labels, resizer)
   is rendered by the review panel AND by the agent and plan panels,
   which reuse it for their own content. It stays global under the
   cross-region rule. What is review-only (the AST search and diff
   renderers, the PR rows, the git ranges, the entity buttons and the
   checkpoint rename button) moves into that panel's module when its
   clusters are cut. */
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
  box-shadow: var(--neu-elevation-2);
}
.review-subtab:hover {
  color: var(--neu-text);
}
.review-subtab[data-active="true"] {
  background: var(--neu-bg-light);
  color: var(--neu-text);
  box-shadow: var(--neu-inset-3);
}
.review-section-label {
  padding: 0 12px 4px;
  font-size: 10px;
  font-weight: 600;
  color: var(--neu-muted);
  text-transform: uppercase;
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
  box-shadow: var(--neu-inset-2);
}
.review-entity-list {
  display: flex;
  gap: 6px;
  flex-wrap: wrap;
  padding: 0 12px 8px;
}
.review-header {
  display: flex; align-items: center; justify-content: space-between;
  padding: 10px 12px;
  margin-bottom: 10px;
  border-radius: 12px;
  background: var(--neu-bg);
  box-shadow: var(--neu-inset-3);
}
.review-title { display: flex; align-items: center; gap: 8px; font-size: 13px; font-weight: 600; color: var(--neu-text); }
.review-title svg { color: var(--neu-accent); }
.review-meta { display: flex; align-items: center; gap: 8px; font-size: 11px; color: var(--neu-muted); }
.review-body { display: flex; flex: 1; min-height: 0; overflow: hidden; }
.main-transcript-wrap,

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
  box-shadow: var(--neu-inset-3);
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
  box-shadow: var(--neu-inset-3);
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
.review-file-row[data-active="true"] { background: var(--neu-bg-light); box-shadow: var(--neu-inset-2); color: var(--neu-text); }
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
  box-shadow: var(--neu-inset-3);
  font-family: var(--neu-font-mono); font-size: 11px; color: var(--neu-text);
}
.review-diff-path { min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.review-diff-content { flex: 1; min-height: 0; overflow-y: auto; overflow-x: auto; position: relative; font-family: var(--neu-font-mono); font-size: 11px; line-height: 1.65; background: var(--neu-bg-light); color: var(--neu-text); border-radius: 12px; box-shadow: var(--neu-inset-3); padding: 12px 0 14px; }
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
.diff-hunk-nav .review-diff-line { display: flex; min-width: 0; overflow: hidden; align-items: center; }
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
  box-shadow: var(--neu-inset-3);
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
  box-shadow: var(--neu-elevation-2);
  transition: box-shadow 0.2s ease, background-color 0.2s ease, color 0.2s ease;
}
.review-commit-btn:hover {
  box-shadow: var(--neu-elevation-1);
  color: var(--neu-accent-soft);
}
.review-commit-btn:active {
  box-shadow: var(--neu-inset-3);
  color: var(--neu-accent);
}
.review-commit-btn svg {
  transition: transform 0.15s ease, color 0.15s ease;
}
.review-commit-btn:active svg {
  transform: scale(0.82);
  opacity: 0.85;
}

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
.neu-confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 999;
  background: var(--neu-overlay);
  display: flex;
  align-items: center;
  justify-content: center;
}
.neu-confirm-title {
  font-size: 14px;
  font-weight: 700;
  color: var(--neu-text);
  margin-bottom: 8px;
}
.neu-confirm-actions {
  display: flex;
  gap: 8px;
  justify-content: flex-end;
}
/* ===== Modal window chrome (SHARED VOCABULARY) =====
   The backdrop, the window, the header with its title and close button,
   and the form controls (label, input, button) are the shell's ONE shape
   for a modal, used by every panel the modal layer opens — settings,
   model, status, workspace, sandbox, stash, help, search, session
   actions and the plugin manager. They stay global under the migration
   plan's cross-region rule: localizing them would give eleven panels
   eleven copies of one window. A panel's own rules (its body, its rows,
   its specific controls) move into that panel's module when the region's
   clusters are cut. */
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
/* ===== Bulk session select ===== */
.neu-bulk-bar {
  display: flex;
  flex-direction: column;
  gap: 4px;
  margin-bottom: 8px;
  padding: 6px;
  border-radius: 10px;
  background: var(--neu-bg);
  box-shadow: var(--neu-inset-2);
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
  box-shadow: var(--neu-elevation-2);
}
.neu-session-toolbar-btn:hover {
  box-shadow: var(--neu-elevation-1);
  color: var(--neu-accent);
}
.neu-session-toolbar-btn:active {
  box-shadow: var(--neu-inset-2);
}
/* ===== Checkpoint panel ===== */
.neu-checkpoint-window {
  width: min(620px, 90vw);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: var(--neu-elevation-5);
  overflow: hidden;
}
.neu-checkpoint-current {
  padding: 12px 14px;
  margin: 14px 20px 0;
  border-radius: 12px;
  background: var(--neu-bg);
  font-size: 13px;
  color: var(--neu-muted);
  box-shadow: var(--neu-inset-2);
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
  box-shadow: var(--neu-inset-2);
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
  box-shadow: var(--neu-elevation-2);
}
.neu-checkpoint-action:active {
  box-shadow: var(--neu-inset-2);
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
  box-shadow: var(--neu-elevation-accent);
}
.neu-checkpoint-create:active {
  box-shadow: var(--neu-inset-accent);
}

/* ===== Permission approval panel ===== */
.neu-permission-window {
  width: min(520px, 90vw);
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: var(--neu-elevation-5);
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
  box-shadow: var(--neu-inset-2);
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
  box-shadow: var(--neu-elevation-2);
  transition: box-shadow 0.2s ease, background-color 0.2s ease, color 0.2s ease;
}
.neu-permission-btn:active {
  box-shadow: var(--neu-inset-3);
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
  box-shadow: var(--neu-inset-2);
}
.neu-permission-reason::placeholder {
  color: var(--neu-muted);
}
.neu-permission-reject-submit {
  background: var(--neu-bg);
  color: var(--neu-error);
}


/* ===== Extensions panel ===== */
.neu-extensions-window {
  width: min(640px, 90vw);
  max-height: 78vh;
  display: flex;
  flex-direction: column;
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: var(--neu-elevation-5);
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
  box-shadow: var(--neu-inset-2);
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
  box-shadow: var(--neu-elevation-accent);
}
.neu-extension-add:active {
  box-shadow: var(--neu-inset-accent);
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
  box-shadow: var(--neu-elevation-1);
  white-space: nowrap;
}
.neu-extension-btn:active {
  box-shadow: var(--neu-inset-2);
}
.neu-extension-remove {
  color: var(--neu-error);
}
/* The source badge a non-owned row carries where its delete button would
   be: it explains the absent button instead of leaving a gap. */
.neu-extension-source {
  font-size: 11px;
  color: var(--neu-text-dim);
  border: 1px solid var(--neu-shadow-dark);
  border-radius: 10px;
  padding: 2px 8px;
  white-space: nowrap;
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


.neu-gov-action-note {
  margin-bottom: 6px;
  padding: 6px 8px;
  border-radius: 6px;
  background: var(--neu-state-info-bg);
  color: var(--neu-state-info-text);
  font-size: 11px;
  white-space: pre-wrap;
  word-break: break-word;
}

/* ===== Workspace add panel ===== */
/* SHARED VOCABULARY — the workspace modal window and body are used by
   both the add-workspace panel and the workspace-settings panel; they
   stay global under the cross-region rule. */
.neu-workspace-window {
  width: min(480px, 90vw);
  background: var(--neu-bg-light);
  border-radius: var(--neu-radius);
  box-shadow: var(--neu-elevation-5);
  overflow: hidden;
}
.neu-workspace-body {
  padding: 14px 20px 20px;
  display: flex;
  flex-direction: column;
  gap: 12px;
}

/* ===== Smooth transitions ===== */
.neu-pane .natalia-action-btn,
.file-tree-item,
.review-file-row,
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
}
@media (max-width: 1700px) {
  .neu-shell[data-compact="true"] .neu-resizer {
    display: block;
  }
  .neu-shell[data-compact="true"] .neu-pane {
    min-height: 220px;
  }
}

/* Compact but short viewports: horizontal main panes are better than
   stacking two panes vertically when height is at or below 1000px. */
@media (max-width: 1000px) {
  .neu-shell { padding: 6px; gap: 6px; }
  .neu-app { gap: 6px; }
  .neu-pane { min-height: 220px; }

  /* Tiny mode: right sidebar takes the whole content area when opened. */
  .neu-shell[data-tiny="true"][data-right-open="true"] .neu-main {
    display: none;
  }
  .neu-shell[data-tiny="true"][data-right-open="true"] .neu-right-resizer {
    display: none;
  }
}

.neu-edit-body {
  display: flex;
  flex-direction: column;
  gap: 12px;
  padding: 16px;
  max-height: min(70vh, 720px);
  overflow-y: auto;
}

/* ===== Select control (SHARED VOCABULARY) =====
   The one select the shell uses — the model, reasoning and permission
   pickers in the pane toolbar, the topbar, and every panel's form. These
   nine rules were dropped when this sheet was rewritten for the token
   layer, which left the control's DOM classes with nothing to style:
   the trigger lost its box, the chevron its rotation, the menu its
   surface and the options their hover. Restored verbatim from the shell
   this package was copied from; nothing here is re-authored. */
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

/* ===== Form controls (SHARED VOCABULARY) =====
   The form every panel's modal uses: the column, the field, the label,
   the input, the select, the checkbox and the action row with its
   buttons. Dropped in the same rewrite as the select family, which left
   every dialog's labels and buttons unstyled. Restored verbatim from the
   shell this package was copied from. */
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
.neu-form-section-title {
  margin-top: 4px;
  font-size: 12px;
  font-weight: 600;
  color: var(--neu-text);
}

/* ===== Modal window chrome (SHARED VOCABULARY) =====
   The header, title and close button every modal window carries —
   settings, model, status, workspace, sandbox, stash, help, search,
   session actions and the plugin manager all render these three names
   verbatim, so they are global. They were dropped in the same rewrite
   as the select and form families, which left every dialog's title bar
   and close button unstyled. The backdrop and window are already
   defined below; these three complete the chrome. */
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
  box-shadow: var(--neu-elevation-2);
}
.neu-settings-close:active {
  box-shadow: var(--neu-inset-2);
}

/* ===== Category button (SHARED VOCABULARY) =====
   The button that switches a window's right-hand column. Four surfaces
   write it verbatim — the settings dialog's category column, and the
   status, model and governance panels' tab strips (each of those three
   scopes it further in its own module). It was dropped in the same
   rewrite as the modal chrome above, which left the settings dialog's
   category column as a stack of raw browser buttons; the user found it
   in a screenshot. */
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
  box-shadow: var(--neu-inset-2);
}

/* ===== Shared hooks and small shared controls =====
   neu-stash-textarea is shared by the stash panel and the
   workspace-settings panel, so it stays global. neu-gov-empty is the
   governance and work-graph empty state, used by four surfaces. Both
   were dropped in the token rewrite; restored here, with the empty
   state's background on the semantic slot the rewrite had already
   tokenized it to. */
.neu-stash-textarea {
  min-height: 72px;
  resize: none;
}
.neu-gov-empty {
  margin-top: 8px;
  padding: 14px;
  border-radius: 8px;
  background: var(--neu-surface-sunken);
  color: var(--neu-muted);
  font-size: 12px;
  line-height: 1.5;
  text-align: center;
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
.neu-question-option-active { color: var(--neu-accent) !important; box-shadow: var(--neu-inset-2) !important; }
.neu-question-option-description { display: block; font-size: 12px; color: var(--neu-muted); }
.neu-question-custom { width: 100%; box-sizing: border-box; padding: 10px 12px; border: none; border-radius: 12px; background: var(--neu-bg); color: var(--neu-text); font-family: inherit; font-size: 13px; box-shadow: var(--neu-inset-2); outline: none; }

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

/* Activity bar above composer.
   SHARED VOCABULARY — this cluster (the bar, its label, the pulse and
   the jump-to-bottom button below) is consumed by three surfaces: the
   transcript, the agent panel and the Nia panel. It is the runbar's own
   styling, so it stays global under the migration plan's cross-region
   rule: localizing it would give three regions three copies of one
   vocabulary. */
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
/* Jump-to-bottom floating button.
   SHARED VOCABULARY — the same button the transcript, the agent panel
   and the Nia panel show; it stays global for the reason the activity
   bar above does. */
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
  box-shadow: var(--neu-elevation-2);
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


`;

export const confirmDialogCss = `
.neu-confirm-backdrop {
  position: fixed;
  inset: 0;
  z-index: 9999;
  display: flex;
  align-items: center;
  justify-content: center;
  background: var(--neu-float-scrim);
  backdrop-filter: blur(2px);
}
.neu-confirm-dialog {
  min-width: 280px;
  max-width: 420px;
  background: var(--neu-float-surface);
  color: var(--neu-text);
  border: 1px solid var(--neu-border-strong);
  border-radius: var(--neu-radius-sm);
  padding: var(--neu-space-4);
  box-shadow: var(--neu-elevation-float);
}
.neu-confirm-title {
  font-size: var(--neu-font-base);
  font-weight: 600;
  margin-bottom: var(--neu-space-2);
}
.neu-confirm-message {
  font-size: var(--neu-font-md);
  line-height: 1.6;
  color: var(--neu-text-dim);
  white-space: pre-wrap;
}
.neu-confirm-actions {
  display: flex;
  justify-content: flex-end;
  gap: var(--neu-space-2);
  margin-top: var(--neu-radius-4);
}
.neu-confirm-cancel,
.neu-confirm-ok {
  border: 1px solid var(--neu-border-strong);
  border-radius: var(--neu-radius-1);
  padding: 6px 14px;
  font-size: var(--neu-font-md);
  cursor: pointer;
  background: transparent;
  color: var(--neu-text);
}
.neu-confirm-ok {
  background: var(--neu-accent);
  border-color: var(--neu-accent);
  color: var(--neu-on-accent);
}
.neu-confirm-ok[data-danger="true"] {
  background: var(--neu-error);
  border-color: var(--neu-error);
  color: var(--neu-on-error);
}
`;

/** The settings window's fullscreen presentation. Belongs to the settings
 *  region, which has not been modularized yet; it stays global until that
 *  region moves. */
export const settingsFullscreenCss = `
  /* Settings, fullscreen presentation: the window fills the viewport and
     drops its chrome. Tokens only, like the rest of the sheet. */
  .neu-settings-backdrop[data-fullscreen="true"] {
    padding: 0;
  }
  .neu-settings-backdrop[data-fullscreen="true"] .neu-settings-window {
    width: 100vw;
    height: 100vh;
    max-width: none;
    border-radius: 0;
    box-shadow: none;
  }
`;

/** The eight states every region can be in, in one shape. Any region may
 *  render it; the icons and the shape belong to all of them. */
export const panelStateCss = `
.panel-state {
  flex: 1;
  display: flex;
  flex-direction: column;
  align-items: center;
  justify-content: center;
  gap: 8px;
  padding: 24px;
  color: var(--neu-muted);
  text-align: center;
}
.panel-state-icon {
  opacity: 0.7;
}
.panel-state[data-state="error"] .panel-state-icon,
.panel-state[data-state="forbidden"] .panel-state-icon {
  color: var(--neu-error);
}
.panel-state[data-state="stale"] .panel-state-icon,
.panel-state[data-state="partial"] .panel-state-icon {
  color: var(--neu-warning);
}
.panel-state[data-state="offline"] .panel-state-icon {
  color: var(--neu-text-dim);
}
.panel-state-title {
  font-size: 13px;
  font-weight: 600;
  color: var(--neu-text);
}
.panel-state-desc {
  max-width: 42ch;
  font-size: 12px;
  line-height: 1.5;
}
.panel-state-action {
  margin-top: 4px;
  padding: 5px 14px;
  border: none;
  border-radius: 999px;
  background: var(--neu-bg);
  color: var(--neu-accent);
  font-family: inherit;
  font-size: 12px;
  cursor: pointer;
  box-shadow: var(--neu-elevation-1);
}
.panel-state-action:hover {
  color: var(--neu-text);
}
`;
