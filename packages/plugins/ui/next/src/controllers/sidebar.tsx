/** Sidebar controller: the shell's left column in both wide and 56px rail states.
 *
 * The shell owns the column — its geometry, the top logo row with the brand
 * and collapse toggle, the New Session control, the global panel rows, the
 * workspace browsing region, and the bottom settings foot — and plugins fill
 * the seven holes.
 *
 * When expanded (`wide` is true), the column renders the full browser at
 * `leftWidth`. When collapsed (`wide` is false), the same `<aside>` narrows to
 * a 56px vertical icon rail: resting on the brand mark (which swaps to the
 * expand panel icon on hover), followed by 36x36 icon controls for New
 * Session, the workspace region's rail actions (Add Workspace and Search), and
 * the bottom-pinned Settings gear.
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
  const wide = () => props.leftVisible();
  const toggleLabel = () =>
    wide() ? t("sidebar.toggleCollapse") : t("sidebar.toggleOpen");

  return (
    <>
      <aside
        class={`${styles.sidebar} ${wide() ? "" : styles.collapsed}`}
        style={{
          width: wide() ? `${props.leftWidth()}px` : "56px",
          "--sidebar-content-width": `${Math.max(180, props.leftWidth() - 24)}px`,
        }}
        data-wide={wide()}
      >
        <div class={styles.logoRow}>
          <button
            type="button"
            class={styles.brand}
            aria-label={t("sidebar.newSession")}
            tabIndex={wide() ? 0 : -1}
            onClick={() => props.onCreateSession()}
          >
            <span class={styles.brandIdentity}>
              <span class={styles.brandMark}>
                <SlotOr
                  slots={props.slots}
                  name="sidebar.brand.mark"
                  t={t}
                  fallback={
                    <img
                      class={styles.brandLogoImg}
                      src="/brand.png"
                      alt="Natalia"
                    />
                  }
                />
              </span>
              <span class={styles.brandName}>
                <SlotOr
                  slots={props.slots}
                  name="sidebar.brand.name"
                  t={t}
                  fallback={
                    <>
                      <span class={styles.brandTitle}>Natalia</span>
                      <span class={styles.brandBadge}>Harness</span>
                    </>
                  }
                />
              </span>
            </span>
          </button>
          <button
            type="button"
            class={`${styles.iconButton} ${styles.toggle}`}
            aria-label={toggleLabel()}
            data-tooltip={toggleLabel()}
            onClick={() => props.setLeftVisible((v) => !v)}
          >
            <Show when={!wide()}>
              <span class={styles.railMark} aria-hidden="true">
                <img
                  class={styles.brandLogoImg}
                  src="/brand.png"
                  alt="Natalia"
                />
              </span>
            </Show>
            <svg
              class={styles.panelIcon}
              width={wide() ? "16" : "18"}
              height={wide() ? "16" : "18"}
              viewBox="0 0 16 16"
              fill="none"
              aria-hidden="true"
              stroke-width="1"
            >
              <path
                d="M13.5 1.5H2.5C1.94772 1.5 1.5 1.94772 1.5 2.5V13.5C1.5 14.0523 1.94772 14.5 2.5 14.5H13.5C14.0523 14.5 14.5 14.0523 14.5 13.5V2.5C14.5 1.94772 14.0523 1.5 13.5 1.5Z"
                stroke="currentColor"
              />
              <path d="M5.5 1.5V14.5" stroke="currentColor" />
            </svg>
            <Show when={!wide()}>
              <SlotMount
                slots={props.slots}
                name="sidebar.toggle.badge"
                t={t}
              />
            </Show>
          </button>
        </div>

        {/* New Session: 38px bar when wide, 36x36 icon control in the rail. */}
        <button
          type="button"
          class={styles.newSession}
          aria-label={t("sidebar.newSession")}
          data-tooltip={!wide() ? t("sidebar.newSession") : undefined}
          onClick={() => props.onCreateSession()}
        >
          <span class={styles.newSessionLabelMask}>
            <span class={styles.newSessionContent}>
              <svg
                width={wide() ? "14" : "18"}
                height={wide() ? "14" : "18"}
                viewBox="0 0 16 16"
                fill="none"
                aria-hidden="true"
                stroke-width={wide() ? "1.3" : "1"}
              >
                <path
                  d="M2.37091 11.2501C1.58745 9.89288 1.32067 8.29835 1.61969 6.76006C1.91872 5.22177 2.76342 3.8433 3.99826 2.87846C5.2331 1.91362 6.77494 1.42737 8.33988 1.50925C9.90482 1.59113 11.3875 2.23562 12.5149 3.32406C13.6425 4.41269 14.3387 5.87206 14.4754 7.4334C14.612 8.99474 14.18 10.5529 13.2587 11.8209C12.3375 13.0888 10.9891 13.9813 9.46194 14.3337C8.18691 14.628 6.85895 14.5294 5.64989 14.0605C5.1712 13.8748 4.76962 13.4932 4.26534 13.3967C3.67413 13.2835 2.95257 13.5598 2.03794 14.3337"
                  stroke="currentColor"
                />
                <path d="M8 5V11" stroke="currentColor" />
                <path d="M5 8H11" stroke="currentColor" />
              </svg>
              <span class={styles.newSessionLabel}>
                {t("sidebar.newSessionShort")}
              </span>
            </span>
          </span>
        </button>

        {/* Global panel rows. */}
        <div class={styles.panellist}>
          <SlotMount slots={props.slots} name="sidebar.panellist" t={t} />
        </div>

        {/* Workspace and session browsing region (mounts in both wide and rail states). */}
        <div class={styles.workspaces}>
          <SlotMount slots={props.slots} name="sidebar.workspaces" t={t} />
        </div>

        {/* Foot: footer action above the settings trigger seat. */}
        <div class={styles.foot}>
          <div class={styles.footerActions}>
            <SlotMount slots={props.slots} name="sidebar.footer.action" t={t} />
          </div>
          <div class={styles.settingsArea}>
            <SlotOr
              slots={props.slots}
              name="sidebar.settings"
              t={t}
              fallback={
                <button
                  type="button"
                  class={styles.settingsSeat}
                  aria-label={t("topbar.settings")}
                  data-tooltip={!wide() ? t("topbar.settings") : undefined}
                  onClick={() => props.onOpenSettings()}
                >
                  <svg
                    width={wide() ? "16" : "18"}
                    height={wide() ? "16" : "18"}
                    viewBox="0 0 16 16"
                    fill="none"
                    aria-hidden="true"
                    stroke-width="1.3"
                  >
                    <path
                      d="M8 9.75012C8.9665 9.75012 9.75 8.96662 9.75 8.00012C9.75 7.03362 8.9665 6.25012 8 6.25012C7.0335 6.25012 6.25 7.03362 6.25 8.00012C6.25 8.96662 7.0335 9.75012 8 9.75012Z"
                      stroke="currentColor"
                    />
                    <path
                      d="M13.0107 7.79377C12.9505 7.89401 12.9205 7.94413 12.9205 7.99951C12.9205 8.0549 12.9505 8.10502 13.0106 8.20528L13.9849 9.83006C14.045 9.93029 14.0751 9.9804 14.0751 10.0358C14.0751 10.0911 14.045 10.1413 13.9849 10.2415L13.0037 11.8777C12.9468 11.9726 12.9184 12.0201 12.8725 12.0461C12.8267 12.072 12.7713 12.072 12.6607 12.072H10.6704C10.5598 12.072 10.5045 12.072 10.4586 12.098C10.4128 12.1239 10.3843 12.1714 10.3274 12.2662L9.33825 13.9142C9.28133 14.009 9.25287 14.0564 9.20703 14.0823C9.16118 14.1083 9.10588 14.1083 8.99529 14.1083H7.00486C6.89426 14.1083 6.83896 14.1083 6.79312 14.0823C6.74727 14.0564 6.71881 14.009 6.6619 13.9142L5.67273 12.2662C5.61581 12.1714 5.58735 12.1239 5.54151 12.098C5.49566 12.072 5.44036 12.072 5.32977 12.072H3.33945C3.2288 12.072 3.17347 12.072 3.12761 12.0461C3.08176 12.0201 3.0533 11.9726 2.9964 11.8777L2.0152 10.2415C1.9551 10.1413 1.92505 10.0911 1.92505 10.0358C1.92505 9.9804 1.9551 9.93029 2.0152 9.83006L2.98951 8.20528C3.04963 8.10502 3.07969 8.0549 3.07969 7.99951C3.07968 7.94413 3.04961 7.89401 2.98946 7.79377L2.01529 6.17011C1.95514 6.06987 1.92507 6.01975 1.92507 5.96437C1.92506 5.90899 1.95512 5.85886 2.01524 5.7586L2.9964 4.1224C3.0533 4.0275 3.08176 3.98005 3.12761 3.95408C3.17347 3.92811 3.2288 3.92811 3.33945 3.92811H5.32977C5.44036 3.92811 5.49566 3.92811 5.54151 3.90216C5.58735 3.87621 5.61581 3.82879 5.67273 3.73397L6.6619 2.08599C6.71881 1.99116 6.74727 1.94375 6.79312 1.9178C6.83896 1.89185 6.89426 1.89185 7.00486 1.89185H8.99529C9.10588 1.89185 9.16118 1.89185 9.20703 1.9178C9.25287 1.94375 9.28133 1.99116 9.33825 2.08599L10.3274 3.73397C10.3843 3.82879 10.4128 3.87621 10.4586 3.90216C10.5045 3.92811 10.5598 3.92811 10.6704 3.92811H12.6607C12.7713 3.92811 12.8267 3.92811 12.8725 3.95408C12.9184 3.98005 12.9468 4.0275 13.0037 4.1224L13.9849 5.7586C14.045 5.85886 14.0751 5.90899 14.0751 5.96437C14.0751 6.01975 14.045 6.06987 13.9849 6.17011L13.0107 7.79377Z"
                      stroke="currentColor"
                      stroke-miterlimit="10"
                    />
                  </svg>
                  <span class={styles.settingsLabel}>
                    {t("topbar.settings")}
                  </span>
                </button>
              }
            />
          </div>
        </div>
      </aside>
      <Show when={wide()}>
        <div
          class="neu-resizer"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={props.startLeftResize}
        />
      </Show>
    </>
  );
}
