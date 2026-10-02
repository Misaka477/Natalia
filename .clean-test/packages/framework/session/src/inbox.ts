import { createHash } from "node:crypto";
import type {
  LocalAttachment,
  PromptAgentMention,
  PromptResourceMention,
  RuntimeEvent,
  SessionID,
} from "@anthelia/contracts";
import type { SessionRecord } from "./index";

/**
 * Where an admitted input is delivered.
 *
 * `next-turn` runs as its own turn after the current one; `next-step` is
 * injected into the running turn's next step. Legacy journals store `steer` /
 * `queue`; `normalizeDelivery` maps them to `next-turn` on read, because the old
 * values only ever meant "a separate turn, earlier/later".
 */
export type SessionInputDelivery = "next-turn" | "next-step";

export function normalizeDelivery(value: unknown): SessionInputDelivery {
  // Legacy `steer` only meant "run before queued turns", never "inject into the
  // running turn", so it must not become `next-step`.
  return value === "next-step" ? "next-step" : "next-turn";
}

export type AdmittedSessionInput = {
  id: string;
  sessionID: SessionID;
  text: string;
  attachments?: LocalAttachment[];
  resources?: PromptResourceMention[];
  agents?: PromptAgentMention[];
  delivery: SessionInputDelivery;
  internal?: boolean;
  admittedAt: string;
  admittedSeq: number;
  promotedAt?: string;
  promotedSeq?: number;
  /** Set when a `next-step` input is claimed by a provider step. */
  claimedAt?: string;
  claimedTurnID?: string;
  claimedStep?: number;
};

function inputDigest(text: string) {
  return {
    byteLength: new TextEncoder().encode(text).byteLength,
    lineCount: text.length === 0 ? 0 : text.split(/\r\n|\r|\n/u).length,
    sha256: createHash("sha256").update(text).digest("hex"),
  };
}

/**
 * Builds the durable `input.admitted` fact. Admission is separate from starting
 * a turn: `turn.submitted` is published when the turn actually begins.
 */
export function buildInputAdmission(input: {
  id: string;
  text: string;
  attachments?: LocalAttachment[];
  resources?: PromptResourceMention[];
  agents?: PromptAgentMention[];
  internal?: boolean;
  delivery: SessionInputDelivery;
  admittedAt: string;
  admittedSeq: number;
}): Extract<RuntimeEvent, { type: "input.admitted" }> {
  return {
    type: "input.admitted",
    id: input.id,
    text: input.text,
    ...inputDigest(input.text),
    delivery: input.delivery,
    ...(input.internal ? { internal: true } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.resources?.length ? { resources: input.resources } : {}),
    ...(input.agents?.length ? { agents: input.agents } : {}),
    admittedAt: input.admittedAt,
    admittedSeq: input.admittedSeq,
  };
}

/** Builds the durable `input.updated` fact for an edited queued input. */
export function buildInputUpdated(
  id: string,
  text: string,
): Extract<RuntimeEvent, { type: "input.updated" }> {
  return { type: "input.updated", id, text, ...inputDigest(text) };
}

/**
 * Builds the `turn.submitted` fact for a turn that is actually starting. The
 * id matches the admitted input that produced it.
 */
export function buildSubmittedTurn(input: {
  id: string;
  text: string;
  attachments?: LocalAttachment[];
  resources?: PromptResourceMention[];
  agents?: PromptAgentMention[];
  internal?: boolean;
}): Extract<RuntimeEvent, { type: "turn.submitted" }> {
  return {
    type: "turn.submitted",
    id: input.id,
    text: input.text,
    ...inputDigest(input.text),
    ...(input.internal ? { internal: true } : {}),
    ...(input.attachments?.length ? { attachments: input.attachments } : {}),
    ...(input.resources?.length ? { resources: input.resources } : {}),
    ...(input.agents?.length ? { agents: input.agents } : {}),
  };
}

export class SessionInputConflictError extends Error {
  constructor(id: string) {
    super(`session input conflicts with existing admission: ${id}`);
  }
}

export function admittedInputs(session: SessionRecord) {
  return session.inbox ?? [];
}

/** Normalizes legacy `steer` / `queue` values in place; idempotent. */
export function normalizeInbox(session: SessionRecord): AdmittedSessionInput[] {
  const inbox = session.inbox ?? [];
  for (const item of inbox)
    if (item.delivery !== "next-turn" && item.delivery !== "next-step")
      item.delivery = normalizeDelivery(item.delivery);
  return inbox;
}

export function admitInput(
  session: SessionRecord,
  input: Omit<
    AdmittedSessionInput,
    | "sessionID"
    | "admittedAt"
    | "admittedSeq"
    | "promotedAt"
    | "promotedSeq"
    | "claimedAt"
    | "claimedTurnID"
    | "claimedStep"
  >,
  now = new Date(),
) {
  const existing = admittedInputs(session).find((item) => item.id === input.id);
  if (existing) {
    if (
      existing.sessionID === session.id &&
      existing.text === input.text &&
      JSON.stringify(existing.attachments ?? []) ===
        JSON.stringify(input.attachments ?? []) &&
      JSON.stringify(existing.resources ?? []) ===
        JSON.stringify(input.resources ?? []) &&
      JSON.stringify(existing.agents ?? []) ===
        JSON.stringify(input.agents ?? []) &&
      existing.delivery === input.delivery &&
      existing.internal === input.internal
    )
      return existing;
    throw new SessionInputConflictError(input.id);
  }
  const admitted: AdmittedSessionInput = {
    ...input,
    sessionID: session.id,
    admittedAt: now.toISOString(),
    admittedSeq:
      admittedInputs(session).reduce(
        (latest, item, index) =>
          Math.max(latest, item.admittedSeq ?? index + 1),
        0,
      ) + 1,
  };
  session.inbox = [...admittedInputs(session), admitted];
  return admitted;
}

/** Highest admission sequence currently in the inbox. */
export function admissionCutoff(session: SessionRecord) {
  return admittedInputs(session).reduce(
    (latest, item, index) => Math.max(latest, item.admittedSeq ?? index + 1),
    0,
  );
}

/**
 * Promotes every un-promoted `next-step` admitted before this turn boundary.
 * These run as their own turn when the session is idle; while a turn is already
 * running, the provider loop claims them in place before a drain can.
 */
export function promoteNextSteps(
  session: SessionRecord,
  cutoff = admissionCutoff(session),
  now = new Date(),
) {
  return promote(
    session,
    admittedInputs(session).filter(
      (item, index) =>
        !item.promotedAt &&
        item.delivery === "next-step" &&
        (item.admittedSeq ?? index + 1) <= cutoff,
    ),
    now,
  );
}

/** Promotes one `next-turn` input at a turn boundary. */
export function promoteNextTurn(session: SessionRecord, now = new Date()) {
  const next = admittedInputs(session).find(
    (item) => !item.promotedAt && item.delivery === "next-turn",
  );
  return next ? promote(session, [next], now) : [];
}

/**
 * Claims every un-promoted `next-step` for one provider step. Claiming marks the
 * input promoted, so a later drain will not also run it as a turn.
 */
export function claimNextSteps(
  session: SessionRecord,
  turnID: string,
  step: number,
  now = new Date(),
) {
  const claimed = admittedInputs(session).filter(
    (item) => !item.promotedAt && item.delivery === "next-step",
  );
  if (!claimed.length) return [];
  const ids = new Set(claimed.map((item) => item.id));
  const claimedAt = now.toISOString();
  const promotedSeq = admissionCutoff(session);
  session.inbox = admittedInputs(session).map((item) =>
    ids.has(item.id)
      ? {
          ...item,
          promotedAt: claimedAt,
          promotedSeq,
          claimedAt,
          claimedTurnID: turnID,
          claimedStep: step,
        }
      : item,
  );
  return session.inbox.filter((item) => ids.has(item.id));
}

/** Removes one not-yet-promoted input. Promoting means it can no longer be cancelled. */
export function removeAdmittedInput(session: SessionRecord, id: string) {
  const existing = admittedInputs(session).find((item) => item.id === id);
  if (!existing || existing.promotedAt) return undefined;
  session.inbox = admittedInputs(session).filter((item) => item.id !== id);
  return existing;
}

/** Replaces the text of one not-yet-promoted input. */
export function replaceAdmittedInput(
  session: SessionRecord,
  id: string,
  text: string,
) {
  const existing = admittedInputs(session).find((item) => item.id === id);
  if (!existing || existing.promotedAt) return undefined;
  session.inbox = admittedInputs(session).map((item) =>
    item.id === id ? { ...item, text } : item,
  );
  return session.inbox.find((item) => item.id === id);
}

/** Promotes one queued `next-turn` input to `next-step` so the running turn takes it. */
export function promoteInputToStep(session: SessionRecord, id: string) {
  const existing = admittedInputs(session).find((item) => item.id === id);
  if (!existing || existing.promotedAt || existing.delivery !== "next-turn")
    return undefined;
  session.inbox = admittedInputs(session).map((item) =>
    item.id === id ? { ...item, delivery: "next-step" } : item,
  );
  return session.inbox.find((item) => item.id === id);
}

function promote(
  session: SessionRecord,
  inputs: AdmittedSessionInput[],
  now: Date,
) {
  if (!inputs.length) return [];
  const promoted = new Set(inputs.map((item) => item.id));
  const promotedAt = now.toISOString();
  const promotedSeq = admissionCutoff(session);
  session.inbox = admittedInputs(session).map((item) =>
    promoted.has(item.id) ? { ...item, promotedAt, promotedSeq } : item,
  );
  return session.inbox.filter((item) => promoted.has(item.id));
}
