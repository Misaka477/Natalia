import { expect, test } from "bun:test";
import { toolResultSummary } from "../src/tool-summary";

/**
 * The row's one-line summary, derived from a tool result (the layer-1
 * `render` counterpart).
 *
 * The runtime used to publish `result.slice(0, 200)` as the tool.update
 * summary, so every JSON-returning tool showed raw JSON on the transcript
 * row. The summary is now MEANING: the tool's own projected sentence, or a
 * count/first-line over the result — never a raw prefix.
 *
 * The implementation lives in the contracts leaf because the runtime
 * publishes it on the event AND a client re-derives it from the durable
 * record (a stored summary is a hint: an event recorded before a presenter
 * existed carries a raw prefix forever). One implementation, both readers.
 */
test("a projected summary wins over any derivation", () => {
  expect(toolResultSummary('{"data":[]}', { summary: "3 records" })).toBe(
    "3 records",
  );
  // An empty projected summary is not a summary: the derivation answers.
  expect(toolResultSummary('{"data":[]}', { summary: "  " })).toBe("0 entries");
});

test("a JSON envelope counts its entries", () => {
  expect(toolResultSummary('{"items":[1,2,3]}')).toBe("3 items");
  expect(toolResultSummary('{"items":[]}')).toBe("0 items");
  expect(toolResultSummary('{"matches":["a"]}')).toBe("1 match");
  expect(toolResultSummary('{"nodes":[{},{}]}')).toBe("2 nodes");
  expect(toolResultSummary('{"total":12}')).toBe("12 total");
  expect(toolResultSummary('{"ok":true}')).toBe("done");
  expect(toolResultSummary('{"ok":false,"error":"vault down"}')).toBe(
    "failed: vault down",
  );
  // An envelope with no known noun counts its fields.
  expect(toolResultSummary('{"phase":"active","rounds":1}')).toBe("2 fields");
});

test("a non-JSON result contributes its first line", () => {
  expect(toolResultSummary("wrote a.txt\nsecond line")).toBe("wrote a.txt");
  expect(toolResultSummary("   ")).toBe("done");
  // A bare array counts.
  expect(toolResultSummary("[1,2]")).toBe("2 entries");
});

test("a long line is clipped, never raw-truncated mid-structure", () => {
  const long = "x".repeat(300);
  const summary = toolResultSummary(long);
  expect(summary.length).toBeLessThanOrEqual(97);
  expect(summary.endsWith("…")).toBe(true);
});
