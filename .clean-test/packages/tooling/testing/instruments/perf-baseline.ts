/**
 * P5 性能基线 — the instrument, not a gate (master plan DoD5: 基线数字
 * 入档; T2's pillars — ObjectStore v3 / RINA — are judged against the
 * numbers this prints on a quiet machine).
 *
 * What it measures, and why:
 *  - cold CLI start (`--version`): the whole runtime's boot floor;
 *  - journal append / save / load: THE store surface ObjectStore v3
 *    replaces (content lives behind JsonSessionStore today);
 *  - projection replay: the fold cost over the same events (the surface
 *    a cache fabric short-circuits);
 *
 * Sibling instrument (run it directly when the diff surface is under
 * study): `bun scripts/bench-diff-performance.ts` — its full run takes
 * minutes, so it does not ride along here (an instrument must stay
 * fast enough to actually be used; its numbers are recorded beside
 * this file's in the P5 landing doc).
 *
 * Medians over N runs, units in the line itself, machine context
 * printed with the numbers — a baseline without context is folklore.
 * No network, no model, temp state removed in a finally.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  JsonSessionStore,
  appendSessionEvent,
  createSessionRecord,
  projectSession,
} from "@anthelia/session";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";

const RUNS = 5;
const EVENTS = 2_000;

function median(values: number[]): number {
  const sorted = [...values].sort((a, b) => a - b);
  return Number(sorted[Math.floor(sorted.length / 2)]!.toFixed(1));
}

async function timeIt(
  fn: () => Promise<void> | void,
  runs: number,
): Promise<{ median: number; min: number }> {
  const samples: number[] = [];
  for (let i = 0; i < runs; i += 1) {
    const t0 = performance.now();
    await fn();
    samples.push(performance.now() - t0);
  }
  return {
    median: median(samples),
    min: Number(Math.min(...samples).toFixed(1)),
  };
}

async function coldStart(): Promise<void> {
  const proc = Bun.spawnSync(
    [process.execPath, "apps/cli/src/main.ts", "--version"],
    {
      stdout: "ignore",
      stderr: "pipe",
    },
  );
  if (proc.exitCode !== 0)
    throw new Error(
      `--version failed (exit ${proc.exitCode}): ${new TextDecoder().decode(proc.stderr)}`,
    );
}

console.log("== natalia perf baseline");
console.log(
  `machine: ${process.platform}-${process.arch} bun ${Bun.version} runs=${RUNS} events=${EVENTS}`,
);

// 1. cold start floor
const start = await timeIt(coldStart, RUNS);
console.log(
  `cold-start --version: median ${start.median}ms min ${start.min}ms`,
);

// 2/3. journal surface (the ObjectStore v3 replacement target)
const dir = mkdtempSync(join(tmpdir(), "perf-baseline-"));
try {
  const store = new JsonSessionStore(dir);
  const id = "ses_baseline" as SessionID;
  const session = await store.loadOrCreate(id, "baseline");
  const event = {
    type: "turn.submitted",
    id: "adm",
    text: "x".repeat(512),
    byteLength: 512,
    lineCount: 1,
    sha256: "baseline",
  } as unknown as RuntimeEvent;
  const append = await timeIt(() => {
    for (let i = 0; i < EVENTS / RUNS; i += 1)
      appendSessionEvent(session, { ...event, id: `e${i}` } as RuntimeEvent);
  }, RUNS);
  // top the session back up to EVENTS for a fair save/load shape
  for (let i = 0; i < EVENTS - session.events.length; i += 1)
    appendSessionEvent(session, { ...event, id: `top${i}` } as RuntimeEvent);
  const save = await timeIt(() => store.save(session), RUNS);
  const load = await timeIt(async () => {
    const fresh = await store.load(id);
    if (!fresh || fresh.events.length < EVENTS)
      throw new Error("journal load lost events");
  }, RUNS);
  console.log(
    `journal append (${EVENTS / RUNS}/run): median ${append.median}ms min ${append.min}ms`,
  );
  console.log(
    `journal save (${EVENTS} events): median ${save.median}ms min ${save.min}ms`,
  );
  console.log(
    `journal load+replay (${EVENTS} events): median ${load.median}ms min ${load.min}ms`,
  );

  // 4. projection replay (the fold surface)
  const loaded = await store.load(id);
  const project = await timeIt(() => projectSession(loaded!), 10);
  console.log(
    `projection replay projectSession(${EVENTS} events): median ${project.median}ms min ${project.min}ms`,
  );
} finally {
  rmSync(dir, { recursive: true, force: true });
}
