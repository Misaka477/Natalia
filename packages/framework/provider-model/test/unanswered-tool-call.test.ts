/**
 * Two repairs at the request projection boundary, both about facts the
 * gateway enforces that a journal can carry.
 *
 * The measured poison on this host: a session whose journal carried ONE
 * assistant tool call whose `function.arguments` was not valid JSON (the
 * model emitted `{ content placeholder` and a bare filename, the stream
 * completing normally). The gateway validates every tool call's arguments as
 * JSON and answers `input_invalid` for the whole request — proved minimally:
 * that one call alone is a 400, the same call with `{}` is a 200 — so every
 * turn in that session failed from the first occurrence on, with no way to
 * edit the journal. The bisect that found it: rolling the projection back
 * before that turn made the next turn work again, and duplicating VALID calls
 * to the same count did not reproduce it (the count was never the cause).
 *
 * The repairs: sanitize the arguments (the call stays visible, its result
 * still names what was wrong), and close a call that never got a result — the
 * deepseek harness's `ToolCallRecovery` does the same at the same place.
 */
import { expect, test } from "bun:test";
import type { ContextEntry } from "@anthelia/runtime";
import {
  contextEntriesToProviderMessages,
  safeToolCallArguments,
} from "@anthelia/runtime";

/** The restored ledger's shape for a turn with one bad-arguments call. */
function poisonedEntries(): ContextEntry[] {
  return [
    {
      id: "turn_poison:user",
      role: "user",
      content: "write the file",
    },
    {
      id: "turn_poison:assistant",
      role: "assistant",
      content: "",
      contentParts: [
        { type: "text", text: "writing" },
        {
          type: "tool_call",
          id: "call_bad_args",
          name: "write_file",
          arguments: "{ content placeholder\n\nstageB_dft.py\n",
        },
      ],
    },
    {
      id: "restore:turn_poison:call_bad_args:tool.update:call",
      role: "tool_call",
      pairID: "call_bad_args",
      content: "write_file { content placeholder",
    },
    {
      id: "restore:turn_poison:call_bad_args:tool.update:result",
      role: "tool_result",
      pairID: "call_bad_args",
      content: "JSON Parse error: Expected '}'",
    },
  ] as unknown as ContextEntry[];
}

test("the wire sanitizes arguments that are not valid JSON, and keeps valid ones", () => {
  // The measured poison: a model emitted `{ content placeholder` and a bare
  // filename while the stream completed, the runtime recorded the raw string
  // as the call's argumentsDelta, and the gateway answered input_invalid for
  // the whole request — proved minimally: one such call is a 400, the same
  // call with `{}` is a 200. The journal keeps the raw (the tool's own
  // "JSON Parse error" result names what was wrong); the WIRE gets `{}`.
  expect(
    safeToolCallArguments("{ content placeholder\n\nstageB_dft.py\n"),
  ).toBe("{}");
  // Valid arguments pass through untouched — including a bare string, which
  // the assembly preserves and only the wire would question.
  expect(safeToolCallArguments('{"path": "x.md"}')).toBe('{"path": "x.md"}');
  expect(safeToolCallArguments("a.ts")).toBe("{}");
});

test("a call with valid arguments is passed through untouched", () => {
  const entries = poisonedEntries();
  // Replace the bad call with a good one end to end.
  const patched = entries.map((entry) => {
    if (entry.role === "assistant")
      return {
        ...entry,
        contentParts: [
          {
            type: "tool_call",
            id: "call_good",
            name: "write_file",
            arguments: '{"path": "x.md", "content": "y"}',
          },
        ],
      };
    if (entry.role === "tool_call")
      return {
        ...entry,
        pairID: "call_good",
        id: "restore:t:call_good:call",
        content: `write_file {"path": "x.md", "content": "y"}`,
      };
    if (entry.role === "tool_result")
      return {
        ...entry,
        pairID: "call_good",
        id: "restore:t:call_good:result",
      };
    return entry;
  }) as unknown as ContextEntry[];
  const messages = contextEntriesToProviderMessages(patched);
  const assistant = messages.find((m) => m.role === "assistant")!;
  const call = assistant.toolCalls!.find((c) => c.id === "call_good")!;
  expect(call.arguments).toBe('{"path": "x.md", "content": "y"}');
});

test("a call with no result is closed with the recovery text", () => {
  // The other gateway rule: every assistant call must be followed by its
  // result. The transaction scan drops an unpaired call, but an assistant
  // message's content parts carry the recorded calls too, and the pairing
  // check below reads them.
  const entries = [
    {
      id: "t:user",
      role: "user",
      content: "go",
    },
    {
      id: "t:assistant",
      role: "assistant",
      content: "",
      contentParts: [
        {
          type: "tool_call",
          id: "call_never_ran",
          name: "write_file",
          arguments: '{"path": "z.md"}',
        },
      ],
    },
  ] as unknown as ContextEntry[];
  const messages = contextEntriesToProviderMessages(entries);
  const result = messages.find(
    (m) => m.role === "tool" && m.toolCallID === "call_never_ran",
  );
  expect(result).toBeDefined();
  expect(String(result!.content)).toContain("never answered");
  expect(String(result!.content)).toContain("outcome is unknown");
});
