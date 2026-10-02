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
  type PagedTranscriptState,
  type TranscriptHandle,
} from "@natalia/ui-kit";
import { Composer, type ComposerAttachment } from "./components/Composer";
import { SessionUsageBar } from "./components/SessionUsageBar";
import { NeuSelect } from "./components/NeuSelect";
import type { Attachment, Message } from "./types";
import { stableRows, type RowSignature } from "./stable-rows";

export function NiaPanel(props: {
  state: AppState;
  runtime?: RuntimeClient;
  sessionID?: string;
  catalog: RuntimeModelCatalogEntry[];
  loadAttachmentUrl?: (attachment: Attachment) => Promise<string>;
  suspendVirtualization?: boolean;
  paging?: PagedTranscriptState;
  onLoadOlder?: () => void;
}) {
  const [draft, setDraft] = createSignal("");
  const [attachments, setAttachments] = createSignal<ComposerAttachment[]>([]);
  const [modelID, setModelID] = createSignal("");
  const [reasoning, setReasoning] = createSignal("medium");
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
            signature: [tool.name, tool.result, tool.summary, tool.status],
            create: () => ({
              id: msg.id,
              role: "assistant",
              content: "",
              toolCalls: [
                {
                  name: tool.name,
                  output: tool.result ?? tool.summary,
                  status: tool.status,
                  summary: tool.summary,
                },
              ],
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
      setReasoning(profile?.normal?.reasoningEffort ?? "medium");
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
        reasoningEffort: (profile?.normal?.reasoningEffort ?? reasoning()) as
          | "minimal"
          | "low"
          | "medium"
          | "high"
          | "xhigh",
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
    <div class="neu-pane nia-flat-pane">
      <div class="neu-pane-header">
        <span class="neu-pane-title">Nia</span>
        <span class="neu-pane-header-actions">
          <ContextMeter usage={props.state.nia.context} compact />
          <span class="neu-pane-status" data-running={Boolean(active())}>
            {active() ? "running" : "idle"}
          </span>
        </span>
      </div>
      <div class="neu-pane-content">
        <div class="nia-transcript-wrap">
          <Transcript
            messages={renderedMessages()}
            emptyTitle="向 Nia 提问"
            emptyHint="Nia 用于审计，只读、不写代码、不写 Plan。"
            assistantName="Nia"
            assistantInitial="N"
            apiRef={(api) => {
              niaApi = api;
            }}
            onFollowChange={(following) => setNiaShowJumpToBottom(!following)}
            onNearTop={() => props.onLoadOlder?.()}
            hasOlder={props.paging?.hasOlder ?? false}
            historyLoading={!props.paging?.initialized}
            olderHistoryLoading={props.paging?.loadingOlder}
            loadAttachmentUrl={props.loadAttachmentUrl}
            suspendVirtualization={props.suspendVirtualization}
          />
          <Show when={niaShowJumpToBottom()}>
            <button
              type="button"
              class="neu-jump-bottom"
              onClick={() => niaApi?.scrollToBottom()}
              title="跳到底部"
            >
              ↓
            </button>
          </Show>
        </div>
        <div class="neu-activity-bar" data-running={Boolean(active())}>
          <span class="neu-activity-pulse" />
          <span class="neu-activity-label">{activityLabel()}</span>
        </div>
        <div class="neu-main-toolbar">
          <NeuSelect
            value={modelID()}
            options={modelOptions()}
            placeholder="Nia 模型"
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
            placeholder="Nia 推理"
            menuPosition="top"
          />
        </div>
        <SessionUsageBar usage={props.state.usageByChannel.nia} />
        <Composer
          value={draft()}
          placeholder="向 Nia 提问…"
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
      </div>
    </div>
  );
}
