import { Show, createMemo, createSignal } from "solid-js";
import type { ApprovalResponse, QuestionResponse } from "@anthelia/contracts";
import {
  approvalPresenter,
  normalizePendingItems,
  questionPresenter,
  type PendingItem,
  type PendingPresenter,
} from "@natalia/ui-model";
import { PendingDetail } from "@natalia/ui-kit";
import type { UiPluginContext } from "@natalia/ui-host";

/**
 * The composer takeover (R4(a)(c)).
 *
 * A pending approval, question or interactive request is the runtime asking
 * the human something, and the agent is BLOCKED on the answer — so the
 * request belongs where the human types, not in a side tab they have to
 * think to check. While a request is pending the card replaces the composer:
 * the decision cannot be missed, and the input is naturally unavailable
 * while it is open.
 *
 * The two properties that make this honest rather than a modal:
 *
 *   - **Non-modal.** No backdrop, no focus trap, no role=dialog: the
 *     transcript, the side panels and the other sessions all stay usable
 *     while a request waits. The human can go read the file the approval
 *     names and come back to it.
 *   - **Dismiss minimizes, it never vanishes.** Closing the card leaves a
 *     persistent strip with the live count, so "out of sight" cannot become
 *     "forgotten": the badge is there until the request is answered.
 *
 * Keyed by request id (keyed on the active id), so every request mounts
 * fresh — a one-shot answer latch cannot leak from one request to the next,
 * and a second request never renders inside the first's disposed tree.
 */
export function PendingTakeover(props: {
  ctx: UiPluginContext;
  /** Lifted so the shell can render the composer again while minimized. */
  minimized: () => boolean;
  onMinimize: (value: boolean) => void;
  /** A request id the shell wants selected (the transcript's 处理 button). */
  focusID: () => string | undefined;
  onFocusHandled: () => void;
}) {
  const minimized = props.minimized;
  const setMinimized = props.onMinimize;
  const [focusedID, setFocusedID] = createSignal<string | undefined>(undefined);
  const items = createMemo<PendingItem[]>(() => {
    const state = props.ctx.projection.getState();
    return normalizePendingItems({
      approvals: state.pendingApprovals,
      questions: state.pendingQuestions,
      interactives: state.pendingInteractives,
    });
  });
  const count = createMemo(() => items().length);
  // An external focus request wins once, then clears: the transcript's
  // 处理 button asks for a specific request, and a stale id must not keep
  // selecting a request that has since been answered.
  const externalFocus = props.focusID();
  if (externalFocus && items().some((item) => item.id === externalFocus)) {
    if (focusedID() !== externalFocus) setFocusedID(externalFocus);
    props.onFocusHandled();
  }
  const activeID = createMemo(() => {
    const focused = focusedID();
    if (focused && items().some((item) => item.id === focused)) return focused;
    return props.ctx.pending.controller.activeID() ?? items()[0]?.id;
  });
  const presenterFor = (kind: string): PendingPresenter | undefined => {
    const presenters = props.ctx.pending.presenters();
    return (
      presenters.get(kind) ??
      (kind === "approval"
        ? (approvalPresenter as PendingPresenter)
        : kind === "question"
          ? (questionPresenter as PendingPresenter)
          : undefined)
    );
  };

  function respond(item: PendingItem, response: unknown) {
    const sessionID = props.ctx.projection.getState().sessionID;
    const payload = {
      ...(response as Record<string, unknown>),
      ...(sessionID ? { sessionID } : {}),
    };
    if (item.kind === "approval")
      void props.ctx.runtime.respondApproval?.(payload as ApprovalResponse);
    else if (item.kind === "question")
      void props.ctx.runtime.respondQuestion?.(payload as QuestionResponse);
    else
      void props.ctx.runtime.respondInteractive?.({
        requestID: item.id,
        kind: item.kind,
        response: response as import("@anthelia/contracts").JsonValue,
        ...(sessionID ? { sessionID } : {}),
      });
    // The answer is on its way; the echo removes the item from the
    // projection. Drop the local focus so a late re-render cannot keep an
    // answered request selected.
    if (focusedID() === item.id) setFocusedID(undefined);
  }

  return (
    <Show when={count() > 0}>
      <Show
        when={!minimized()}
        fallback={
          <div class="natalia-pending-takeover-min" data-testid="pending-min">
            <span class="natalia-pending-takeover-min-count">
              {count()} 个待处理
            </span>
            <button
              type="button"
              class="natalia-pending-takeover-min-expand"
              onClick={() => setMinimized(false)}
            >
              展开
            </button>
          </div>
        }
      >
        <div class="natalia-pending-takeover" data-testid="pending-takeover">
          <div class="natalia-pending-takeover-head">
            <span class="natalia-pending-takeover-title">
              等待你的决定（{count()}）
            </span>
            <button
              type="button"
              class="natalia-pending-takeover-minimize"
              onClick={() => setMinimized(true)}
            >
              最小化
            </button>
          </div>
          <Show
            when={items().length > 1}
            fallback={
              <p class="natalia-pending-takeover-hint">
                回答后 agent 自动继续；最小化不会让它消失，徽标会留着。
              </p>
            }
          >
            <ul class="natalia-pending-takeover-list">
              {items().map((item) => (
                <li>
                  <button
                    type="button"
                    class="natalia-pending-takeover-row"
                    data-active={item.id === activeID()}
                    onClick={() => setFocusedID(item.id)}
                  >
                    <span class="natalia-pending-row-kind">{item.kind}</span>
                    <span class="natalia-pending-row-title">{item.title}</span>
                  </button>
                </li>
              ))}
            </ul>
          </Show>
          <Show
            keyed
            when={activeID()}
            fallback={<div class="natalia-pending-empty">没有待处理事项</div>}
          >
            {(id) => {
              const item = () => items().find((entry) => entry.id === id);
              return (
                <Show when={item()}>
                  {(current) => (
                    <Show when={presenterFor(current().kind)}>
                      {(presenter) => (
                        <PendingDetail
                          item={current()}
                          presenter={presenter()}
                          onRespond={(response) => respond(current(), response)}
                          onDismiss={() => setMinimized(true)}
                        />
                      )}
                    </Show>
                  )}
                </Show>
              );
            }}
          </Show>
        </div>
      </Show>
    </Show>
  );
}
