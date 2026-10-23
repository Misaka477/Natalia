/** The one agent body.
 *
 * Every agent in the pane is the same surface: a scrolling transcript
 * with a jump-to-bottom button and the plugin's empty-state entry, over
 * a run bar and an input. The agents differ in the DATA — which
 * messages, which empty copy, which controls the run bar carries, which
 * runtime the composer submits to — and in nothing else.
 *
 * That was not always true here. Natalia, Navi and Nia each had their
 * own copy of this markup: Natalia's inline in the transcript
 * controller, Navi's a near-copy beside it, and Nia's a third
 * implementation in its own panel file that wrapped itself in a second
 * `neu-pane` and put its run bar and composer outside the pane. Three
 * copies drifted three ways — Navi lost its empty state, Nia's controls
 * landed outside the card — and the reader got three different layouts
 * for one surface.
 *
 * So the body is written once. An agent passes its transcript, its
 * notices, its jump state, and the run bar and input it needs — the
 * run bar and the input are part of the shared surface, and only the
 * controls inside them differ per agent.
 */
import { Show, type JSX } from "solid-js";
import { Transcript, type TranscriptHandle } from "@natalia/ui-kit";
import type { Attachment, Message } from "@natalia/ui-kit";
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
  /** The decision band: a pending approval, question or interactive. It
   *  belongs to the pane rather than to an agent — it blocks the run
   *  whoever is focused — so every body renders the same one, in the
   *  same place: above the run bar, between the transcript and the
   *  input. */
  decision?: JSX.Element;
}

export function AgentBody(props: AgentBodyProps) {
  const t = props.t;
  return (
    <div class={styles.agentWrap}>
      <Show when={props.sessionKey} keyed>
        {props.notices}
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
          {/* A plugin's own entry beside an empty transcript, under the
              shell's empty state. */}
          <SlotMount slots={props.slots} name="transcript.empty" t={t} />
        </div>
      </Show>
      {props.decision}
      {/* The input dock: full-width entries above the composer card. It
          belongs to the body rather than to one agent's input area,
          because a plugin's entry — the todo list, anything else that
          rides along with the message — is there whichever agent the
          pane is talking to. */}
      <SlotMount slots={props.slots} name="input.dock" t={t} />
      {/* The run bar and the input, in the band the pane owns. Every agent
          gets the same band — that is the whole point: the band is what
          gives the transcript its height, and a body without it pushes
          the empty state to the top of the pane. */}
      <div class={styles.runbar}>{props.children}</div>
    </div>
  );
}
