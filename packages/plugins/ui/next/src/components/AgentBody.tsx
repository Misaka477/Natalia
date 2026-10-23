/** The one agent body.
 *
 * Every agent in the pane is the same surface: a scrolling transcript
 * with a jump-to-bottom button and the plugin's empty-state entry, over
 * a run bar and an input. When `messages().length === 0`, the body enters
 * the Hero landing phase: the brand headline, the interactive WorkspaceChip
 * selector, and the resident composer stack are centered together in one
 * column, while the composer remains mounted in the same position so the
 * first message transitions from hero to active conversation without
 * remounting the textarea.
 */
import {
  For,
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  type JSX,
} from "solid-js";
import { Transcript, type TranscriptHandle } from "@natalia/ui-kit";
import type { Attachment, Message } from "@natalia/ui-kit";
import type { WorkspaceSummary } from "@anthelia/contracts";
import { SlotMount } from "../slots/mount";
import type { SlotsRegistry } from "../slots/registry";
import styles from "../styles/transcript.module.css";

export interface AgentBodyProps {
  /** The session this body is showing; a change rebuilds the transcript. */
  sessionKey: string;
  messages: () => Message[];
  emptyTitle: string;
  emptyHint: string;
  assistantName: string;
  assistantInitial: string;
  toolCards: any;
  /** The kit handle, for the shell's jump and scroll helpers. */
  onApi: (api: TranscriptHandle | undefined) => void;
  onFollowChange: (following: boolean) => void;
  onScroll?: (event: Event) => void;
  onNearTop?: () => void;
  hasOlder?: boolean;
  historyLoading?: boolean;
  olderHistoryLoading?: boolean;
  loadAttachmentUrl?: (attachment: Attachment) => Promise<string>;
  onFork?: (turnID: string) => void;
  onRollback?: (message: Message) => void;
  checkpointIDForMessage?: (message: Message) => string | undefined;
  suspendVirtualization?: boolean;
  /** Whether the jump-to-bottom button shows, and what it does. */
  jumpVisible: () => boolean;
  onJump: () => void;
  /** Bands above the transcript: the degraded notice, the feedback note. */
  notices?: JSX.Element;
  slots: SlotsRegistry;
  t: (key: string, params?: Record<string, unknown>) => string;
  /** The run bar and the input — the part that differs per agent. */
  children: JSX.Element;
  /** The decision band: a pending approval, question or interactive. */
  decision?: JSX.Element;
  /** Optional workspace list and callbacks for the Hero landing page's WorkspaceChip. */
  workspaces?: () => WorkspaceSummary[];
  activeWorkspaceID?: () => string | undefined;
  onSelectWorkspace?: (workspaceID: string) => void;
  onAddWorkspace?: () => void;
}

export function AgentBody(props: AgentBodyProps) {
  const t = props.t;
  const hero = () => props.messages().length === 0;
  const [pickerOpen, setPickerOpen] = createSignal(false);

  const currentWorkspace = createMemo(() => {
    const list = props.workspaces?.() ?? [];
    const activeID = props.activeWorkspaceID?.();
    if (activeID) {
      const found = list.find((ws) => ws.workspaceID === activeID);
      if (found) return found;
    }
    return list.find((ws) => ws.status === "active") ?? list[0];
  });

  createEffect(() => {
    if (!pickerOpen()) return;
    const close = () => setPickerOpen(false);
    const timer = setTimeout(() => {
      document.addEventListener("click", close);
    }, 0);
    onCleanup(() => {
      clearTimeout(timer);
      document.removeEventListener("click", close);
    });
  });

  const displayWorkspaceTitle = (title: string | undefined) => {
    if (!title) return t("hero.chooseWorkspace");
    return title === "default-workspace" ? t("hero.defaultWorkspace") : title;
  };

  return (
    <div class={styles.agentWrap} data-hero={hero()}>
      {props.notices}
      <Show when={!hero() && props.sessionKey} keyed>
        <div class={styles.agentWrap}>
          <Transcript
            messages={props.messages()}
            emptyTitle={props.emptyTitle}
            emptyHint={props.emptyHint}
            assistantName={props.assistantName}
            assistantInitial={props.assistantInitial}
            toolCards={props.toolCards}
            apiRef={props.onApi}
            onFollowChange={props.onFollowChange}
            onScroll={props.onScroll}
            onNearTop={props.onNearTop}
            hasOlder={props.hasOlder}
            historyLoading={props.historyLoading}
            olderHistoryLoading={props.olderHistoryLoading}
            loadAttachmentUrl={props.loadAttachmentUrl}
            onFork={props.onFork}
            onRollback={props.onRollback}
            checkpointIDForMessage={props.checkpointIDForMessage}
            suspendVirtualization={props.suspendVirtualization}
          />
          <Show when={props.jumpVisible()}>
            <button
              type="button"
              class="neu-jump-bottom"
              onClick={props.onJump}
              title={t("transcript.jumpToBottom")}
            >
              ↓
            </button>
          </Show>
        </div>
      </Show>
      {props.decision}
      <SlotMount slots={props.slots} name="input.dock" t={t} />
      <div class={`${styles.runbar} ${hero() ? styles.composerHero : ""}`}>
        <Show when={hero()}>
          <div class={styles.heroStack}>
            <div class={styles.heroHeadline}>
              <img
                class={styles.heroLogo}
                src="/brand.png"
                alt={props.assistantName}
              />
              <span class={styles.heroTitleGroup}>
                <span>{props.assistantName}</span>
                <span class={styles.heroPreviewBadge}>{t("hero.preview")}</span>
              </span>
            </div>
            <Show when={props.emptyHint}>
              <div class={styles.heroSubtitle}>{props.emptyHint}</div>
            </Show>
            <SlotMount slots={props.slots} name="transcript.empty" t={t} />
            <Show when={props.workspaces}>
              <div
                class={styles.heroWorkspaceRow}
                onClick={(event) => event.stopPropagation()}
              >
                <button
                  type="button"
                  class={styles.workspaceChip}
                  aria-label={t("hero.chooseWorkspace")}
                  aria-haspopup="menu"
                  aria-expanded={pickerOpen()}
                  onClick={() => {
                    if (
                      (props.workspaces?.() ?? []).length === 0 &&
                      props.onAddWorkspace
                    ) {
                      props.onAddWorkspace();
                      return;
                    }
                    setPickerOpen((v) => !v);
                  }}
                >
                  <Show
                    when={currentWorkspace()}
                    fallback={
                      <svg
                        width="16"
                        height="16"
                        viewBox="0 0 16 16"
                        fill="none"
                        stroke="currentColor"
                        stroke-width="1"
                      >
                        <path d="M1.50439 3.11059C1.50439 2.55831 1.95211 2.1106 2.50439 2.1106H5.43389C5.67773 2.1106 5.91318 2.19969 6.09593 2.36113L7.71649 3.79265C7.89924 3.95409 8.1347 4.04319 8.3785 4.04319H13.4958C14.0481 4.04319 14.4958 4.4909 14.4958 5.04319V12.8894C14.4958 13.4417 14.0481 13.8894 13.4958 13.8894H2.50439C1.95211 13.8894 1.50439 13.4417 1.50439 12.8894V4.04319V3.11059Z" />
                        <path d="M3.63501 7.66614H12.3647" />
                      </svg>
                    }
                  >
                    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
                      <path
                        d="M2.55912 7.93683C2.67584 7.49906 3.0723 7.19446 3.52536 7.19446H13.6491C14.3061 7.19446 14.7846 7.81725 14.6153 8.45209L13.4411 12.856C13.3244 13.2938 12.9279 13.5984 12.4748 13.5984H2.35113C1.69411 13.5984 1.21562 12.9756 1.38489 12.3407L2.55912 7.93683Z"
                        fill="currentColor"
                        opacity="0.16"
                      />
                      <path
                        d="M13.6491 6.69446C14.6346 6.69453 15.3522 7.62895 15.0983 8.58118L13.9245 12.9845C13.7494 13.6412 13.1539 14.0988 12.4743 14.0988H2.35126C1.36574 14.0988 0.648153 13.1643 0.902044 12.212L2.07587 7.80774C2.25102 7.15128 2.84567 6.69455 3.52509 6.69446H13.6491ZM3.52509 7.69446C3.29865 7.69455 3.10004 7.84674 3.04169 8.06555L1.86786 12.4698C1.78345 12.7872 2.02285 13.0988 2.35126 13.0988H12.4743C12.7007 13.0988 12.8992 12.9463 12.9577 12.7277L14.1325 8.32336C14.2171 8.00598 13.9776 7.69453 13.6491 7.69446H3.52509Z"
                        fill="currentColor"
                      />
                      <path
                        d="M4.7666 1.90137C5.13227 1.90144 5.48571 2.03525 5.75977 2.27734L7.27246 3.61328C7.36379 3.69382 7.48174 3.73828 7.60352 3.73828H12.3994C13.2276 3.73841 13.8993 4.41005 13.8994 5.23828V6.7168C13.8183 6.70327 13.735 6.69436 13.6494 6.69434H12.8994V5.23828C12.8993 4.96233 12.6754 4.73841 12.3994 4.73828H7.60352C7.23781 4.73828 6.88446 4.60438 6.61035 4.3623L5.09766 3.02637C5.00636 2.94576 4.88838 2.90144 4.7666 2.90137H2.0498C1.77366 2.90137 1.5498 3.12523 1.5498 3.40137V9.78223L0.902344 12.2119C0.648452 13.1642 1.36604 14.0986 2.35156 14.0986H2.0498C1.2214 14.0986 0.549838 13.427 0.549805 12.5986V3.40137C0.549805 2.57294 1.22138 1.90137 2.0498 1.90137H4.7666Z"
                        fill="currentColor"
                      />
                    </svg>
                  </Show>
                  <span class={styles.workspaceChipLabel}>
                    {displayWorkspaceTitle(currentWorkspace()?.title)}
                  </span>
                  <svg
                    width="12"
                    height="12"
                    viewBox="0 0 16 16"
                    fill="none"
                    stroke="currentColor"
                    stroke-width="1.3"
                  >
                    <path d="M4 6L7.29289 9.29289C7.68342 9.68342 8.31658 9.68342 8.70711 9.29289L12 6" />
                  </svg>
                </button>
                <Show when={pickerOpen()}>
                  <div class={styles.workspaceChipMenu}>
                    <For each={props.workspaces?.() ?? []}>
                      {(ws) => (
                        <button
                          type="button"
                          class={styles.workspaceChipMenuItem}
                          data-active={
                            ws.workspaceID === currentWorkspace()?.workspaceID
                          }
                          onClick={() => {
                            setPickerOpen(false);
                            props.onSelectWorkspace?.(ws.workspaceID);
                          }}
                        >
                          <span>{displayWorkspaceTitle(ws.title)}</span>
                        </button>
                      )}
                    </For>
                    <Show when={props.onAddWorkspace}>
                      <button
                        type="button"
                        class={styles.workspaceChipMenuItem}
                        onClick={() => {
                          setPickerOpen(false);
                          props.onAddWorkspace?.();
                        }}
                      >
                        <span>+ {t("hero.addWorkspace")}</span>
                      </button>
                    </Show>
                  </div>
                </Show>
              </div>
            </Show>
          </div>
        </Show>
        {props.children}
      </div>
    </div>
  );
}
