/**
 * Modal layer controller: every overlay window the shell can open, wired
 * to the shell's signals through props. The open state still lives in the
 * shell for now — this is the first cut of the controller split, moving
 * the overlay wiring out of the shell's render so the shell keeps only
 * its regions.
 */

import type { JSX } from "solid-js";
import type {
  ConfigV4,
  RuntimeModelCatalogEntry,
  WorkspaceSummary,
} from "@anthelia/contracts";
import type { UiPluginContext } from "@natalia/ui-host";
import type { AppState } from "@natalia/view-store";
import { ModelPanel } from "../model-panel";
import { PluginManagerPanel } from "../plugin-manager-panel";
import { SandboxPanel } from "../sandbox-panel";
import { SearchPanel } from "../search-panel";
import { SessionActionsPanel } from "../session-actions-panel";
import { SettingsPanel } from "../settings-panel";
import type { CategoryId, RegisteredToolView } from "../settings-panel";
import { StashPanel } from "../stash-panel";
import { StatusPanel } from "../status-panel";
import { WorkspacePanel } from "../workspace-panel";
import { WorkspaceSettingsPanel } from "../workspace-settings-panel";
import { HelpPanel } from "../help-panel";

/** The settings-write trace the shell kept next to its perf log. */
const perfLog = (...args: unknown[]) => {
  if (
    (globalThis as { __NATALIA_PERF_VERBOSE?: number })
      .__NATALIA_PERF_VERBOSE === 1
  ) {
    console.warn(...args);
  }
};

export interface ModalLayerProps {
  ctx: UiPluginContext;
  t: (key: string, params?: Record<string, unknown>) => string;
  state: () => AppState;
  config: () => ConfigV4 | undefined;
  setStateConfig: (config: ConfigV4) => void;
  modelCatalog: () => RuntimeModelCatalogEntry[];
  modelSelectionSignal: () =>
    | { modelID?: string | undefined; variant?: string | undefined }
    | undefined;
  registeredTools: () => RegisteredToolView[];
  workspaces: () => WorkspaceSummary[];
  selectedSession: () => string;
  selectedSessionID: () => string;
  sessionList: () => { id: string; pinned?: boolean }[];
  themeMode: () => string;
  cycleThemeMode: () => void;
  refreshModelConfig: () => Promise<void>;
  refreshWorkspaces: () => Promise<void>;
  refreshSessions: () => Promise<void>;
  physicallyDeleteSelectedSession: () => Promise<void> | void;
  workspaceIDForSelectedSession: () => string | undefined;
  // open state
  settingsOpen: () => boolean;
  settingsCategory: () => CategoryId | undefined;
  setSettingsOpen: (open: boolean) => void;
  setSettingsCategory: (category: CategoryId | undefined) => void;
  pluginManagerOpen: () => boolean;
  setPluginManagerOpen: (open: boolean) => void;
  modelOpen: () => boolean;
  setModelOpen: (open: boolean) => void;
  searchOpen: () => boolean;
  setSearchOpen: (open: boolean) => void;
  helpOpen: () => boolean;
  setHelpOpen: (open: boolean) => void;
  stashOpen: () => boolean;
  setStashOpen: (open: boolean) => void;
  sandboxOpen: () => boolean;
  setSandboxOpen: (open: boolean) => void;
  statusOpen: () => boolean;
  setStatusOpen: (open: boolean) => void;
  workspaceOpen: () => boolean;
  setWorkspaceOpen: (open: boolean) => void;
  workspaceError: () => string;
  setWorkspaceError: (error: string) => void;
  workspaceSettingsOpen: () => boolean;
  setWorkspaceSettingsOpen: (open: boolean) => void;
  settingsWorkspaceID: () => string | undefined;
  sessionMenuOpen: () => boolean;
  setSessionMenuOpen: (open: boolean) => void;
  dialog: JSX.Element;
}

/** Every overlay window the shell can open. */
export function ModalLayer(props: ModalLayerProps) {
  const t = props.t;
  const runtime = () => props.ctx.runtime;
  return (
    <>
      <WorkspaceSettingsPanel
        t={t}
        open={props.workspaceSettingsOpen()}
        workspaceID={
          props.settingsWorkspaceID() ??
          props.workspaces().find((entry) => entry.status === "active")
            ?.workspaceID
        }
        runtime={runtime()}
        onClose={() => props.setWorkspaceSettingsOpen(false)}
      />
      <WorkspacePanel
        t={t}
        open={props.workspaceOpen()}
        onClose={() => props.setWorkspaceOpen(false)}
        error={props.workspaceError()}
        runtime={runtime()}
        onAdd={async (path) => {
          props.setWorkspaceError("");
          try {
            if (!path) return;
            const rt = runtime();
            if (!rt.workspaceAdd) {
              props.setWorkspaceError(t("modals.workspaceAddUnsupported"));
              throw new Error("workspaceAdd unsupported");
            }
            const workspace = (await rt.workspaceAdd({
              path,
            })) as WorkspaceSummary;
            if (!workspace)
              throw new Error("workspaceAdd returned no workspace");
            if (workspace.status !== "active") {
              await rt.workspaceActivate?.(workspace.workspaceID);
            }
            await props.refreshWorkspaces();
            await props.refreshSessions();
          } catch (error: unknown) {
            props.setWorkspaceError(
              error instanceof Error ? error.message : String(error),
            );
            throw error;
          }
        }}
      />
      <SessionActionsPanel
        t={t}
        open={props.sessionMenuOpen()}
        session={props.selectedSession()}
        onClose={() => props.setSessionMenuOpen(false)}
        onPin={async () => {
          if (!props.selectedSessionID()) return;
          const target = props
            .sessionList()
            .find((entry) => entry.id === props.selectedSessionID());
          await runtime().sessionPin?.(
            props.selectedSessionID(),
            !target?.pinned,
          );
          await props.refreshSessions();
        }}
        onSnapshot={() => runtime().snapshot()}
        onRollback={() =>
          runtime().checkpointRollback?.({
            id:
              props.state().checkpoints[props.state().checkpoints.length - 1]
                ?.id ?? "",
            sessionID: props.selectedSessionID() || props.state().sessionID,
          })
        }
        onDelete={() => props.physicallyDeleteSelectedSession()}
      />
      <SandboxPanel
        t={t}
        open={props.sandboxOpen()}
        onClose={() => props.setSandboxOpen(false)}
        sandboxes={props.state().sandboxes}
        sessionID={props.selectedSessionID() || props.state().sessionID}
        runtime={runtime()}
      />
      <StashPanel
        t={t}
        open={props.stashOpen()}
        onClose={() => props.setStashOpen(false)}
      />
      <HelpPanel
        t={t}
        open={props.helpOpen()}
        onClose={() => props.setHelpOpen(false)}
      />
      <SearchPanel
        t={t}
        open={props.searchOpen()}
        onClose={() => props.setSearchOpen(false)}
        onSearch={(query) =>
          runtime().workspaceSearch?.({
            workspaceID: props.workspaceIDForSelectedSession(),
            query,
            limit: 50,
          })
        }
        onSelect={(result) => {
          window.dispatchEvent(
            new CustomEvent("natalia:open-file", {
              detail: { path: result.path, line: result.line },
            }),
          );
          props.setSearchOpen(false);
        }}
      />
      <ModelPanel
        open={props.modelOpen()}
        onClose={() => props.setModelOpen(false)}
        catalog={props.modelCatalog()}
        selection={props.modelSelectionSignal() ?? undefined}
        providers={props.config()?.providers}
        config={props.config()}
        onSetDefault={async (modelID) => {
          const result = await runtime().setDefaultModel?.(modelID);
          await props.refreshModelConfig();
          return result;
        }}
        onAddProvider={async (input) => {
          const rt = runtime();
          if (!rt.providerAdd) {
            throw new Error("providerAdd runtime method unavailable");
          }
          const result = await rt.providerAdd(input);
          if (!result.saved)
            throw new Error("providerAdd did not save provider");
          await props.refreshModelConfig();
        }}
        onDiscoverModels={async (input) => {
          const rt = runtime();
          if (!rt.providerDiscover) {
            throw new Error("providerDiscover runtime method unavailable");
          }
          return await rt.providerDiscover(input);
        }}
        onRemoveProvider={async (name) => {
          const rt = runtime();
          if (!rt.providerRemove) {
            throw new Error("providerRemove runtime method unavailable");
          }
          const result = await rt.providerRemove(name);
          if (result.removed) await props.refreshModelConfig();
          return result;
        }}
      />
      <StatusPanel
        open={props.statusOpen()}
        onClose={() => props.setStatusOpen(false)}
        state={props.state()}
        runtime={runtime()}
      />
      <PluginManagerPanel
        t={t}
        open={props.pluginManagerOpen()}
        onClose={() => props.setPluginManagerOpen(false)}
        ctx={props.ctx}
      />
      <SettingsPanel
        t={t}
        host={props.ctx.host}
        open={props.settingsOpen()}
        category={props.settingsCategory()}
        onClose={() => {
          props.setSettingsOpen(false);
          props.setSettingsCategory(undefined);
        }}
        onOpenModels={() => {
          props.setModelOpen(true);
          props.setSettingsOpen(false);
        }}
        themeMode={props.themeMode()}
        onCycleThemeMode={props.cycleThemeMode}
        state={props.state()}
        config={props.config()}
        preferences={props.ctx.preferences}
        registeredTools={props.registeredTools()}
        runtime={runtime()}
        onUpdateConfig={async (patch) => {
          perfLog("[settings] write ->", JSON.stringify(patch));
          const applied = await runtime().updateConfig?.({
            patch,
            scope: "global",
          });
          perfLog("[settings] write applied <-", applied);
          const next = await runtime().configGet?.();
          perfLog(
            "[settings] re-read <-",
            JSON.stringify({
              compactionEnabled: next?.context?.compactionEnabled,
              shellExecutable: next?.runtime?.shell?.executable,
              maxSteps: next?.runtime?.maxStepsPerTurn,
            }),
          );
          if (next) props.setStateConfig(next);
        }}
        onConfig={(next) => {
          perfLog("[settings] onConfig ->", JSON.stringify(next));
          props.setStateConfig(next as unknown as ConfigV4);
        }}
      />
      {props.dialog}
    </>
  );
}
