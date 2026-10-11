import { join } from "node:path";
import { readFileSync } from "node:fs";
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
  // The web client's proxy exposes a method ONLY when the route table names
  // it, so a face missing here is not "broken" — it is absent, and every call
  // site has to optional-chain around it. (The response-cache row that this
  // test originally covered was removed: the feature was a first cut whose hit
  // erased tool calls, and a click that does nothing is worse than no row.)
  for (const [face, route] of [
    ["settingsGet", "settings.get"],
    ["settingsSet", "settings.set"],
  ] as const) {
    expect(RPC_METHOD_ROUTES[face], `${face} -> ${route}`).toBe(route);
  }
});

test("the skill panel's switch and remove have web routes", () => {
  // The panel shipped with a hardcoded, non-interactive toggle (a span) and a
  // disabled delete button. The faces now exist; without the routes they would
  // be just as dead as the buttons were.
  expect(RPC_METHOD_ROUTES.skillSetEnabled).toBe("skill.setEnabled");
  expect(RPC_METHOD_ROUTES.skillRemove).toBe("skill.remove");
});

test("the transcript's rating buttons have a web route", () => {
  // The button shipped dead: the RPC route and the server-side face both
  // existed, but the web client's proxy answers `undefined` for a face the
  // route table does not name — so the click did nothing and the silent
  // catch explained nothing. The row below is the whole fix's load-bearing
  // half (the other half is the notice the failure now flashes).
  expect(RPC_METHOD_ROUTES.feedback).toBe("feedback.record");
  // The rating call passes one object (scope/sessionID/messageID/verdict);
  // it must reach the daemon flat, not nested.
  expect(
    buildParams("feedback", [
      { scope: "message", sessionID: "ses_1", messageID: "m1", verdict: "up" },
    ]),
  ).toEqual({
    scope: "message",
    sessionID: "ses_1",
    messageID: "m1",
    verdict: "up",
  });
});

test("the approval queue's faces are routed — a missing row makes the button dead", () => {
  // The Proxy synthesizes methods only for tabled faces, so an untabled
  // face is `undefined` at the call site and the click does nothing (the
  // failure the feedback button had). The queue's approve routes through
  // the landing boundary; the gate button routes through collab.send.
  const routes = readFileSync(
    join(import.meta.dir, "..", "src", "runtime-rpc.ts"),
    "utf8",
  );
  expect(routes).toContain('upsertSkill: "skill.upsert"');
  expect(routes).toContain('collabSend: "collab.send"');
});
