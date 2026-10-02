import type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResponse,
  QuestionItem,
  QuestionOption,
  QuestionRequest,
  QuestionResponse,
} from "@anthelia/contracts";

export type {
  ApprovalDecision,
  ApprovalRequest,
  ApprovalResponse,
  QuestionItem,
  QuestionOption,
  QuestionRequest,
  QuestionResponse,
};

// ---------------------------------------------------------------------------
// Pending interactive items (approval / question / future kinds)
// ---------------------------------------------------------------------------

export type PendingKind = "approval" | "question" | (string & {});

export type PendingToolLink = {
  turnID: string;
  callID: string;
  messageID: string;
};

export type PendingItem = {
  id: string;
  kind: PendingKind;
  title: string;
  summary?: string;
  priority: number;
  sequence: number;
  request: ApprovalRequest | QuestionRequest | Record<string, unknown>;
  /** Transcript tool card this request belongs to, when derivable. */
  tool?: PendingToolLink;
  expiresAt?: number;
};

/** A request as projected from the runtime event stream. */
export type PendingApprovalSource = ApprovalRequest;
export type PendingQuestionSource = {
  id: string;
  title: string;
  questions?: QuestionItem[];
  options?: string[];
};

/**
 * Best-effort link from a request id back to its transcript tool card.
 * An approval id is `${turnID}:${callID}`; a question id adds `:question`.
 * Only `turn_*` ids are claimed, so plan-acceptance ids are left alone.
 */
export function pendingToolLink(id: string): PendingToolLink | undefined {
  const base = id.endsWith(":question") ? id.slice(0, -":question".length) : id;
  const sep = base.lastIndexOf(":");
  if (sep <= 0 || sep === base.length - 1) return undefined;
  const turnID = base.slice(0, sep);
  const callID = base.slice(sep + 1);
  if (!turnID.startsWith("turn_")) return undefined;
  return { turnID, callID, messageID: `${turnID}:tool:${callID}` };
}

/**
 * Structural shape of a generic `interactive.request`. Kept local so ui-model
 * stays free of a package dependency on the runtime contracts.
 */
export type PendingInteractiveSource = {
  id: string;
  kind: string;
  title: string;
  payload: unknown;
  responseSchema?: unknown;
  expiresAt?: string;
  priority?: number;
};

export function normalizePendingItems(input: {
  approvals?: readonly PendingApprovalSource[];
  questions?: readonly PendingQuestionSource[];
  interactives?: readonly PendingInteractiveSource[];
}): PendingItem[] {
  const items: PendingItem[] = [];
  let sequence = 0;
  for (const approval of input.approvals ?? []) {
    sequence += 1;
    const tool = pendingToolLink(approval.id);
    const expiresAt =
      approval.expiresAt === undefined
        ? undefined
        : Date.parse(approval.expiresAt);
    items.push({
      id: approval.id,
      kind: "approval",
      title: approval.title,
      summary: approval.preview,
      priority: 10,
      sequence,
      request: approval,
      ...(tool ? { tool } : {}),
      ...(expiresAt !== undefined && Number.isFinite(expiresAt)
        ? { expiresAt }
        : {}),
    });
  }
  for (const question of input.questions ?? []) {
    sequence += 1;
    const tool = pendingToolLink(question.id);
    items.push({
      id: question.id,
      kind: "question",
      title: question.title,
      priority: 20,
      sequence,
      request: question,
      ...(tool ? { tool } : {}),
    });
  }
  for (const interactive of input.interactives ?? []) {
    sequence += 1;
    const expiresAt =
      interactive.expiresAt === undefined
        ? undefined
        : Date.parse(interactive.expiresAt);
    items.push({
      id: interactive.id,
      // The wire `kind` *is* the presenter kind; no legacy shim in between.
      kind: interactive.kind,
      title: interactive.title,
      priority: interactive.priority ?? 30,
      sequence,
      request: interactive,
      ...(expiresAt !== undefined && Number.isFinite(expiresAt)
        ? { expiresAt }
        : {}),
    });
  }
  return items.sort((left, right) => {
    const priority = left.priority - right.priority;
    return priority !== 0 ? priority : left.sequence - right.sequence;
  });
}

// ---------------------------------------------------------------------------
// Presenter protocol (pure data, no JSX — any UI can render it)
// ---------------------------------------------------------------------------

export type PendingField = {
  label: string;
  value: string;
  kind?: "text" | "pre" | "list";
};

export type PendingAction = {
  id: string;
  label: string;
  tone?: "default" | "primary" | "danger";
  requiresInput?: boolean;
};

export type PendingControl =
  | {
      kind: "options";
      label: string;
      /** Draft field the selected labels are written to. */
      field: string;
      /** Position inside an array draft field, when the control is per-question. */
      index?: number;
      multiple?: boolean;
      options: QuestionOption[];
    }
  | {
      kind: "text";
      label: string;
      field: string;
      index?: number;
      placeholder?: string;
    };

export type PendingDraft = Record<string, unknown>;

export type PendingPresenter<Response = unknown> = {
  kind: PendingKind;
  label(item: PendingItem): string;
  fields(item: PendingItem): PendingField[];
  actions(item: PendingItem): PendingAction[];
  controls(item: PendingItem): PendingControl[];
  validate?(item: PendingItem, draft: PendingDraft): string[];
  buildResponse(item: PendingItem, draft: PendingDraft): Response;
};

export const approvalPresenter: PendingPresenter<ApprovalResponse> = {
  kind: "approval",
  label: (item) => item.title,
  fields: (item) => {
    const request = item.request as ApprovalRequest;
    const fields: PendingField[] = [
      { label: "预览", value: request.preview ?? "", kind: "pre" },
    ];
    if (request.detail) fields.push({ label: "详情", value: request.detail });
    if (request.keyArguments?.length)
      fields.push({
        label: "参数",
        value: request.keyArguments.join("\n"),
        kind: "list",
      });
    if (request.risk) fields.push({ label: "风险", value: request.risk });
    if (item.expiresAt !== undefined)
      fields.push({
        label: "过期",
        value: new Date(item.expiresAt).toLocaleTimeString(),
      });
    return fields;
  },
  controls: () => [
    {
      kind: "text",
      label: "拒绝原因（可选）",
      field: "feedback",
      placeholder: "可选",
    },
  ],
  actions: (item) => {
    const request = item.request as ApprovalRequest;
    return [
      { id: "allow-once", label: "允许一次", tone: "primary" },
      ...(request.allowSession === false
        ? []
        : [{ id: "allow-session", label: "允许本次会话" }]),
      // The project tier (the CU fit study's ask): a standing grant for
      // the whole project. A forced approval (git writes, safety rules)
      // carries allowProject:false — never offer what the runtime would
      // refuse to record anyway.
      ...(request.allowProject === false
        ? []
        : [{ id: "allow-project", label: "总是允许在本项目" }]),
      { id: "reject", label: "拒绝", tone: "danger", requiresInput: true },
    ];
  },
  buildResponse: (item, draft) => {
    const action = String(draft.action ?? "reject");
    const decision: ApprovalDecision =
      action === "allow-once"
        ? "once"
        : action === "allow-session"
          ? "session"
          : action === "allow-project"
            ? "project"
            : "reject";
    const feedback =
      typeof draft.feedback === "string" && draft.feedback.trim()
        ? draft.feedback.trim()
        : undefined;
    return {
      requestID: item.id,
      decision,
      ...(feedback ? { feedback } : {}),
    };
  },
};

export type QuestionDraft = {
  /** Selected option labels per question. */
  selections?: string[][];
  /** Free-form text per question. */
  custom?: string[];
  rejected?: boolean;
};

export const questionPresenter: PendingPresenter<QuestionResponse> = {
  kind: "question",
  label: (item) => item.title,
  fields: (item) =>
    normalizeQuestionRequest(item).questions.map((question) => ({
      label: question.header || "问题",
      value: [
        question.question,
        ...question.options.map((option) =>
          option.description
            ? `• ${option.label} — ${option.description}`
            : `• ${option.label}`,
        ),
      ].join("\n"),
    })),
  controls: (item) =>
    normalizeQuestionRequest(item).questions.flatMap((question, index) => {
      const controls: PendingControl[] = [
        {
          kind: "options",
          label: question.header || `问题 ${index + 1}`,
          field: "selections",
          index,
          multiple: question.multiple,
          options: question.options,
        },
      ];
      if (question.custom)
        controls.push({
          kind: "text",
          label: "自定义回答",
          field: "custom",
          index,
          placeholder: "输入自定义回答",
        });
      return controls;
    }),
  actions: () => [
    { id: "submit", label: "提交回答", tone: "primary" },
    { id: "reject", label: "拒绝", tone: "danger" },
  ],
  buildResponse: (item, draft) => {
    const questionDraft = draft as QuestionDraft;
    if (questionDraft.rejected)
      return { requestID: item.id, answers: [], rejected: true };
    const answers = normalizeQuestionRequest(item).questions.map(
      (question, index) => {
        const selected = questionDraft.selections?.[index] ?? [];
        const custom = (questionDraft.custom?.[index] ?? "").trim();
        const merged = custom
          ? question.multiple
            ? [...selected, custom]
            : [custom]
          : selected;
        return [...new Set(merged.filter((answer) => answer !== ""))];
      },
    );
    return { requestID: item.id, answers };
  },
};

function normalizeQuestionRequest(item: PendingItem): QuestionRequest {
  const request = item.request as Partial<QuestionRequest> & {
    options?: Array<string | { label: string }>;
  };
  if (request.questions?.length)
    return { id: item.id, title: item.title, questions: request.questions };
  return {
    id: item.id,
    title: item.title,
    questions: [
      {
        id: `${item.id}:q0`,
        header: item.title,
        question: item.title,
        options: (request.options ?? []).map((option) =>
          typeof option === "string" ? { label: option } : option,
        ),
        custom: true,
      },
    ],
  };
}

// ---------------------------------------------------------------------------
// UI-only controller: which item is open + which were dismissed
// ---------------------------------------------------------------------------
// The pending facts live in the projection (`pendingApprovals` /
// `pendingQuestions`) and are normalized with `normalizePendingItems`; the
// controller only owns the dialog stack state, which must not enter view-store.

export type PendingController = {
  activeID(): string | undefined;
  isDismissed(id: string): boolean;
  focus(id: string): void;
  clearActive(): void;
  dismiss(id: string): void;
  prune(liveIDs: ReadonlySet<string>): void;
};

export function createPendingController(
  onChange?: () => void,
): PendingController {
  let active: string | undefined;
  const dismissed = new Set<string>();
  const changed = () => onChange?.();
  return {
    activeID: () => active,
    isDismissed: (id) => dismissed.has(id),
    focus(id) {
      dismissed.delete(id);
      if (active === id) return;
      active = id;
      changed();
    },
    clearActive() {
      if (active === undefined) return;
      active = undefined;
      changed();
    },
    dismiss(id) {
      dismissed.add(id);
      if (active === id) active = undefined;
      changed();
    },
    prune(liveIDs) {
      let changedState = false;
      for (const id of [...dismissed])
        if (!liveIDs.has(id)) {
          dismissed.delete(id);
          changedState = true;
        }
      if (active !== undefined && !liveIDs.has(active)) {
        active = undefined;
        changedState = true;
      }
      if (changedState) changed();
    },
  };
}
