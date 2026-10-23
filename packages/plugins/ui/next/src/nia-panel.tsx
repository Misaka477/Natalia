import styles from "./styles/nia-panel.module.css";
import {
  Show,
  createEffect,
  createMemo,
  createSignal,
  onCleanup,
  onMount,
} from "solid-js";
import type {
  RuntimeClient,
  RuntimeModelCatalogEntry,
} from "@anthelia/contracts";
import { type AppState } from "@natalia/view-store";
import {
  ContextMeter,
  Transcript,
  toolCallRow,
  type PagedTranscriptState,
  type TranscriptHandle,
} from "@natalia/ui-kit";
import { Composer, type ComposerAttachment } from "./components/Composer";
import { SessionUsageBar } from "./components/SessionUsageBar";
import { NeuSelect } from "./components/NeuSelect";
import { AgentBody } from "./components/AgentBody";
import type { Attachment, Message } from "./types";
import { stableRows, type RowSignature } from "./stable-rows";

export function NiaPanel(props: {
  t: (key: string, params?: Record<string, unknown>) => string;
  state: AppState;
  runtime?: RuntimeClient;
  sessionID?: string;
  catalog: RuntimeModelCatalogEntry[];
  loadAttachmentUrl?: (attachment: Attachment) => Promise<string>;
  suspendVirtualization?: boolean;
  paging?: PagedTranscriptState;
  onLoadOlder?: () => void;
  /**
   * Where a click on the model control goes when there is no model to choose.
   *
   * The shell owns the settings signal; this panel only needs somewhere to
   * send a user who has nothing in the picker. Left unset, the control keeps
   * opening its own menu.
   */
  onOpenSettings?: () => void;
  /** The shell's tool-card registry, so the transcript renders the same
   *  cards every other agent's does. */
  toolCards?: unknown;
  /** The shell's slot registry, for the transcript's plugin entry. */
  slots?: any;
  /** Rendered inside the main pane rather than as a rail tab. Kept for
   *  the call sites that still pass it; the body no longer has a header
   *  to suppress. */
  embedded?: boolean;
}) {
  const t = props.t;
  const [draft, setDraft] = createSignal("");
  const [attachments, setAttachments] = createSignal<ComposerAttachment[]>([]);
  const [modelID, setModelID] = createSignal("");
  // Empty until the runtime says otherwise: the effort has no schema default,
  // so a pre-filled "medium" displayed a choice nobody made. The select's own
  // placeholder shows the truth.
  const [reasoning, setReasoning] = createSignal("");
  const [busy, setBusy] = createSignal(false);
  const [elapsedMs, setElapsedMs] = createSignal(0);
  let niaApi: TranscriptHandle | undefined;
  const [niaShowJumpToBottom, setNiaShowJumpToBottom] = createSignal(false);
  let profileLoadToken = 0;

  function formatDuration(ms: number): string {
    if (ms < 1000) return `${ms}ms`;
    const totalSeconds = Math.floor(ms / 1000);
    const minutes = Math.floor(totalSeconds / 60);
    const seconds = totalSeconds % 60;
    if (minutes < 1) return `${seconds}s`;
    return `${minutes}m ${seconds}s`;
  }

  const niaMessageCache = new Map<
    string,
    { signature: RowSignature; value: Message }
  >();

  const messages = createMemo<Message[]>(() => {
    const list = props.state.nia.messages;
    const activity = Boolean(props.state.nia.activity);
    const lastIndex = list.length - 1;
    return stableRows(
      niaMessageCache,
      list.map((msg, idx) => {
        const isLast = idx === lastIndex;
        const tool = msg.tool;
        if (tool) {
          return {
            id: msg.id,
            signature: [
              tool.name,
              tool.result,
              tool.summary,
              tool.status,
              // The arguments stream in fragments; a row cached mid-stream
              // would pin a ToolCall without parsed arguments forever.
              tool.argumentsRaw,
              // The card and its structured facts are what the row RENDERS
              // (R0), and the legacy metadata blob is the replay fallback
              // the decode reads: every field the derivation depends on
              // belongs in the row's identity.
              tool.card,
              tool.meta,
              tool.metadata,
            ],
            create: () => ({
              id: msg.id,
              role: "assistant",
              content: "",
              toolCalls: [toolCallRow(tool)],
            }),
          };
        }
        const role =
          msg.role === "user" ? ("user" as const) : ("assistant" as const);
        const content = msg.text + (msg.pendingText ?? "");
        const streaming = Boolean(activity && isLast && msg.role !== "user");
        const attachments =
          msg.role === "user" && msg.attachments?.length
            ? msg.attachments
            : undefined;
        return {
          id: msg.id,
          signature: [
            role,
            msg.role,
            msg.text,
            msg.pendingText ?? "",
            msg.reasoningVisible,
            content,
            attachments,
            streaming,
            isLast,
            activity,
          ],
          create: () => ({
            id: msg.id,
            role,
            thinking: msg.role === "thinking" && msg.reasoningVisible !== false,
            ...(attachments
              ? {
                  attachments: attachments.map((attachment) => ({
                    id: attachment.id,
                    path: attachment.path,
                    name: attachment.filename,
                    mediaType: attachment.mediaType,
                    ...(attachment.width ? { width: attachment.width } : {}),
                    ...(attachment.height ? { height: attachment.height } : {}),
                  })),
                }
              : {}),
            content,
            streaming,
          }),
        };
      }),
    );
  });

  const renderedMessages = createMemo<Message[]>(() => messages());

  const modelOptions = () =>
    props.catalog.map((entry) => ({
      value: entry.id,
      label: entry.id,
    }));

  onMount(() => {
    void loadProfile();
  });

  createEffect(() => {
    void loadProfile();
  });

  async function loadProfile() {
    const token = ++profileLoadToken;
    const requestedSessionID = props.sessionID;
    try {
      const profile =
        await props.runtime?.niaChat?.modelProfile?.(requestedSessionID);
      if (token !== profileLoadToken || requestedSessionID !== props.sessionID)
        return;
      setModelID(profile?.normal?.modelID ?? "");
      setReasoning(profile?.normal?.reasoningEffort ?? "");
    } catch {
      // Profile may be unavailable until the runtime is fully ready.
    }
  }

  async function saveProfile(patch: {
    modelID?: string;
    reasoningEffort?: "minimal" | "low" | "medium" | "high" | "xhigh";
  }) {
    const current = await props.runtime?.niaChat
      ?.modelProfile?.(props.sessionID)
      .catch(() => undefined);
    await props.runtime?.niaChat?.setModelProfile?.(
      {
        ...(current ?? {}),
        normal: {
          ...(current?.normal ?? {}),
          ...(patch.modelID !== undefined ? { modelID: patch.modelID } : {}),
          ...(patch.reasoningEffort !== undefined
            ? { reasoningEffort: patch.reasoningEffort }
            : {}),
        },
      },
      props.sessionID,
    );
  }

  function handlePaste(event: ClipboardEvent) {
    const files = Array.from(event.clipboardData?.items ?? [])
      .filter((item) => item.kind === "file")
      .map((item) => item.getAsFile())
      .filter((file): file is File => file !== null);
    if (!files.length) return;
    event.preventDefault();
    for (const file of files) {
      const reader = new FileReader();
      reader.onload = () => {
        const dataUrl = String(reader.result ?? "");
        const base64 = dataUrl.split(",")[1];
        if (!base64) return;
        void props.runtime
          ?.uploadAttachment?.({
            name: file.name || "attachment",
            mediaType: file.type || "application/octet-stream",
            data: base64,
          })
          .then((attachment) => {
            setAttachments([
              ...attachments(),
              {
                path: attachment.path,
                name: attachment.filename,
                ...(file.type.startsWith("image/")
                  ? { previewUrl: dataUrl }
                  : {}),
              },
            ]);
          })
          .catch((cause) =>
            console.error("[nia-ui] attachment upload failed", cause),
          );
      };
      reader.readAsDataURL(file);
    }
  }

  async function submit() {
    const text = draft();
    const pendingAttachments = attachments();
    if ((!text.trim() && !pendingAttachments.length) || busy()) return;
    setBusy(true);
    // Match the Navi composer: clear immediately on send, not after the whole
    // chat turn finishes.
    setDraft("");
    setAttachments([]);
    try {
      const profile = await props.runtime?.niaChat?.modelProfile?.(
        props.sessionID,
      );
      await props.runtime?.niaChat?.submit?.({
        text,
        sessionID: props.sessionID,
        ...(pendingAttachments.length
          ? { attachments: pendingAttachments.map((item) => item.path) }
          : {}),
        ...(profile?.normal?.modelID
          ? {
              model: {
                modelID: profile.normal.modelID,
                ...(profile.normal.variant
                  ? { variant: profile.normal.variant }
                  : {}),
              },
            }
          : {}),
        // Only a real effort is sent: the field is a five-value union with no
        // default, so an unset control must not be saved as an invented value
        // (an empty string would fail the provider's own validation).
        ...((profile?.normal?.reasoningEffort ?? reasoning())
          ? {
              reasoningEffort: (profile?.normal?.reasoningEffort ??
                reasoning()) as "minimal" | "low" | "medium" | "high" | "xhigh",
            }
          : {}),
        ...(props.sessionID ? { sessionID: props.sessionID } : {}),
      });
    } catch (cause) {
      console.error("[nia-ui] submit failed", cause);
    } finally {
      setBusy(false);
    }
  }

  const active = () => props.state.nia.activity;

  createEffect(() => {
    const activity = active();
    if (!activity?.startedAt) {
      setElapsedMs(0);
      return;
    }
    const startedAt = activity.startedAt;
    const update = () => setElapsedMs(Date.now() - startedAt);
    update();
    const timer = setInterval(update, 1000);
    onCleanup(() => clearInterval(timer));
  });

  const activityLabel = () => {
    const activity = active();
    if (!activity) return "idle";
    const phase =
      activity.phase === "using_tool"
        ? activity.toolName
          ? `Using ${activity.toolName}`
          : "Using a tool"
        : activity.phase === "thinking"
          ? "Thinking"
          : activity.phase === "generating"
            ? "Generating"
            : "Waiting";
    return `${phase} · ${formatDuration(elapsedMs())}`;
  };

  return (
    <AgentBody
      sessionKey={props.sessionID ?? "none"}
      messages={renderedMessages}
      emptyTitle={t("nia.emptyTitle")}
      emptyHint={t("nia.emptyHint")}
      assistantName="Nia"
      assistantInitial="N"
      toolCards={props.toolCards}
      onApi={(api) => {
        niaApi = api;
      }}
      onFollowChange={(following) => setNiaShowJumpToBottom(!following)}
      onNearTop={() => props.onLoadOlder?.()}
      hasOlder={props.paging?.hasOlder ?? false}
      historyLoading={!props.paging?.initialized}
      olderHistoryLoading={props.paging?.loadingOlder}
      loadAttachmentUrl={props.loadAttachmentUrl}
      suspendVirtualization={props.suspendVirtualization}
      jumpVisible={niaShowJumpToBottom}
      onJump={() => niaApi?.scrollToBottom()}
      slots={props.slots}
      t={t}
    >
      <div class="neu-activity-bar" data-running={Boolean(active())}>
        <span class="neu-activity-pulse" />
        <span class="neu-activity-label">{activityLabel()}</span>
      </div>
      <div class="neu-main-toolbar">
        <NeuSelect
          value={modelID()}
          options={modelOptions()}
          // No model configured: this click opens the model settings
          // instead of an empty menu. The control is unchanged either way.
          onActivate={
            modelOptions().length > 0
              ? undefined
              : () => props.onOpenSettings?.()
          }
          placeholder={t("nia.model")}
          onChange={(next) => {
            setModelID(next);
            void saveProfile({ modelID: next });
          }}
          menuPosition="top"
        />
        <NeuSelect
          value={reasoning()}
          options={[
            { value: "minimal", label: "minimal" },
            { value: "low", label: "low" },
            { value: "medium", label: "medium" },
            { value: "high", label: "high" },
            { value: "xhigh", label: "xhigh" },
          ]}
          onChange={(next) => {
            setReasoning(next);
            void saveProfile({
              reasoningEffort: next as
                | "minimal"
                | "low"
                | "medium"
                | "high"
                | "xhigh",
            });
          }}
          placeholder={t("nia.reasoning")}
          menuPosition="top"
        />
      </div>
      <SessionUsageBar t={props.t} usage={props.state.usageByChannel.nia} />
      <Composer
        t={props.t}
        value={draft()}
        placeholder={t("nia.chatPlaceholder")}
        busy={Boolean(active()) || busy()}
        onInput={setDraft}
        onStop={() => void props.runtime?.niaChat?.abort?.(props.sessionID)}
        attachments={attachments()}
        onRemoveAttachment={(path) =>
          setAttachments(attachments().filter((item) => item.path !== path))
        }
        onPaste={handlePaste}
        onSubmit={() => void submit()}
      />
    </AgentBody>
  );
}
