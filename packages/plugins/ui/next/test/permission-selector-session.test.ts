/**
 * The selector is a SESSION control, and the app reaches it that way.
 *
 * Measured defect this pins: `changePermission` wrote the config
 * (`updateConfig`, scope "global") and re-read it, which could not move a
 * workspace that pins `defaultAgentMode` in its own `.natalia/config.json`
 * (`resolveConfig` merges defaults -> global -> project). The only visible
 * effect was the `config.reload` the write triggered; the selector stayed put
 * and the agent's per-turn `Permission mode:` line never changed.
 *
 * These are shape assertions on the app source because the synthesis is Solid
 * components; the BEHAVIOUR (both axes move, the environment block states them,
 * a reload does not stamp over the choice) is pinned against a real runtime in
 * `packages/framework/client/test/session-rung.test.ts`.
 */
import { expect, test } from "bun:test";

const app = await Bun.file(
  new URL("../src/app-neu.tsx", import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/u,
    "$1",
  ),
).text();

test("moving the rung is ONE session-scoped write carrying both axes", () => {
  const start = app.indexOf("async function changePermission");
  expect(start).toBeGreaterThan(0);
  const body = app.slice(start, start + 1800);
  // The session door, with the approval axis alongside the file-effect axis.
  expect(body).toContain("setSandboxRung");
  expect(body).toContain("approval: rung.approval");
  expect(body).toContain("mode: rung.confinement");
  // No config write: that was the no-op (and the reload noise).
  expect(body).not.toContain("updateConfig");
  // And the label may only move when the runtime answered — a missing face is a
  // visible refusal, not a silent no-op (the runtime face WAS missing once).
  expect(body).toContain("setPermissionProblem");
  expect(body).toContain("if (!applied) return;");
});

test("the standing rung is the session's, with the config only as a fallback", () => {
  const start = app.indexOf("const sessionRungFromProjection = () => {");
  expect(start).toBeGreaterThan(0);
  // The window covers the pairing, the runtime ASK that follows it, and the
  // config fallback behind both — the ladder has three rungs, so the slice has
  // to reach the third. Anchored by POSITION (the next declaration), not by a
  // magic length: a fixed 900-char window silently pushed the config assertion
  // out of range the moment a layer was inserted between them, which is exactly
  // how this test went green while the ladder changed.
  const end = app.indexOf("const permissionOptions = () =>", start);
  expect(end).toBeGreaterThan(start);
  const body = app.slice(start, end);
  // The session's own facts first: the approval mode the runtime publishes and
  // the confinement half the session snapshot carries.
  expect(body).toContain("state().permissionMode");
  expect(body).toContain("state().intelligence?.confinement?.mode");
  // The sandbox half has a SECOND source now, and it is the one that survives a
  // restart: `permissionConfinement` comes from the durable rung event, while
  // `intelligence.confinement` only exists while a live `session.snapshot` does.
  expect(body).toContain("state().permissionConfinement");
  // The pairing itself (prettier may format it across lines, so the assertion is
  // on the call, not on one spelling of it).
  expect(body).toContain("rungFor({ approval, confinement })");
  // The runtime is ASKED when the projection has said nothing: a cold start
  // hydrates a message page, so the durable rung events are never folded and no
  // status snapshot arrives after this window subscribes.
  expect(body).toContain("props.ctx.runtime.runtimeStatus");
  // …and the config only answers when nobody else could.
  expect(body).toContain("config()?.defaultAgentMode");
  // Order is the property under test: both session-owned sources come first.
  expect(body.indexOf("sessionRungFromProjection()")).toBeLessThan(
    body.indexOf("config()?.defaultAgentMode"),
  );
  expect(body.indexOf("runtimeRung()")).toBeLessThan(
    body.indexOf("config()?.defaultAgentMode"),
  );
});

test("the session's rung is projected as a field, not only a status word", async () => {
  const status = await Bun.file(
    new URL(
      "../../../../hosts/view-store/src/status.ts",
      import.meta.url,
    ).pathname.replace(/^\/([A-Za-z]:)/u, "$1"),
  ).text();
  // `status.snapshot.permissions` is the runtime's answer on every attach;
  // `session.permission.mode` is the durable record of a move. Folding both is
  // what a second front end reads — the old control showed each client its own
  // last write, so two front ends disagreed about one session's mode.
  expect(status).toContain("state.permissionMode = event.permissions");
  expect(status).toContain('case "session.permission.mode"');
  const state = await Bun.file(
    new URL(
      "../../../../hosts/view-store/src/state.ts",
      import.meta.url,
    ).pathname.replace(/^\/([A-Za-z]:)/u, "$1"),
  ).text();
  expect(state).toContain("permissionMode?:");
});

test("a session switch drops the previous session's rung echo", () => {
  const start = app.indexOf("const resetProjectionForSessionSwitch = () => {");
  expect(start).toBeGreaterThan(0);
  const body = app.slice(start, start + 1400);
  expect(body).toContain("setSessionRung(undefined)");
});

test("the permission menu carries no 'current' suffix", () => {
  const start = app.indexOf("const permissionOptions = () =>");
  expect(start).toBeGreaterThan(0);
  const body = app.slice(start, start + 320);
  expect(body).toContain("label: rung.label");
  expect(body).not.toContain("当前");
});

test("the top bar no longer renders a danger badge", () => {
  // Removed on the user's call (it read as decoration next to the title). The
  // session's confinement posture is still journal-derived in the view store —
  // the audit trail reads the same fact — this pins only its absence from the
  // chrome.
  expect(app).not.toContain("DangerBadge");
  expect(app).not.toContain("neu-danger-badge");
});

/**
 * Measured defect this pins: the selector rendered its 「选择权限」 placeholder
 * over a session standing on `auto`.
 *
 * Two things had to break together for that, and both are measured rather than
 * reasoned about:
 *
 *   1. `runtime.status` — the read a front end makes on every attach — published
 *      the approval axis and NOT the sandbox half, so `permissionConfinement`
 *      never arrived and the pairing could not be made at all.
 *   2. The trigger's fallback then held `config()?.defaultAgentMode`, an
 *      AGENT-MODE name, in a control whose option values are RUNG ids. `ask`
 *      and `auto` coincide, so only the third mode showed it: a deployment on
 *      `read_only` put the literal string `"read_only"` in the trigger, no
 *      option matched, and the control read as unset.
 *
 * The deployment in question is a real one: `defaultAgentMode: "read_only"`
 * with `confinement.mode: "workspace-write"` is a pair the four-rung ladder does
 * not name (`read` is `read_only` + `read-only`), so `rungFor()` answers
 * `undefined` and the fallback is the only thing left standing.
 */
test("the trigger's fallback is a rung id, never an agent-mode name", () => {
  // The mapping exists, and it is by the config's own vocabulary: the mode name
  // in, the rung id out.
  const start = app.indexOf("const configRungID = ()");
  expect(start).toBeGreaterThan(0);
  const body = app.slice(start, start + 500);
  expect(body).toContain("PERMISSION_RUNGS.find");
  expect(body).toContain("rung.agentMode === mode");
  // And the trigger actually uses it rather than the raw mode string. Matched
  // on the expression itself: the file holds several `<NeuSelect>`s, so an
  // index-of-`value={` lands on the wrong one.
  const value = app.slice(
    app.indexOf("currentRung()?.id ?? configRungID()") - 60,
    app.indexOf("currentRung()?.id ?? configRungID()") + 60,
  );
  expect(value).toContain("currentRung()?.id ?? configRungID()");
  // The agent-mode name is never fed to the control directly.
  expect(app).not.toContain("?? config()?.defaultAgentMode");
});

test("the permission read carries BOTH axes for the session it names", async () => {
  const observability = await Bun.file(
    new URL(
      "../../../../framework/client/src/runtime/session-execution/observability.ts",
      import.meta.url,
    ).pathname.replace(/^\/([A-Za-z]:)/u, "$1"),
  ).text();
  const start = observability.indexOf(
    "async runtimeStatus(sessionID?: string)",
  );
  expect(start).toBeGreaterThan(0);
  const body = observability.slice(start, start + 1400);
  // The sandbox half is THIS exec's, not the active one's: the controller's own
  // `confinement` input resolves through `getActiveExec()`, which is the wrong
  // session the moment a caller names one.
  expect(body).toContain("confinement:");
  expect(body).toContain("exec.sandboxModeOverride");
  expect(body).toContain("effectiveConfinementMode({");
});
