/** Input area controller: the message queue, usage bar, pending takeover
 * and composer for both agent panes.
 */

import { createMemo, type JSX } from "solid-js";
import type { UiPluginContext } from "@natalia/ui-host";
import type { AppState } from "@natalia/view-store";
import { QueueDock } from "../components/QueueDock";
import { SessionUsageBar } from "../components/SessionUsageBar";
import {
  Composer,
  type ComposerAttachment,
  type ComposerSlashCommand,
} from "../components/Composer";
import { goalCommandInstruction } from "../app-neu";

export interface MainInputAreaProps {
  ctx: UiPluginContext;
  t: (key: string, params?: Record<string, unknown>) => string;
  slots: any;
  commands: any;
  state: () => AppState;
  selectedSessionID: () => string;
  ensureSession?: () => Promise<string | undefined>;
  mainDraft: () => string;
  setMainDraft: (value: string | ((prev: string) => string)) => void;
  mainAttachments: () => ComposerAttachment[];
  setMainAttachments: (
    value:
      | ComposerAttachment[]
      | ((prev: ComposerAttachment[]) => ComposerAttachment[]),
  ) => void;
  handlePasteAttachments: (
    event: ClipboardEvent,
    current: ComposerAttachment[],
    setAttachments: (value: ComposerAttachment[]) => void,
  ) => void;
  pendingTakeoverCount: () => number;
  pendingTakeoverMinimized: () => boolean;
  setPendingTakeoverMinimized: (
    value: boolean | ((prev: boolean) => boolean),
  ) => void;
  pendingTakeoverFocus: () => string | undefined;
  setPendingTakeoverFocus: (value: string | undefined) => void;
  pendingRollback: () => any;
  setPendingRollback: (value: any) => void;
  setRollbackNotice: (value: any) => void;
  refreshTranscript: () => Promise<void>;
  perfLog: (...args: unknown[]) => void;
  children?: JSX.Element;
  trailing?: JSX.Element;
}

/** The Natalia pane's input area: queue, usage, composer and bottom controls. */
export function MainInputArea(props: MainInputAreaProps) {
  const t = props.t;
  const {
    state,
    selectedSessionID,
    mainDraft,
    setMainDraft,
    mainAttachments,
    setMainAttachments,
    handlePasteAttachments,
    pendingRollback,
    setPendingRollback,
    setRollbackNotice,
    refreshTranscript,
    perfLog,
  } = props;
  const IGNORED_DIRS = new Set([
    "__pycache__",
    ".pytest_cache",
    ".natalia",
    ".git",
    "node_modules",
  ]);
  const searchWorkspaceFiles = async (query: string) => {
    const q = query.trim();
    if (!q && props.ctx.runtime.workspaceList) {
      const page = await props.ctx.runtime.workspaceList({ path: "." });
      return (page?.entries ?? []).filter((e) => {
        const clean = e.path.replace(/\\/gu, "/").replace(/\/+$/u, "");
        return !IGNORED_DIRS.has(clean);
      });
    }
    const res = await props.ctx.runtime.workspaceFiles?.({
      query: q,
      limit: 20,
    });
    return (res ?? []).filter((e) => e.type === "file");
  };

  const slashCommandList = createMemo<ComposerSlashCommand[]>(() => {
    const base: ComposerSlashCommand[] = [
      {
        slash: "/goal",
        description: t("composer.cmd.goal"),
        insertText: "/goal ",
      },
      {
        slash: "/goal status",
        description: t("composer.cmd.goalStatus"),
        insertText: "/goal status",
      },
      {
        slash: "/goal pause",
        description: t("composer.cmd.goalPause"),
        insertText: "/goal pause",
      },
      {
        slash: "/goal resume",
        description: t("composer.cmd.goalResume"),
        insertText: "/goal resume",
      },
      {
        slash: "/goal clear",
        description: t("composer.cmd.goalClear"),
        insertText: "/goal clear",
      },
    ];
    const registered = (props.commands?.list?.() ?? []) as Array<{
      id: string;
      title: string;
      run: () => void;
    }>;
    for (const cmd of registered) {
      const shortName = cmd.id.replace(/^shell\./u, "");
      base.push({
        slash: `/${shortName}`,
        description: cmd.title,
        execute: () => cmd.run(),
      });
    }
    return base;
  });

  return (
    <>
      <QueueDock
        t={t}
        items={state().pendingInputs}
        onRemove={(id) => {
          void props.ctx.runtime.removeInput?.({
            id,
            sessionID: selectedSessionID() || state().sessionID,
          });
        }}
        onReplace={(id, text) => {
          void props.ctx.runtime.replaceInput?.({
            id,
            text,
            sessionID: selectedSessionID() || state().sessionID,
          });
        }}
        onPromote={(id) => {
          void props.ctx.runtime.promoteInput?.({
            id,
            sessionID: selectedSessionID() || state().sessionID,
          });
        }}
      />
      <SessionUsageBar t={t} usage={state().usageByChannel.main} />
      <Composer
        t={t}
        value={mainDraft()}
        placeholder={t("hero.placeholder")}
        busy={Boolean(state().natalia.activeTurn)}
        onInput={setMainDraft}
        onStop={() =>
          props.ctx.runtime.cancel?.(
            "user cancel",
            selectedSessionID() || state().sessionID,
          )
        }
        attachments={mainAttachments()}
        slashCommands={slashCommandList}
        onSearchFiles={
          props.ctx.runtime.workspaceFiles || props.ctx.runtime.workspaceList
            ? searchWorkspaceFiles
            : undefined
        }
        onRemoveAttachment={(path) =>
          setMainAttachments(
            mainAttachments().filter((item) => item.path !== path),
          )
        }
        onPaste={(event) =>
          handlePasteAttachments(event, mainAttachments(), setMainAttachments)
        }
        trailing={props.trailing}
        onSubmit={() => {
          const text = mainDraft();
          const paths = mainAttachments().map((item) => item.path);
          if (text.trim() || paths.length) {
            const rollback = pendingRollback();
            const submit = async () => {
              try {
                let sessionID: string | undefined = selectedSessionID();
                if (!sessionID && props.ensureSession) {
                  sessionID = await props.ensureSession();
                }
                if (!sessionID) sessionID = state().sessionID;
                if (rollback) {
                  const messageResult =
                    rollback.turnID && sessionID
                      ? await props.ctx.runtime.sessionRollbackMessages?.(
                          sessionID,
                          rollback.turnID,
                        )
                      : undefined;
                  const preview = rollback.checkpointID
                    ? await props.ctx.runtime.checkpointRollback?.({
                        id: rollback.checkpointID,
                        sessionID,
                      })
                    : undefined;
                  await refreshTranscript();
                  if (messageResult || preview) {
                    setRollbackNotice({
                      text:
                        messageResult && preview
                          ? t("input.rollback.noticeBoth")
                          : preview
                            ? t("input.rollback.noticeWorkspace")
                            : messageResult?.safetyCheckpointID
                              ? t("input.rollback.noticeSafety")
                              : t("input.rollback.noticeMessages"),
                      safetyCheckpointID:
                        messageResult?.safetyCheckpointID ??
                        preview?.safetyCheckpointID,
                    });
                  }
                } else {
                  setRollbackNotice(undefined);
                }
                perfLog("[web-plugin] send", text);
                const busy = Boolean(state().natalia.activeTurn);
                const busySendDelivery =
                  props.ctx.preferences.get<"next-step" | "next-turn">(
                    "busySendDelivery",
                  ) ?? "next-step";
                const outgoing = goalCommandInstruction(text) ?? text;
                if (props.ctx.runtime.submitInput) {
                  props.ctx.runtime.submitInput({
                    text: outgoing,
                    ...(paths.length ? { attachments: paths } : {}),
                    ...(busy ? { delivery: busySendDelivery } : {}),
                    sessionID,
                  });
                } else {
                  props.ctx.runtime.submit?.(text, sessionID);
                }
              } finally {
                setMainDraft("");
                setMainAttachments([]);
                setPendingRollback(undefined);
              }
            };
            void submit();
          }
        }}
      >
        {props.children}
      </Composer>
    </>
  );
}

export interface ChatInputAreaProps {
  ctx: UiPluginContext;
  t: (key: string, params?: Record<string, unknown>) => string;
  slots: any;
  naviChatActivity: any;
  state: () => AppState;
  selectedSessionID: () => string;
  ensureSession?: () => Promise<string | undefined>;
  chatDraft: () => string;
  setChatDraft: (value: string | ((prev: string) => string)) => void;
  chatAttachments: () => ComposerAttachment[];
  setChatAttachments: (
    value:
      | ComposerAttachment[]
      | ((prev: ComposerAttachment[]) => ComposerAttachment[]),
  ) => void;
  handlePasteAttachments: (
    event: ClipboardEvent,
    current: ComposerAttachment[],
    setAttachments: (value: ComposerAttachment[]) => void,
  ) => void;
  updateChatProfile: (next: any) => Promise<void>;
  perfLog: (...args: unknown[]) => void;
  children?: JSX.Element;
  trailing?: JSX.Element;
}

/** The Navi pane's input area: usage bar and chat composer. */
export function ChatInputArea(props: ChatInputAreaProps) {
  const t = props.t;
  const {
    naviChatActivity,
    state,
    selectedSessionID,
    chatDraft,
    setChatDraft,
    chatAttachments,
    setChatAttachments,
    handlePasteAttachments,
    perfLog,
  } = props;
  const IGNORED_DIRS = new Set([
    "__pycache__",
    ".pytest_cache",
    ".natalia",
    ".git",
    "node_modules",
  ]);
  const searchWorkspaceFiles = async (query: string) => {
    const q = query.trim();
    if (!q && props.ctx.runtime.workspaceList) {
      const page = await props.ctx.runtime.workspaceList({ path: "." });
      return (page?.entries ?? []).filter((e) => {
        const clean = e.path.replace(/\\/gu, "/").replace(/\/+$/u, "");
        return !IGNORED_DIRS.has(clean);
      });
    }
    const res = await props.ctx.runtime.workspaceFiles?.({
      query: q,
      limit: 20,
    });
    return (res ?? []).filter((e) => e.type === "file");
  };

  return (
    <>
      <SessionUsageBar t={t} usage={state().usageByChannel.navi} />
      <Composer
        t={t}
        value={chatDraft()}
        placeholder={t("input.chatPlaceholder")}
        busy={Boolean(naviChatActivity())}
        onInput={setChatDraft}
        onSearchFiles={
          props.ctx.runtime.workspaceFiles || props.ctx.runtime.workspaceList
            ? searchWorkspaceFiles
            : undefined
        }
        onStop={() =>
          void props.ctx.runtime.naviChat?.abort?.(
            selectedSessionID() || state().sessionID,
          )
        }
        attachments={chatAttachments()}
        onRemoveAttachment={(path) =>
          setChatAttachments(
            chatAttachments().filter((item) => item.path !== path),
          )
        }
        onPaste={(event) =>
          handlePasteAttachments(event, chatAttachments(), setChatAttachments)
        }
        trailing={props.trailing}
        onSubmit={() => {
          const text = chatDraft();
          const pending = chatAttachments();
          if (text.trim() || pending.length) {
            setChatDraft("");
            setChatAttachments([]);
            void (async () => {
              let sessionID: string | undefined = selectedSessionID();
              if (!sessionID && props.ensureSession) {
                sessionID = await props.ensureSession();
              }
              if (!sessionID) sessionID = state().sessionID;
              perfLog("[navi-ui] submitting chat", {
                text,
                attachments: pending.map((item) => item.path),
              });
              const result = props.ctx.runtime.naviChat?.submit?.({
                text,
                sessionID,
                ...(pending.length
                  ? {
                      attachments: pending.map((item) => item.path),
                    }
                  : {}),
              });
              if (result && typeof result.then === "function") {
                void result
                  .then((value) =>
                    perfLog("[navi-ui] chatSubmit resolved", value),
                  )
                  .catch((cause) =>
                    console.error(
                      "[navi-ui] chatSubmit failed",
                      cause instanceof Error ? cause.message : String(cause),
                    ),
                  );
              }
            })();
          }
        }}
      >
        {props.children}
      </Composer>
    </>
  );
}
