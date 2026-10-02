/**
 * Pending inbox PANEL styles. Injected once per document by the panel mount,
 * keyed by `data-natalia-pending` so a remount does not duplicate it. The tab
 * badge's rule is NOT here: it lives in the ui-kit beside its component
 * (lazy loading means this sheet may never load, and the rail's badge must
 * not depend on it).
 */
export const pendingInboxStyles = `
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
