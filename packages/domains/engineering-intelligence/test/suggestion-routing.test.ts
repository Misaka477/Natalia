import { expect, test } from "bun:test";
import {
  pluginOverridesForSuggestions,
  suggestionDestination,
} from "../src/suggestion-routing";

/**
 * The reflection→proposal bridge (step 6's first entry). The mapping is
 * mechanical on purpose: a wish spelled in the catalog's own vocabulary
 * becomes a candidate; everything else keeps its old route. A bridge that
 * invented patches would be the deleted mutator wearing a different hat.
 */

const catalog = [
  { id: "natalia-tool-search", enabled: false },
  { id: "natalia-tool-web", enabled: false },
  { id: "natalia-skills", enabled: true },
];

test("a wish for a disabled catalog plugin becomes an enable override", () => {
  const mapped = pluginOverridesForSuggestions({
    suggestions: [
      {
        kind: "tool",
        capability: "ripgrep search",
        reason: "I reached for a content search and it did not exist",
      },
    ],
    catalog,
  });
  expect(mapped?.plugins).toEqual([
    { id: "natalia-tool-search", enabled: true },
  ]);
  // The note is the model's own words — a candidate whose provenance is a
  // paraphrase is a candidate nobody can audit.
  expect(mapped?.note).toContain("ripgrep search");
  expect(mapped?.note).toContain("did not exist");
});

test("an already-enabled plugin is not a candidate — a no-op is journal noise", () => {
  const mapped = pluginOverridesForSuggestions({
    suggestions: [{ kind: "tool", capability: "skills", reason: "wanted" }],
    catalog,
  });
  expect(mapped).toBeUndefined();
});

test("a wish nothing in the catalog answers maps to nothing", () => {
  const mapped = pluginOverridesForSuggestions({
    suggestions: [
      { kind: "tool", capability: "a time machine", reason: "wanted" },
    ],
    catalog,
  });
  expect(mapped).toBeUndefined();
});

test("non-tool suggestions keep their own route", () => {
  // A skill wish goes to the writer, a rule/policy wish to the human's
  // class: the bridge does not touch them.
  const mapped = pluginOverridesForSuggestions({
    suggestions: [
      { kind: "skill", capability: "deploy runbook", reason: "wanted" },
      { kind: "rule", capability: "never force push", reason: "seen" },
    ],
    catalog,
  });
  expect(mapped).toBeUndefined();
  expect(
    suggestionDestination({ kind: "skill", capability: "x", reason: "" }),
  ).toBe("skill");
  expect(
    suggestionDestination({ kind: "rule", capability: "x", reason: "" }),
  ).toBe("policy");
  expect(
    suggestionDestination({ kind: "tool", capability: "x", reason: "" }),
  ).toBe("generation");
});

test("two phrasings of the same wish stage one override", () => {
  const mapped = pluginOverridesForSuggestions({
    suggestions: [
      { kind: "tool", capability: "search", reason: "first" },
      { kind: "tool", capability: "content search", reason: "second" },
    ],
    catalog,
  });
  expect(mapped?.plugins).toHaveLength(1);
  expect(mapped?.note).toContain("first");
  expect(mapped?.note).toContain("second");
});
