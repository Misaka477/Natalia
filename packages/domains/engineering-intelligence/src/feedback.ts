import { randomUUID } from "node:crypto";
import type {
  FeedbackInput,
  FeedbackResult,
  RuntimeEvent,
} from "@anthelia/contracts";
import type { RuntimeContext } from "@anthelia/substrate";

/**
 * D6a — recorded human feedback, captured WITHOUT ever reaching the
 * model (design law 3, after the feedback package group: "signals
 * about the output, never input to it").
 *
 * The isolation is STRUCTURAL: this factory holds no provider, no tool
 * registry and no prompt path — its only seam is journal publication.
 * Ratings land as `feedback.recorded` events with the session; the only
 * route a human opinion ever takes INTO model-visible material is the
 * governance path (constitution / AGENTS.md / skills), which carries
 * hash changes and notifications — never this event.
 *
 * Categories form a FIXED taxonomy: extending it is a
 * code change on purpose, not free-text drift.
 */

export const FEEDBACK_CATEGORIES = [
  "accuracy",
  "style",
  "speed",
  "safety",
  "other",
] as const;

export const FEEDBACK_NOTE_LIMIT = 2_000;

/**
 * The factory ALWAYS provides the method (the client's surface marks it
 * optional for stable-surface reasons; this local shape keeps it
 * callable without NonNullable at every use).
 */
type FeedbackSurface = {
  feedback(input: FeedbackInput): Promise<FeedbackResult>;
};

export type FeedbackValidation =
  | { ok: true; input: FeedbackInput }
  | { ok: false; reason: string };

/** The boundary rules — enforced here AND at the transport edge. */
export function validateFeedbackInput(candidate: unknown): FeedbackValidation {
  if (typeof candidate !== "object" || candidate === null)
    return { ok: false, reason: "feedback input must be an object" };
  const raw = candidate as Record<string, unknown>;
  if (raw.scope !== "session" && raw.scope !== "message")
    return { ok: false, reason: "scope must be session or message" };
  if (typeof raw.sessionID !== "string" || !raw.sessionID)
    return { ok: false, reason: "sessionID required" };
  if (raw.verdict !== "up" && raw.verdict !== "down")
    return { ok: false, reason: "verdict must be up or down" };
  if (
    raw.scope === "message" &&
    (typeof raw.messageID !== "string" || !raw.messageID)
  )
    return { ok: false, reason: "messageID required for message scope" };
  // The retract mode: a withdrawal names the record it undoes. A retraction
  // without its target is a request to delete something unnamed.
  const retract = raw.retract === true;
  if (retract && (typeof raw.recordID !== "string" || !raw.recordID))
    return { ok: false, reason: "recordID required for a retraction" };
  if (
    raw.category !== undefined &&
    !(FEEDBACK_CATEGORIES as readonly unknown[]).includes(raw.category)
  )
    return {
      ok: false,
      reason: `category must be one of ${FEEDBACK_CATEGORIES.join(", ")}`,
    };
  if (raw.note !== undefined && typeof raw.note !== "string")
    return { ok: false, reason: "note must be a string" };
  if (typeof raw.note === "string" && raw.note.length > FEEDBACK_NOTE_LIMIT)
    return {
      ok: false,
      reason: `note exceeds ${FEEDBACK_NOTE_LIMIT} characters`,
    };
  return {
    ok: true,
    input: {
      scope: raw.scope,
      sessionID: raw.sessionID,
      verdict: raw.verdict,
      ...(typeof raw.messageID === "string"
        ? { messageID: raw.messageID }
        : {}),
      ...(typeof raw.category === "string" ? { category: raw.category } : {}),
      ...(typeof raw.note === "string" ? { note: raw.note } : {}),
      ...(retract ? { retract: true } : {}),
      ...(retract ? { recordID: raw.recordID as string } : {}),
    } as FeedbackInput,
  };
}

export function createFeedbackSurface(ctx: RuntimeContext): FeedbackSurface {
  return {
    async feedback(candidate) {
      const validated = validateFeedbackInput(candidate);
      if (!validated.ok) throw new Error(validated.reason);
      const input = validated.input;
      if (ctx.ports.isDisposed()) return { recorded: false, id: "" };
      const at = new Date().toISOString();
      const exec = ctx.ports
        .getExecutionBySession()
        .get(input.sessionID as never);
      const publish = (event: RuntimeEvent) => {
        if (exec) ctx.ports.publishForSession(exec, event);
        else ctx.ports.publish(event);
      };
      // The withdrawal: the same isolation as the recording (a journal
      // fact, never model-visible), published as the compensating event
      // that names the record it undoes.
      if (input.retract) {
        const id = `fbr_${randomUUID().replace(/-/gu, "").slice(0, 12)}`;
        publish({
          type: "feedback.retracted",
          id,
          at,
          sessionID: input.sessionID as never,
          recordID: input.recordID!,
          scope: input.scope,
          ...(input.messageID ? { messageID: input.messageID } : {}),
          verdict: input.verdict,
        } as unknown as RuntimeEvent);
        return { recorded: true, id };
      }
      const id = `fb_${randomUUID().replace(/-/gu, "").slice(0, 12)}`;
      publish({
        type: "feedback.recorded",
        id,
        at,
        sessionID: input.sessionID as never,
        scope: input.scope,
        ...(input.messageID ? { messageID: input.messageID } : {}),
        verdict: input.verdict,
        ...(input.category ? { category: input.category } : {}),
        ...(input.note ? { note: input.note } : {}),
      } as unknown as RuntimeEvent);
      return { recorded: true, id };
    },
  };
}
