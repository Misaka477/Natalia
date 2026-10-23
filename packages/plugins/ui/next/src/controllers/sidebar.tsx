/** Sidebar controller: the shell's left column.
 *
 * The shell owns the column — its geometry, the brand row, New Session,
 * the global panel rows and the foot — and a plugin fills the holes.
 * That is the division the reference harness uses, and it is why this
 * file exists: the column used to be the session tree's own `<aside>`,
 * which meant the tree owned the shell's left column and nothing else
 * could ever live in it.
 *
 * `wide` is the column's one state: wide renders the full browser, the
 * rail is the icon column, and a click on a rail icon asks to expand.
 * The owner share carries nothing else — a plugin that fills a hole
 * gets the translate function and nothing more, so it cannot reach the
 * column's layout.
 */
import { Show, type JSX } from "solid-js";
import { SlotMount } from "../slots/mount";
import type { SlotsRegistry, SlotName } from "../slots/registry";
import styles from "../styles/sidebar.module.css";

/** A hole with the shell's own fallback, so an unfilled slot is not a
 *  gap: the brand row and the settings seat are the shell's until a
 *  deployment replaces them. */
function SlotOr(props: {
  slots: SlotsRegistry;
  name: SlotName;
  t: (key: string, params?: Record<string, unknown>) => string;
  fallback: JSX.Element;
}) {
  return (
    <Show when={props.slots.get(props.name)} fallback={props.fallback}>
      <SlotMount slots={props.slots} name={props.name} t={props.t} />
    </Show>
  );
}

export interface SidebarProps {
  t: (key: string, params?: Record<string, unknown>) => string;
  slots: SlotsRegistry;
  leftVisible: () => boolean;
  setLeftVisible: (value: boolean | ((prev: boolean) => boolean)) => void;
  leftWidth: () => number;
  startLeftResize: (event: PointerEvent) => void;
  /** New Session is the column's own action, the shell's to own. */
  onCreateSession: () => void;
  /** Opens the settings window — the settings seat's fallback. */
  onOpenSettings: () => void;
}

export function Sidebar(props: SidebarProps) {
  const t = props.t;
  return (
    <>
      {props.leftVisible() ? (
        <>
          <aside
            class={styles.sidebar}
            style={{ width: `${props.leftWidth()}px` }}
            data-wide={props.leftWidth() >= 230}
          >
            {/* The brand row. The mark and the name are holes: a
                deployment replaces them without touching the shell, and
                until it does the shell's own brand is what shows. */}
            <div class={styles.brand}>
              <SlotOr
                slots={props.slots}
                name="sidebar.brand.mark"
                t={t}
                fallback={<span class={styles.brandMark}>N</span>}
              />
              <SlotOr
                slots={props.slots}
                name="sidebar.brand.name"
                t={t}
                fallback={<span class={styles.brandName}>Natalia</span>}
              />
            </div>

            {/* New Session. The shell owns it — it is the column's one
                action, not the workspace browser's. */}
            <button
              type="button"
              class={styles.newSession}
              onClick={() => props.onCreateSession()}
            >
              {t("sidebar.newSession")}
            </button>

            {/* The global panel rows: each addresses one of the shell's
                panels. Empty until a deployment fills it — an invented
                row of icons would be a control that goes nowhere. */}
            <div class={styles.panellist}>
              <SlotMount slots={props.slots} name="sidebar.panellist" t={t} />
            </div>

            {/* The workspace and session browsing region: a hole, the
                same as every other. The shell registers its own browser
                into it, so what browses in the column is one
                registration away from being swapped. */}
            <div class={styles.workspaces}>
              <SlotMount slots={props.slots} name="sidebar.workspaces" t={t} />
            </div>

            {/* The foot: an action beside the settings seat, then the
                seat itself. The seat carries only the column's display
                state, never any settings state. */}
            <div class={styles.foot}>
              <SlotMount
                slots={props.slots}
                name="sidebar.footer.action"
                t={t}
              />
              <SlotOr
                slots={props.slots}
                name="sidebar.settings"
                t={t}
                fallback={
                  <button
                    type="button"
                    class={styles.settingsSeat}
                    onClick={() => props.onOpenSettings()}
                  >
                    {t("topbar.settings")}
                  </button>
                }
              />
            </div>
          </aside>
          <div
            class="neu-resizer"
            role="separator"
            aria-orientation="vertical"
            onPointerDown={props.startLeftResize}
          />
        </>
      ) : (
        <button
          type="button"
          class="neu-collapsed-rail neu-left-rail"
          onClick={() => props.setLeftVisible(true)}
          title={t("workbench.collapseLeft")}
        >
          {/* A notification inside the expand button: non-interactive,
              and only there when something is waiting. */}
          <SlotMount slots={props.slots} name="sidebar.toggle.badge" t={t} />
          <span class="neu-rail-dots" />
        </button>
      )}
    </>
  );
}
