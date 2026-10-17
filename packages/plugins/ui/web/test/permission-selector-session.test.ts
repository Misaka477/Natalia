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
  const start = app.indexOf("const currentRung = () =>");
  expect(start).toBeGreaterThan(0);
  const body = app.slice(start, start + 400);
  expect(body).toContain("rungFor(");
  expect(body).toContain("sessionRung()");
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
