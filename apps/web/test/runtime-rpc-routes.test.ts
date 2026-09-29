import { expect, test } from "bun:test";
import { RPC_METHOD_ROUTES, buildParams } from "../src/runtime-rpc";

test("web runtime routes expose the paged transcript surfaces", () => {
  expect(RPC_METHOD_ROUTES.subagentHistoryPage).toBe("subagent.history.page");
});

test("object-style RPC params stay flat", () => {
  expect(buildParams("driftFindings", [{ sessionID: "ses_1" }])).toEqual({
    sessionID: "ses_1",
  });
  expect(buildParams("evidenceRecords", [{ sessionID: "ses_1" }])).toEqual({
    sessionID: "ses_1",
  });
  expect(
    buildParams("recordDecision", [{ decision: "keep this flat" }]),
  ).toEqual({
    decision: "keep this flat",
  });
});

test("every method the settings panel calls has a web route", () => {
  // The field report: the panel's response-cache row read "未接通" and its
  // click did nothing. The web client's proxy exposes a method ONLY when the
  // route table names it, so a face missing here is not "broken" — it is
  // absent, and every call site has to optional-chain around it.
  for (const [face, route] of [
    ["responseCache", "cache.response"],
    ["settingsGet", "settings.get"],
    ["settingsSet", "settings.set"],
  ] as const) {
    expect(RPC_METHOD_ROUTES[face], `${face} -> ${route}`).toBe(route);
  }
});

test("the settings panel's cache row can reach the method it flips", () => {
  // The row reads `typeof runtime.responseCache === "function"` before it
  // calls anything. A route whose name is not in the table is not a function,
  // and the row then reports 未接通 — so the route's presence IS the wiring.
  expect(
    typeof (RPC_METHOD_ROUTES as Record<string, unknown>).responseCache,
  ).toBe("string");
});

test("the skill panel's switch and remove have web routes", () => {
  // The panel shipped with a hardcoded, non-interactive toggle (a span) and a
  // disabled delete button. The faces now exist; without the routes they would
  // be just as dead as the buttons were.
  expect(RPC_METHOD_ROUTES.skillSetEnabled).toBe("skill.setEnabled");
  expect(RPC_METHOD_ROUTES.skillRemove).toBe("skill.remove");
});
