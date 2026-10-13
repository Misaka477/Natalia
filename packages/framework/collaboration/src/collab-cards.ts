/**
 * The main agent's collaboration cards (presentation plan P1.1).
 *
 * The layer-2 vocabulary for the four `collab_*` tools the main agent
 * holds: the call card names what the call IS, the result card the one-line
 * state plus the ids a reader scans without opening the card. The collab
 * family's tools all answer with JSON envelopes, so the result presenters
 * decode the same envelope the model reads — and a malformed result
 * degrades to the summary alone rather than throwing, because a card that
 * throws takes the whole transcript row down with it.
 *
 * The discipline the search family learned the hard way (audit ⑥) applies
 * here verbatim: an INTERNAL token never rides the card. `collab_inbox`'s
 * `nextCursor` is a paging cursor for the MODEL; the reader's card shows
 * "N of M messages", never the cursor itself.
 */

import type { ToolCard } from "@anthelia/contracts";
import type { ToolOutputDefinition } from "@anthelia/tools";

/** The permissive output schema these tools' envelopes satisfy. */
const ENVELOPE_SCHEMA = { type: "object", properties: {} } as const;

/** Decode a result string, or undefined when it is not a JSON object. */
function decode(value: string): Record<string, unknown> | undefined {
  try {
    const parsed = JSON.parse(value) as unknown;
    return parsed && typeof parsed === "object" && !Array.isArray(parsed)
      ? (parsed as Record<string, unknown>)
      : undefined;
  } catch {
    return undefined;
  }
}

/** A field's pill value: a non-empty string, or a number spelled out. */
function pillValue(value: unknown): string | undefined {
  if (typeof value === "string" && value.length > 0) return value;
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return undefined;
}

/** A non-empty string field's value, or undefined. */
function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A generic card: the title says what it is, the summary its one-line state. */
function genericCard(input: {
  title: string;
  summary: string;
  meta?: Array<[string, string]>;
}): ToolCard {
  return {
    kind: "generic",
    title: input.title,
    summary: input.summary,
    ...(input.meta && input.meta.length > 0 ? { meta: input.meta } : {}),
  };
}

/** The call card: the arguments, projected by the caller's own mapping. */
function callCard(
  project: (args: Record<string, unknown>) => {
    title: string;
    summary: string;
  },
): NonNullable<ToolOutputDefinition["presentCall"]> {
  return (args) => {
    try {
      const record =
        args && typeof args === "object"
          ? (args as Record<string, unknown>)
          : {};
      return genericCard(project(record));
    } catch {
      return genericCard({ title: "collaboration", summary: "call" });
    }
  };
}

/**
 * The result card over a decoded envelope: the caller names the title and
 * the summary, and reads the envelope's own facts for the pills. A result
 * that does not decode keeps the summary and drops the pills.
 */
function resultCard(input: {
  title: string;
  summary: string | ((facts: Record<string, unknown>) => string);
  meta?: Array<[label: string, key: string]>;
}): NonNullable<ToolOutputDefinition["presentResult"]> {
  return (_args, value) => {
    const facts = decode(value);
    const summary =
      typeof input.summary === "function"
        ? input.summary(facts ?? {})
        : input.summary;
    const meta = facts
      ? input.meta
          ?.map(([label, key]) => {
            const found = pillValue(facts[key]);
            return found === undefined
              ? undefined
              : ([label, found] as [string, string]);
          })
          .filter((pill): pill is [string, string] => pill !== undefined)
      : undefined;
    return genericCard({
      title: input.title,
      summary,
      ...(meta && meta.length > 0 ? { meta } : {}),
    });
  };
}

/** `collab_respond`: a suggestion, answered with a decision. */
export const collabRespondOutput: ToolOutputDefinition = {
  schema: ENVELOPE_SCHEMA,
  presentCall: callCard((args) => ({
    title: "suggestion",
    summary: text(args.decision) ?? "respond",
  })),
  presentResult: resultCard({
    title: "suggestion",
    summary: "responded",
    meta: [["decision", "decision"]],
  }),
};

/** `collab_inbox`: the channel's page, named by its counts — never its cursor. */
export const collabInboxOutput: ToolOutputDefinition = {
  schema: ENVELOPE_SCHEMA,
  presentCall: callCard(() => ({ title: "inbox", summary: "read" })),
  presentResult: resultCard({
    title: "inbox",
    summary: (facts) => {
      const returned = facts.returned;
      const total = facts.total;
      return typeof returned === "number" && typeof total === "number"
        ? `${returned} of ${total} message${total === 1 ? "" : "s"}`
        : "read";
    },
    meta: [
      ["returned", "returned"],
      ["total", "total"],
    ],
  }),
};

/** `collab_chat`: an informal message, sent or replied. */
export const collabChatOutput: ToolOutputDefinition = {
  schema: ENVELOPE_SCHEMA,
  presentCall: callCard((args) => ({
    title: "message",
    summary: text(args.messageID) ? "reply" : "send",
  })),
  presentResult: resultCard({
    title: "message",
    summary: "sent",
    meta: [
      ["messageID", "messageID"],
      ["to", "to"],
    ],
  }),
};

/** `collab_ask`: a question, answered with advice — or with the state that replaced it. */
export const collabAskOutput: ToolOutputDefinition = {
  schema: ENVELOPE_SCHEMA,
  presentCall: callCard(() => ({ title: "question", summary: "ask" })),
  presentResult: resultCard({
    title: "advice",
    summary: (facts) => text(facts.consult) ?? "asked",
  }),
};
