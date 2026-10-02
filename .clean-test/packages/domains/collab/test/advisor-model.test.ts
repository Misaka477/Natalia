import { expect, test } from "bun:test";
import { advisorModelFor } from "../src/wake";

/**
 * The advisor-model resolution (the Navi advisor plan's block C): the
 * session's own expert profile first, the config's advisorModel second,
 * and NOTHING when neither is set — that last case is the default by
 * design (the advisor's value is an independent second read, not a
 * capability tier; the user's amendment: the advisor is not required to
 * differ from the main model).
 */

test("the session's expert profile wins", () => {
  expect(
    advisorModelFor(
      { modelID: "session-expert", variant: "v2" },
      "config-advisor",
    ),
  ).toEqual({ modelID: "session-expert", variant: "v2" });
});

test("the config's advisorModel is the fallback", () => {
  expect(advisorModelFor(undefined, "config-advisor")).toEqual({
    modelID: "config-advisor",
  });
  expect(advisorModelFor({}, "config-advisor")).toEqual({
    modelID: "config-advisor",
  });
});

test("neither set: no override — Navi's chat model, the same family as main", () => {
  // The amended default: independence, not a tier.
  expect(advisorModelFor(undefined, undefined)).toBeUndefined();
  expect(advisorModelFor({}, undefined)).toBeUndefined();
  // An empty profile string is not a model.
  expect(advisorModelFor({ modelID: "" }, undefined)).toBeUndefined();
});
