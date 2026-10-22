/** Workbench controller: the right rail — its five tabbed panes, the plugin
 * side panels it hosts, and the collapse/resize chrome around them.
 *
 * The markup moved verbatim from the shell; every shell value it reads
 * arrives through destructured props. The rail stays mounted while
 * collapsed (display: contents) so the panels it hosts never lose their
 * xterm instances, sockets or unsaved buffers.
 */

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

export interface RightRailProps {
  ctx: UiPluginContext;
  t: (key: string, params?: Record<string, unknown>) => string;
  state: () => AppState;
  setState: (value: AppState | ((prev: AppState) => AppState)) => void;
  rightVisible: () => boolean;
  setRightVisible: (value: boolean | ((prev: boolean) => boolean)) => void;
  rightWidth: () => number;
  startRightResize: (event: PointerEvent) => void;
  rightTabs: () => { id: string; label: string }[];
  rightTab: () => string;
  setRightTab: (value: string) => void;
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
        <aside class="neu-secondary" style={{ width: `${rightWidth()}px` }}>
          <div class="neu-secondary-tabs">
            <For each={rightTabs()}>
              {(tab) => (
                <button
                  type="button"
                  class="neu-secondary-tab"
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
          </div>
          <div class="neu-secondary-content">
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
                return (
                  <div
                    class="neu-side-panel-host"
                    style={{
                      height: "100%",
                      ...(rightTab() === item.panel.id
                        ? {}
                        : { display: "none" }),
                    }}
                    ref={(element) => {
                      container = element;
                    }}
                  />
                );
              }}
            </For>
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
