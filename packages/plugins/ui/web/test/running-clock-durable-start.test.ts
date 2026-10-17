/**
 * The running clock counts from the turn's own start.
 *
 * Measured defect this pins: the start time was a client-side "first time I saw
 * activeTurn" heuristic held in ONE app-level signal, so switching to a running
 * session restarted the clock at zero, switching between two running sessions
 * showed the first session's elapsed time as the second's, and a mid-turn reload
 * began at 0. The reference harness reads the turn record instead
 * (`location.turn.start?.time`), which is why its clock survives a tab switch.
 *
 * The durable start now rides the turn itself (`turn.submitted.at`, stamped
 * where the runtime publishes the turn) and reaches the UI through the
 * projection, so the clock is a per-session fact. The client-side signal
 * survives only for a journal written before the field existed, keyed by turn id
 * so it cannot leak across sessions, and the label says "计时未知" rather than
 * showing a confident 0s.
 */
import { expect, test } from "bun:test";
import { join } from "node:path";

const here = import.meta.dir;
const repo = join(here, "..", "..", "..", "..");

async function source(...segments: string[]): Promise<string> {
  return await Bun.file(join(repo, ...segments)).text();
}

const app = await source("plugins", "ui", "web", "src", "app-neu.tsx");

test("the turn's start is stamped where the runtime publishes it", async () => {
  const admission = await source(
    "framework",
    "client",
    "src",
    "runtime",
    "session-admission.ts",
  );
  expect(admission).toContain("at: new Date().toISOString()");
  const orchestration = await source(
    "framework",
    "client",
    "src",
    "runtime",
    "initialize",
    "framework-turn-orchestration.ts",
  );
  expect(orchestration).toContain("at: new Date().toISOString()");
});

test("the contract carries the start on the turn itself", async () => {
  const events = await source("core", "contracts", "src", "events.ts");
  const at = events.indexOf('type: "turn.submitted"');
  expect(at).toBeGreaterThan(0);
  const body = events.slice(at, at + 900);
  expect(body).toContain("at?: string");
});

test("the projection carries the start as a per-session fact", async () => {
  const conversation = await source(
    "hosts",
    "view-store",
    "src",
    "conversation.ts",
  );
  const at = conversation.indexOf('case "turn.submitted"');
  expect(at).toBeGreaterThan(0);
  const body = conversation.slice(at, at + 2200);
  expect(body).toContain("state.activeTurnStartedAt = startedAt");
  const state = await source("hosts", "view-store", "src", "state.ts");
  expect(state).toContain("activeTurnStartedAt?: number");
});

test("the clock reads the projection, and the local echo is keyed by turn", () => {
  const at = app.indexOf("const turnStartAt = () =>");
  expect(at).toBeGreaterThan(0);
  const body = app.slice(at, at + 320);
  expect(body).toContain("state().activeTurnStartedAt");
  expect(body).toContain("activeTurnStartedAtValue()");
  // The legacy echo is remembered per turn id, so a session switch neither
  // restarts a running turn nor shows another session's elapsed time.
  const frame = app.indexOf(
    "const durableStart = projected.activeTurnStartedAt",
  );
  expect(frame).toBeGreaterThan(0);
  const frameBody = app.slice(frame, frame + 700);
  expect(frameBody).toContain("legacyTurnStartKey() !== currentTurn");
  expect(frameBody).toContain("setLegacyTurnStartKey(currentTurn)");
});

test("a turn with no durable start says so instead of showing zero", () => {
  const at = app.indexOf('"计时未知"');
  expect(at).toBeGreaterThan(0);
  const body = app.slice(at - 400, at + 200);
  expect(body).toContain("turnStartAt() === undefined");
});

test("a session switch drops the previous session's clock", () => {
  const at = app.indexOf("const resetProjectionForSessionSwitch = () => {");
  expect(at).toBeGreaterThan(0);
  const body = app.slice(at, at + 1700);
  expect(body).toContain("setLegacyTurnStartKey(undefined)");
  expect(body).toContain("setTurnElapsedMs(0)");
});
