import { expect, test } from "bun:test";
import type { ProviderStreamRequest } from "@anthelia/runtime";
import { recordTurnRequest } from "./e2e-harness";

test("recordTurnRequest skips the session-title turn", () => {
  // Naming a session is a real provider call with neither tools nor turn
  // steps; an index-based assertion reading it fails on a slow runner. The
  // guard is what makes `requests[0]` / `requests.at(-1)` deterministic.
  const requests: ProviderStreamRequest[] = [];
  const title = {
    messages: [
      {
        role: "system",
        content:
          "Create a concise session topic in the same language as the user text. Return only one plain title.",
      },
      { role: "user", content: "hello" },
    ],
    tools: undefined,
  } as unknown as ProviderStreamRequest;
  const turn = {
    messages: [{ role: "system", content: "You are Natalia." }],
    tools: [{ name: "run_shell" }],
  } as unknown as ProviderStreamRequest;
  recordTurnRequest(requests, title);
  recordTurnRequest(requests, turn);
  expect(requests).toHaveLength(1);
  expect(requests[0]?.tools?.map((tool) => tool.name)).toEqual(["run_shell"]);
});
