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
      ...(pills && pills.length ? { meta: pills } : {}),
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
