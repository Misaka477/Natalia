/**
 * The PendingBadge's styles — the KIT's styles, not a plugin's.
 *
 * The rule used to live in the pending-inbox plugin's injected sheet,
 * which worked while every plugin's UI bundle loaded eagerly at boot.
 * Lazy activation (mount drives the load) broke it: the shell renders
 * the rail's tab badges from this kit, and the badge arrived unstyled
 * because the plugin that owned its stylesheet never loaded. A
 * component's style ships with the component; this is that correction.
 */
export const PENDING_BADGE_STYLES = `
.natalia-pending-badge { display:inline-flex; align-items:center; justify-content:center; min-width:16px; height:16px; padding:0 4px; margin-left:6px; border-radius:8px; background:var(--neu-accent); color:var(--neu-bg); font-size:10px; font-weight:600; }
`;

/** The doc surface the injection touches — the seam keeps it testable. */
type StyleDocument = {
  querySelector(selectors: string): unknown;
  createElement(tag: "style"): {
    setAttribute(name: string, value: string): void;
    textContent: string;
  };
  head: { append(node: unknown): void };
};

/**
 * Inject the badge styles once per document. A missing document (a
 * non-browser import) is a no-op — the kit is imported everywhere.
 */
export function ensurePendingBadgeStyles(
  doc: StyleDocument | undefined = globalThis.document,
): void {
  if (!doc) return;
  if (doc.querySelector("style[data-natalia-pending-badge]")) return;
  const style = doc.createElement("style");
  style.setAttribute("data-natalia-pending-badge", "true");
  style.textContent = PENDING_BADGE_STYLES;
  doc.head.append(style);
}
