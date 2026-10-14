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

test("a reconnect re-attaches the same session without clearing the transcript", () => {
  // Measured on the user's machine: a dropped SSE stream (the server's
  // 255s idle timeout cutting a quiet stream) was followed by an EMPTY
  // transcript for minutes. The reconnect re-attached the active session,
  // and that path announced the session-switch reset — which clears the
  // host's rendered state — and cleared the event buffer, losing the
  // stretch between the drop and the reconnect. Both are pinned here.
  const rpc = readFileSync(
    join(import.meta.dir, "..", "src", "runtime-rpc.ts"),
    "utf8",
  );
  // The reconnect is not a switch: the reset is opt-out, and the
  // reconnect path opts out.
  expect(rpc).toContain("announceReset?: boolean");
  expect(rpc).toContain("announceReset: !opts.reconnect");
  expect(rpc).toContain(
    "attachAndReplay(activeSessionID, { reconnect: true })",
  );
  // And the guard no longer discards the buffer on every connection:
  // without a `since` request the server replays nothing, so the buffer
  // is the only copy of that stretch.
  const guard = rpc.slice(rpc.indexOf("Before every /events connection"));
  expect(guard.slice(0, guard.indexOf("const response"))).not.toContain(
    "liveBuffer.length = 0",
  );
  // A failed connect delivers the stranded events rather than dropping
  // them on the floor.
  expect(rpc).toContain("const stranded = liveBuffer.splice(0);");
});

test("the approval queue's faces are routed — a missing row makes the button dead", () => {
  // The Proxy synthesizes methods only for tabled faces, so an untabled
  // face is `undefined` at the call site and the click does nothing (the
  // failure the feedback button had). The gate button routes through
  // collab.send.
  const routes = readFileSync(
    join(import.meta.dir, "..", "src", "runtime-rpc.ts"),
    "utf8",
  );
  expect(routes).toContain('upsertSkill: "skill.upsert"');
  expect(routes).toContain('collabSend: "collab.send"');
});
