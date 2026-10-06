/**
 * The collab family's presenters (presentation plan P1.1).
 *
 * dsh's layer-2 vocabulary: `presentCall` answers with the call's own
 * arguments, `presentResult` with the settled value's facts. The collab
 * family's tools all answer with JSON envelopes (`JSON.stringify` of an
 * object), so the result presenters decode the same envelope the model
 * reads — title is the object (the session / the message / the plan), the
 * summary the one-line state, and `meta` the counts and ids a reader
 * scans without opening the card.
 *
 * Discipline (dsh's, restated for this family): a presenter is a PURE
 * function over its arguments and the result STRING — a malformed result
 * degrades to a generic card rather than throwing, because a card that
 * throws takes the whole transcript row down with it.
 */
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

function text(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/**
 * A generic card over a decoded envelope: the caller names the title and
 * summary, the optional label/value pairs ride as pills. A result that
 * does not decode falls back to the summary alone.
 */
export function collabResultCard(input: {
  title: string;
  summary: string;
  meta?: Array<[string, string]>;
}): NonNullable<ToolOutputDefinition["presentResult"]> {
  return (_args, value) => {
    const parsed = decode(value);
    const meta = input.meta
      ?.map(([label, key]) => {
        const found = parsed?.[key];
        if (found === undefined || found === null || found === "")
          return undefined;
        return [label, String(found)] as [string, string];
      })
      .filter((pair): pair is [string, string] => pair !== undefined);
    return {
      kind: "generic",
      title: parsed ? (text(parsed.title) ?? input.title) : input.title,
      summary: input.summary,
      ...(meta && meta.length ? { meta } : {}),
    };
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
    presentResult: collabResultCard({
      title: input.resultTitle,
      summary: input.resultSummary,
      meta: input.meta,
    }),
  };
}
