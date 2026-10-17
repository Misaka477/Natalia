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
  const body = app.slice(start, start + 500);
  // The session's own facts first: the approval mode the runtime publishes and
  // the confinement half the session snapshot carries.
  expect(body).toContain("state().permissionMode");
  expect(body).toContain("state().intelligence?.confinement?.mode");
  expect(body).toContain("rungFor({ approval, confinement })");
  // The config only answers when the runtime has said nothing yet.
  const fallback = app.slice(start, start + 900);
  expect(fallback).toContain("config()?.defaultAgentMode");
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

