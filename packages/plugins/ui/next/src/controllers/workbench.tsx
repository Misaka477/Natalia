/** Workbench controller: the right rail — its five tabbed panes, the plugin
 * side panels it hosts, and the collapse/resize chrome around them.
 *
 * The markup moved verbatim from the shell; every shell value it reads
 * arrives through destructured props. The rail stays mounted while
 * collapsed (display: contents) so the panels it hosts never lose their
 * xterm instances, sockets or unsaved buffers.
 */

import styles from "../styles/workbench.module.css";
import { createEffect, For, Show } from "solid-js";
import type { AppState } from "@natalia/view-store";
import type { UiPluginContext } from "@natalia/ui-host";
import { PendingBadge } from "@natalia/ui-kit";
import { ReviewPane } from "../components/RightPanel";
import { PlanPanel } from "../plan-panel";
import { GovernancePane } from "../governance-panel";
import { NiaPanel } from "../nia-panel";
import { AgentPanel } from "../agent-panel";
import { cloneState } from "@natalia/view-store";
import { dockTargetFor } from "../terminal/dock-targets";
import { SlotMount } from "../slots/mount";

export interface RightRailProps {
  ctx: UiPluginContext;
  t: (key: string, params?: Record<string, unknown>) => string;
  slots: any;
  dockMode: () => any;
  state: () => AppState;
  setState: (value: AppState | ((prev: AppState) => AppState)) => void;
  rightVisible: () => boolean;
  setRightVisible: (value: boolean | ((prev: boolean) => boolean)) => void;
  rightWidth: () => number;
  startRightResize: (event: PointerEvent) => void;
  rightTabs: () => { id: string; label: string }[];
  rightTab: () => string;
  setRightTab: (value: string) => void;
  /** Walks the terminal's dock mode: rail tab → side split → float. */
  onCycleDockMode: () => void;
  openDriftCount: () => number | undefined;
  rightPanelScopeKey: () => string;
  reviewRequestedTab: () => "git" | "sandbox" | "checkpoint";
  reviewRequestedCheckpointID: () => string | undefined;
  selectedSessionID: () => string;
  workspaceIDForRightPanels: () => string | undefined;
  governanceInitialTab: any;
  modelCatalog: () => any;
  openModelSettings: () => void;
  loadAttachmentUrl: (attachment: any) => Promise<string>;
  resizing: () => boolean;
  niaPaging: () => any;
  loadOlderNiaChat: () => Promise<void>;
  sidePanels: () => {
    pluginId: string;
    panel: { id: string; title?: string };
  }[];
  panelRevision: () => number;
}

/** The right rail: tabbed panes plus the plugin side panels it hosts. */
export function RightRail(props: RightRailProps) {
  const t = props.t;
  const slots = props.slots;
  const {
    ctx,
    state,
    setState,
    rightVisible,
    setRightVisible,
    rightWidth,
    startRightResize,
    rightTabs,
    rightTab,
    setRightTab,
    openDriftCount,
    rightPanelScopeKey,
    reviewRequestedTab,
    reviewRequestedCheckpointID,
    selectedSessionID,
    workspaceIDForRightPanels,
    governanceInitialTab,
    modelCatalog,
    openModelSettings,
    loadAttachmentUrl,
    resizing,
    niaPaging,
    loadOlderNiaChat,
    sidePanels,
    panelRevision,
  } = props;
  return (
    <>
      {" "}
      {/* Right secondary tabs */}
      {/*
          The right rail stays MOUNTED while it is collapsed, and is hidden with
          CSS instead of being unmounted. Unmounting it destroyed every panel it
          hosts — the terminal's xterm instance and its socket, the file
          editor's open tabs and UNSAVED buffers — so collapsing and expanding
          was a way to lose work. `display: contents` leaves the resizer and the
          aside as the flex children they already were, so the layout is byte
          for byte what it was.
        */}
      <div
        style={{
          display: rightVisible() ? "contents" : "none",
        }}
      >
        <div
          class="neu-right-resizer"
          role="separator"
          aria-orientation="vertical"
          onPointerDown={startRightResize}
        />
        <aside class={styles.secondary} style={{ width: `${rightWidth()}px` }}>
          <div class={styles.tabs}>
            <For each={rightTabs()}>
              {(tab) => (
                <button
                  type="button"
                  class={styles.tab}
                  data-active={rightTab() === tab.id}
                  onClick={() => setRightTab(tab.id)}
                >
                  {tab.label}
                  <Show when={tab.id === "governance"}>
                    <PendingBadge count={openDriftCount() ?? 0} />
                  </Show>
                </button>
              )}
            </For>
            {/* THE TERMINAL'S OWN FRAME CONTROL. The terminal is not a
                right-rail tab that happens to be able to move: where it
                lives is the reader's choice, and this is that choice, one
                click from the rail it starts in. The panel host re-parents
                rather than re-mounts, so the xterm, its socket and its
                scrollback survive every mode change. Only shown when a
                side panel is actually hosted — otherwise the control would
                offer a frame with nothing in it. */}
            <Show when={props.sidePanels().length > 0}>
              <button
                type="button"
                class={styles.dockBtn}
                data-mode={props.dockMode()}
                onClick={() => props.onCycleDockMode()}
                title={t(`dock.hint.${props.dockMode()}`)}
              >
                {t(`dock.mode.${props.dockMode()}`)}
              </button>
            </Show>
          </div>
          <div class={styles.content}>
            <Show
              keyed
              when={rightTab() === "diff" ? rightPanelScopeKey() : undefined}
            >
              <ReviewPane
                t={t}
                runtime={props.ctx.runtime}
                events={props.ctx.events}
                requestedTab={reviewRequestedTab()}
                requestedCheckpointID={reviewRequestedCheckpointID()}
                sessionID={selectedSessionID() || state().sessionID}
                workspaceID={workspaceIDForRightPanels()}
              />
            </Show>
            <Show
              keyed
              when={rightTab() === "plan" ? rightPanelScopeKey() : undefined}
            >
              <PlanPanel
                t={t}
                state={state()}
                sessionID={selectedSessionID() || state().sessionID}
                runtime={props.ctx.runtime}
                events={props.ctx.events}
              />
            </Show>
            <Show
              keyed
              when={
                rightTab() === "governance" ? rightPanelScopeKey() : undefined
              }
            >
              <GovernancePane
                t={t}
                state={state()}
                runtime={props.ctx.runtime}
                sessionID={selectedSessionID() || state().sessionID}
                initialTab={governanceInitialTab}
              />
            </Show>
            <Show
              when={rightTab() === "nia" ? rightPanelScopeKey() : undefined}
              keyed
            >
              <NiaPanel
                t={t}
                state={state()}
                runtime={props.ctx.runtime}
                catalog={modelCatalog()}
                sessionID={selectedSessionID() || state().sessionID}
                onOpenSettings={openModelSettings}
                loadAttachmentUrl={loadAttachmentUrl}
                suspendVirtualization={resizing()}
                paging={niaPaging()}
                onLoadOlder={() => void loadOlderNiaChat()}
              />
            </Show>
            <Show
              keyed
              when={rightTab() === "agent" ? rightPanelScopeKey() : undefined}
            >
              <AgentPanel
                t={t}
                state={state()}
                runtime={props.ctx.runtime}
                sessionID={selectedSessionID() || state().sessionID}
                onOpenTerminal={() => setRightTab("terminal")}
                onHydrateSubagentHistory={(history, options) => {
                  props.ctx.projection.hydrateSubagentHistory?.(
                    history,
                    options,
                  );
                  setState(cloneState(props.ctx.projection.getState()));
                }}
              />
            </Show>
            <For each={sidePanels()}>
              {(item) => {
                // Mounted on FIRST activation, then kept: the panel is
                // never rebuilt again, only shown or hidden.
                //
                // Why not eagerly: mounting the terminal panel runs its
                // effect, and a terminal panel with no running pane creates
                // one (`loadTabs`), so eager mounting would spawn a shell
                // for a tab the user never opened. Why not on every
                // activation (what the keyed <Show> did): everything these
                // panels hold lives inside them — an xterm instance with its
                // socket and scrollback, the file editor's open tabs and
                // unsaved buffers — and a re-mount throws all of it away.
                let container: HTMLDivElement | undefined;
                let home: HTMLElement | undefined;
                let everShown = false;
                let mounting = false;
                let mounted = false;
                createEffect(() => {
                  const active = rightTab() === item.panel.id;
                  if (active) everShown = true;
                  // A panel whose plugin is still loading fails to mount;
                  // the catalog revision is the retry signal (the keyed
                  // re-render used to provide that by rebuilding the slot).
                  panelRevision();
                  if (!everShown || !container || mounted || mounting) return;
                  mounting = true;
                  void props.ctx.host
                    ?.mountPanel(item.pluginId, item.panel.id, container)
                    .then(() => {
                      mounted = true;
                    })
                    .catch((error: unknown) => {
                      // Expected once while the plugin catalog races the
                      // mount; the next revision retries.
                      console.warn(
                        `[panel] ${item.pluginId}:${item.panel.id} mount deferred:`,
                        error instanceof Error ? error.message : String(error),
                      );
                    })
                    .finally(() => {
                      mounting = false;
                    });
                });
                // The dock mode re-parents this ONE host div — it appends
                // the element the panel already lives in to the container
                // the current mode names. Appending re-parents; it never
                // re-mounts, so the panel xterm, socket and scrollback
                // survive every mode change.
                createEffect(() => {
                  const mode = props.dockMode();
                  if (!container) return;
                  const target = dockTargetFor(mode);
                  if (!target) {
                    // tab: back to the rail slot that owns it.
                    home?.appendChild(container);
                    return;
                  }
                  target.appendChild(container);
                });
                // THE DOCK MODES AND THIS MOUNT (terminal independent frame).
                //
                // `tab` is what this code does today: the panel's host lives
                // in the rail and is shown or hidden. `split` and `float`
                // must NOT re-mount the panel into a second container —
                // everything these panels hold lives inside them (an xterm
                // instance with its socket and scrollback, the editor's open
                // tabs and unsaved buffers), and a second mount throws all of
                // it away, which is exactly the defect the never-keyed rule
                // above was written to kill.
                //
                // The shape that keeps the invariant: the host div MOVES.
                // One container, created once on first activation and never
                // rebuilt, is appended to whichever parent the current dock
                // mode names — the rail for `tab`, the shell's split column
                // for `split`, the floating frame's body for `float`. The
                // panel's own DOM (and therefore its xterm, its socket and
                // its scrollback) survives the move untouched, because
                // appending an element re-parents it rather than recreating
                // it. The mode change is therefore an appendChild, not a
                // mount — and the guard test's "never keyed and never
                // rebuilt" property stays true under all three modes.
                return (
                  <div
                    class={styles.panelHost}
                    style={{
                      height: "100%",
                      ...(rightTab() === item.panel.id
                        ? {}
                        : { display: "none" }),
                    }}
                    ref={(element) => {
                      container = element;
                      // The rail slot is the host's HOME: the one parent
                      // the dock mode returns it to for `tab`. Captured
                      // once, because a moved element's parent is wherever
                      // the last mode put it.
                      if (!home && element?.parentElement) {
                        home = element.parentElement;
                      }
                    }}
                  />
                );
              }}
            </For>
            {/* A plugin entry inside the right rail, after the shell's own
                tabs — the eighth of the architecture's nine slots. */}
            <SlotMount slots={props.slots} name="workbench.end" t={props.t} />
          </div>
        </aside>
      </div>
      {rightVisible() ? null : (
        <button
          type="button"
          class="neu-collapsed-rail neu-right-rail"
          onClick={() => setRightVisible(true)}
          title={t("workbench.expandRight")}
        >
          <span class="neu-rail-dots" />
        </button>
      )}
    </>
  );
}
