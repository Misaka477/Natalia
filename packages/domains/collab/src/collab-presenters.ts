/**
 * The collab family's presenters (presentation plan P1.1).
 *
 * The layer-2 vocabulary: `presentCall` answers with the call's own
 * arguments, `presentResult` with the settled value's facts. The collab
 * family's tools all answer with JSON envelopes (`JSON.stringify` of an
 * object), so the result presenters decode the same envelope the model
 * reads — title is the object (the session / the message / the plan), the
 * summary the one-line state, and `meta` the counts and ids a reader
 * scans without opening the card.
 *
 * Discipline (restated for this family): a presenter is a PURE
 * function over its arguments and the result STRING — a malformed result
 * degrades to a generic card rather than throwing, because a card that
 * throws takes the whole transcript row down with it.
 */
import type { ToolOutputDefinition } from "@anthelia/tools";
import { toolResultBody } from "@anthelia/contracts";

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

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * The envelope's facts (R4): what decoded, its title, and the pills' own
 * values — ONE decode, shared by the meta slot and the card.
 */
function envelopeFacts(
  value: string,
  keys: ReadonlyArray<readonly [string, string]>,
): Record<string, unknown> {
  const parsed = decode(value);
  if (!parsed) return {};
  const record: Record<string, unknown> = { decoded: true };
  for (const [, key] of keys) {
    const found = parsed[key];
    if (found !== undefined && found !== null && found !== "")
      record[key] = found;
  }
  const title = text(parsed.title);
  if (title !== undefined) record.title = title;
  return record;
}

/**
 * A generic card over a decoded envelope: the caller names the title and
 * summary, the optional label/value pairs ride as pills. A result that
 * does not decode falls back to the summary alone.
 *
 * R4: the facts arrive on the third argument (the meta slot the runtime
 * just filled), so the envelope is decoded once — by
 * {@link envelopeFacts} — instead of a second time here.
 */
export function collabResultCard(input: {
  title: string;
  summary: string;
  meta?: Array<[string, string]>;
}): NonNullable<ToolOutputDefinition["presentResult"]> {
  return (_args, value, meta) => {
    const facts =
      meta === undefined
        ? envelopeFacts(value, input.meta ?? [])
        : (meta as Record<string, unknown>);
    const pills = input.meta
      ?.map(([label, key]) => {
        const found = facts[key];
        if (found === undefined || found === null || found === "")
          return undefined;
        return [label, String(found)] as [string, string];
      })
      .filter((pair): pair is [string, string] => pair !== undefined);
    return {
      kind: "generic",
      title: text(facts.title) ?? input.title,
      summary: input.summary,
      // The envelope as a READING (R6): the tool-side flatten, so a client
      // renders text and parses nothing. A card without a body used to
      // leave the row showing the raw JSON.
      body: toolResultBody(value),
      ...(pills && pills.length ? { meta: pills } : {}),
    };
  };
}

/**
 * The collab delivery family's card (S4-d).
 *
 * A delivery's answer is WHO the message reached and WHAT the runtime
 * decided: the message id, the thread, the recipient, whether a reply is
 * expected. The shared flatten rendered the envelope's keys; this card
 * reads them, one fact per line.
 */
/**
 * The recipient a delivery's call names: `to` for a chat, `planID`/`path` for
 * a plan write. It is what the row leads with, so the answer keeps it.
 */
function deliveryTitle(args: unknown, fallback: string): string {
  const parsed =
    args && typeof args === "object" ? (args as Record<string, unknown>) : {};
  const to = typeof parsed.to === "string" && parsed.to ? parsed.to : undefined;
  const planID =
    typeof parsed.planID === "string" && parsed.planID
      ? parsed.planID
      : undefined;
  const path =
    typeof parsed.path === "string" && parsed.path ? parsed.path : undefined;
  return to ?? planID ?? path ?? fallback;
}

export function collabDeliveryCard(input: {
  callTitle: string;
  callSummary: string;
  resultSummary: string;
  /** Envelope keys that ride as label:value pills. */
  pills?: ReadonlyArray<readonly [string, string]>;
  /** Envelope keys that ride as body lines, in this order. */
  facts?: ReadonlyArray<string>;
}): ToolOutputDefinition {
  return {
    schema: ENVELOPE_SCHEMA,
    presentCall(args) {
      return {
        kind: "generic",
        title: deliveryTitle(args, input.callTitle),
        summary: input.callSummary,
      };
    },
    presentationMeta(_args, value) {
      return envelopeFacts(value, [
        ...(input.pills ?? []),
        ...(input.facts ?? []).map((key) => [key, key] as const),
      ]);
    },
    presentResult(args, value, meta) {
      const callTitle = deliveryTitle(args, input.callTitle);
      const facts =
        meta === undefined
          ? envelopeFacts(value, [
              ...(input.pills ?? []),
              ...(input.facts ?? []).map((key) => [key, key] as const),
            ])
          : (meta as Record<string, unknown>);
      const pills = (input.pills ?? [])
        .map(([label, key]) => {
          const found = facts[key];
          return found === undefined || found === null || found === ""
            ? undefined
            : ([label, String(found)] as [string, string]);
        })
        .filter((pair): pair is [string, string] => pair !== undefined);
      const lines = (input.facts ?? []).flatMap((key) => {
        const found = facts[key];
        return found === undefined || found === null || found === ""
          ? []
          : [`${key} · ${String(found)}`];
      });
      return {
        kind: "generic",
        // The call's own title (the recipient, the plan path) is what the
        // row leads with; the envelope's title only fills in when the call
        // named none.
        title: callTitle ?? text(facts.title) ?? input.callTitle,
        summary: lines[0] ?? input.resultSummary,
        ...(lines.length > 1 ? { body: lines.join("\n") } : {}),
        ...(pills.length ? { meta: pills } : {}),
      };
    },
  };
}
/** The output block these tools declare: schema + the two presenters. */
export function collabOutput(input: {
  callTitle: string;
  callSummary: string;
  resultTitle: string;
  resultSummary: string;
  meta?: Array<[string, string]>;
}): ToolOutputDefinition {
  return {
    schema: ENVELOPE_SCHEMA,
    presentCall() {
      return {
        kind: "generic",
        title: input.callTitle,
        summary: input.callSummary,
      };
    },
    presentationMeta(_args, value) {
      // ONE decode (R4), the same one the card composes from.
      return envelopeFacts(value, input.meta ?? []);
    },
    presentResult: collabResultCard({
      title: input.resultTitle,
      summary: input.resultSummary,
      meta: input.meta,
    }),
  };
}
