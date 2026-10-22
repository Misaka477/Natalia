/** Input area controller: the message queue, usage bar, pending takeover
 * and composer for both agent panes.
 *
 * Extracted verbatim from the transcript controller; every shell value the
 * markup reads arrives through destructured props, so the markup needed no
 * rewriting.
 */

import { Show } from "solid-js";
import { SlotMount } from "../slots/mount";
import { SlashMenu, slashQuery } from "./slash-menu";
import type { UiPluginContext } from "@natalia/ui-host";
import type { AppState } from "@natalia/view-store";
import { QueueDock } from "../components/QueueDock";
import { SessionUsageBar } from "../components/SessionUsageBar";
import { PendingTakeover } from "../components/PendingTakeover";
import { Composer, type ComposerAttachment } from "../components/Composer";
import { goalCommandInstruction } from "../app-neu";

export interface MainInputAreaProps {
  ctx: UiPluginContext;
  t: (key: string, params?: Record<string, unknown>) => string;
  slots: any;
  commands: any;
  state: () => AppState;
  selectedSessionID: () => string;
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
}

/** The Natalia pane's input area: queue, usage, pending takeover, composer. */
export function MainInputArea(props: MainInputAreaProps) {
  const t = props.t;
  const slots = props.slots;
  const commands = props.commands;
  const {
    ctx,
    state,
    selectedSessionID,
    mainDraft,
    setMainDraft,
    mainAttachments,
    setMainAttachments,
    handlePasteAttachments,
    pendingTakeoverCount,
    pendingTakeoverMinimized,
    setPendingTakeoverMinimized,
    pendingTakeoverFocus,
    setPendingTakeoverFocus,
    pendingRollback,
    setPendingRollback,
    setRollbackNotice,
    refreshTranscript,
    perfLog,
  } = props;
  return (
    <>
      <SlotMount slots={slots} name="input.dock" t={t} />
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
      <Show when={pendingTakeoverCount() > 0 && !pendingTakeoverMinimized()}>
        <PendingTakeover
          t={t}
          ctx={props.ctx}
          minimized={pendingTakeoverMinimized}
          onMinimize={setPendingTakeoverMinimized}
          focusID={pendingTakeoverFocus}
          onFocusHandled={() => setPendingTakeoverFocus(undefined)}
        />
      </Show>
      <Show when={pendingTakeoverCount() === 0 || pendingTakeoverMinimized()}>
        <Composer
          t={t}
          value={mainDraft()}
          placeholder={t("input.messagePlaceholder")}
          busy={Boolean(state().natalia.activeTurn)}
          onInput={setMainDraft}
          attachments={mainAttachments()}
          onRemoveAttachment={(path) =>
            setMainAttachments(
              mainAttachments().filter((item) => item.path !== path),
            )
          }
          onPaste={(event) =>
            handlePasteAttachments(event, mainAttachments(), setMainAttachments)
          }
          onSubmit={() => {
            const text = mainDraft();
            const paths = mainAttachments().map((item) => item.path);
            if (text.trim() || paths.length) {
              const rollback = pendingRollback();
              const submit = async () => {
                try {
                  if (rollback) {
                    const sessionID = selectedSessionID() || state().sessionID;
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
                      // No count: the rollback contract
                      // returns {id, rolledBackTo} and nothing
                      // about how much was removed, so the
                      // "1 条消息" this used to print was
                      // invented — a number that was wrong
                      // for every rollback that removed more
                      // than one message and right only by
                      // coincidence. Saying what happened is
                      // honest; counting it needs the store
                      // to return the number.
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
                  // The Composer opts into mid-turn injection by
                  // default. The settings panel can switch a busy send
                  // to `next-turn`, which queues a separate turn.
                  const busy = Boolean(state().natalia.activeTurn);
                  const busySendDelivery =
                    props.ctx.preferences.get<"next-step" | "next-turn">(
                      "busySendDelivery",
                    ) ?? "next-step";
                  const sessionID = selectedSessionID() || state().sessionID;
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
          onStop={() => props.ctx.runtime.cancel?.()}
        />
      </Show>
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
}

/** The Navi pane's input area: usage bar and chat composer. */
export function ChatInputArea(props: ChatInputAreaProps) {
  const t = props.t;
  const slots = props.slots;
  const {
    ctx,
    naviChatActivity,
    state,
    selectedSessionID,
    chatDraft,
    setChatDraft,
    chatAttachments,
    setChatAttachments,
    handlePasteAttachments,
    updateChatProfile,
    perfLog,
  } = props;
  return (
    <>
      <SessionUsageBar t={t} usage={state().usageByChannel.navi} />
      <Composer
        t={t}
        value={chatDraft()}
        placeholder={t("input.chatPlaceholder")}
        busy={Boolean(naviChatActivity())}
        onInput={setChatDraft}
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
        onSubmit={() => {
          const text = chatDraft();
          if (text.trim() || chatAttachments().length) {
            perfLog("[navi-ui] submitting chat", {
              text,
              attachments: chatAttachments().map((item) => item.path),
            });
            const result = props.ctx.runtime.naviChat?.submit?.({
              text,
              sessionID: selectedSessionID() || state().sessionID,
              ...(chatAttachments().length
                ? {
                    attachments: chatAttachments().map((item) => item.path),
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
            setChatDraft("");
            setChatAttachments([]);
          }
        }}
      />
    </>
  );
}
