/**
 * The generic tool card factory (the layer-2 vocabulary, the shared
 * spelling).
 *
 * A tool that answers with a JSON envelope and has no reason to invent a
 * bespoke card still owes the UI a projection: the row's title is what the
 * call IS (a query, a plan id, a path), the summary the one-line state, the
 * meta the counts. This is that projection, once, for every such tool —
 * the 2026-10-07 sweep wired the 28 model-facing tools that were still
 * answering with a raw envelope on the row.
 *
 * The presenters stay PURE: `presentCall` reads the call's own arguments,
 * `presentResult` decodes the same envelope the model reads, and a result
 * that does not decode degrades to the summary rather than throwing (a
 * throwing presenter takes the whole transcript row down).
 */
import type { ToolOutputDefinition } from "./types";
import { optionalString, requireObject } from "./arguments";

/** A decoded result record, or undefined when the result is not a JSON object. */
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

/** The pill's value for a key, when the envelope carries it meaningfully. */
function pillValue(found: unknown): string | undefined {
  if (found === undefined || found === null || found === "") return undefined;
  if (typeof found === "boolean") return found ? "yes" : "no";
  if (typeof found === "number") return String(found);
  if (typeof found === "string") return found;
  if (Array.isArray(found)) return String(found.length);
  return undefined;
}

export type GenericToolCardInput = {
  /** The row's family label (the noun the call belongs to). */
  family: string;
  /** The call's verb — "search", "read", "propose". */
  callSummary: string;
  /** The result's one-line state — "3 records", "paused". */
  resultSummary: string;
  /**
   * The pills: label plus the envelope key it reads. A key the result does
   * not carry (or carries empty) simply does not render.
   */
  meta?: Array<[label: string, key: string]>;
  /**
   * The call title's source: a call-argument key (a query, a path, a plan
   * id) read from the arguments. Absent means the family is the title.
   */
  titleKey?: string;
};

/** The output block: schema (any envelope), plus the two presenters. */
export function genericToolCard(
  input: GenericToolCardInput,
): ToolOutputDefinition {
  const callTitle = (args: unknown): string => {
    if (!input.titleKey) return input.family;
    const parsed = requireObject(args);
    const value = optionalString(parsed[input.titleKey]);
    return value ?? input.family;
  };
  /** The envelope's facts: what decoded, its title, and the pills' values. */
  const envelopeFacts = (value: string): Record<string, unknown> => {
    const parsed = decode(value);
    if (!parsed) return {};
    const record: Record<string, unknown> = { decoded: true };
    for (const [, key] of input.meta ?? []) {
      const pill = pillValue(parsed[key]);
      if (pill !== undefined) record[key] = pill;
    }
    if (typeof parsed.title === "string") record.title = parsed.title;
    return record;
  };
  return {
    schema: { type: "object", properties: {} },
    presentCall(args) {
      return {
        kind: "generic",
        title: callTitle(args),
        summary: input.callSummary,
      };
    },
    presentationMeta(_args, value) {
      // ONE decode (R4): the envelope's facts travel the event's meta slot
      // and are handed straight back to the presenter, so the result string
      // is never parsed a second time.
      return envelopeFacts(value);
    },
    presentResult(args, value, meta) {
      const facts =
        meta === undefined
          ? envelopeFacts(value)
          : (meta as Record<string, unknown>);
      const pills = (input.meta ?? [])
        .map(([label, key]) => {
          const found = facts[key];
          return found === undefined
            ? undefined
            : ([label, String(found)] as [string, string]);
        })
        .filter((pair): pair is [string, string] => pair !== undefined);
      return {
        kind: "generic",
        title: typeof facts.title === "string" ? facts.title : callTitle(args),
        summary:
          facts.decoded === true ? input.resultSummary : input.callSummary,
        ...(pills.length > 0 ? { meta: pills } : {}),
        body: value,
      };
    },
  };
}
