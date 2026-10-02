import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
} from "solid-js";
import { render } from "solid-js/web";
import type { ApprovalResponse, QuestionResponse } from "@anthelia/contracts";
import {
  defineUiPlugin,
  type UiPlugin,
  type UiPluginContext,
} from "@natalia/ui-host";
import {
  approvalPresenter,
  normalizePendingItems,
  questionPresenter,
  type PendingItem,
  type PendingPresenter,
} from "@natalia/ui-model";
import { PendingBadge, PendingPanel } from "@natalia/ui-kit";
import { pendingInboxStyles } from "./styles";

function PendingInbox(props: { ctx: UiPluginContext }) {
  const [revision, setRevision] = createSignal(0);
  const bump = () => setRevision((value) => value + 1);
  // Re-render on projection frames and on shared selection changes.
  const offProjection = props.ctx.projection.subscribe(bump);
  const offPanels = props.ctx.host?.subscribePanels(bump);
  onCleanup(() => {
    offProjection();
    offPanels?.();
  });

  const items = createMemo<PendingItem[]>(() => {
    revision();
    const state = props.ctx.projection.getState();
    return normalizePendingItems({
      approvals: state.pendingApprovals,
      questions: state.pendingQuestions,
      interactives: state.pendingInteractives,
    });
  });

  // Forget dismissed/active ids whose request is no longer pending.
  createEffect(() => {
    props.ctx.pending.controller.prune(new Set(items().map((item) => item.id)));
  });

  const presenterFor = (kind: string): PendingPresenter | undefined =>
    props.ctx.pending.presenters().get(kind);

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
    props.ctx.pending.controller.dismiss(item.id);
  }

  return (
    <Show when={items().length} fallback={<EmptyInbox />}>
      <PendingPanel
        items={items()}
        controller={props.ctx.pending.controller}
        presenterFor={presenterFor}
        onRespond={respond}
      />
    </Show>
  );
}

function EmptyInbox() {
  return <div class="natalia-pending-empty">没有待处理事项</div>;
}

/** Count only; the shell renders it on the side tab. */
export function PendingInboxBadge(props: { ctx: UiPluginContext }) {
  const [revision, setRevision] = createSignal(0);
  const bump = () => setRevision((value) => value + 1);
  const offProjection = props.ctx.projection.subscribe(bump);
  onCleanup(offProjection);
  const count = createMemo(() => {
    revision();
    const state = props.ctx.projection.getState();
    return (
      state.pendingApprovals.length +
      state.pendingQuestions.length +
      state.pendingInteractives.length
    );
  });
  return <PendingBadge count={count()} />;
}

function ensurePendingStyles() {
  if (document.querySelector("style[data-natalia-pending]")) return;
  const style = document.createElement("style");
  style.setAttribute("data-natalia-pending", "true");
  style.textContent = pendingInboxStyles;
  document.head.append(style);
}

export function createPendingUiPlugin(): UiPlugin {
  return defineUiPlugin({
    id: "natalia.ui.pending-inbox",
    name: "Pending Inbox",
    version: "1.0.0",
    description: "Approvals and questions in one side panel.",
    panels: [
      {
        id: "pending",
        title: "待处理",
        region: "side",
        mount(ctx, container) {
          container.replaceChildren();
          const disposeRender = render(
            () => <PendingInbox ctx={ctx} />,
            container,
          );
          return () => disposeRender();
        },
      },
    ],
    mount(ctx) {
      // The shell renders the tab badge before the panel is ever mounted, so
      // the stylesheet must be present as soon as the plugin loads.
      ensurePendingStyles();
      // Registering here (once per plugin load) instead of in panel.mount keeps
      // a panel remount from churning the presenter registry.
      const disposers = [
        ctx.pending.registerPresenter(approvalPresenter),
        ctx.pending.registerPresenter(questionPresenter),
      ];
      return {
        dispose() {
          for (const disposer of disposers) disposer();
        },
      };
    },
  });
}

export default createPendingUiPlugin();
