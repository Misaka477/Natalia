import { EGRESS_ADVISORY } from "@natalia/client";
import {
  createRuntimeDaemonStore,
  daemonToken,
  readRuntimeDaemonRegistration,
  runtimeDaemonStatus,
} from "@natalia/transport/host";
import { daemonDir } from "./command-helpers";
import {
  DEFAULT_UPDATE_CHANNEL_URL,
  resolveChannel,
  resolveUpdateHome,
  updateProgram,
} from "@natalia/installer";
import {
  assembleResult,
  beatsFloor,
  bestMember,
  gateCandidate,
  curiosityAxis,
  INITIAL_CURIOSITY,
  updateCuriosity,
  type Population,
  evaluateBaseline,
  evolutionStateDir,
  groupRunsByPrompt,
  keywordOverlapJudge,
  mineSessionPairs,
  parentDiff,
  proposeReflective,
  readDataset,
  renderFrontier,
  renderTaskFile,
  runBestOfN,
  runRound,
  samplesFromPairs,
  selectReportedBest,
  scoreUnderProtocol,
  scoreRun,
  segmentTurns,
  splitForPair,
  summaryLine,
  writeDataset,
  type TriedCandidate,
} from "@natalia/engineering-intelligence";
import { createLocalSessionService } from "@anthelia/session-store";
import { consultRecords, consultSummary } from "@natalia/collaboration";
import { evalListLines, evalRun } from "./eval-cli";
import { skillsCli } from "./skills-cli";
import {
  assistantAnswerFromPage,
  daemonIsMidTurn,
  type TurnMessagePage,
} from "./turn-answer";
import {
  callRuntimeRPC,
  createRecordedFetch,
  readCassette,
} from "@natalia/transport";
import { mkdir, writeFile } from "node:fs/promises";
import { join as joinPath, resolve } from "node:path";
import {
  deleteLocalSession,
  duplicateLocalSession,
  exportLocalSessionMetadata,
  importLocalSessionMetadata,
  doctorReport,
  listLocalSessions,
  plainStatus,
  renameLocalSession,
  setLocalSessionPinned,
  sessionTable,
  trustList,
  trustRemove,
  workspaceFilesystemCommand,
  showLocalSession,
  startupDiagnostics,
  localWorkGraph,
  workGraphLines,
} from "./index";
import { valueAfter } from "./command-helpers";
import { ensureNataliaConfigPath, nataliaConfigPath } from "./config-home";
import {
  applyCompositionPatch,
  compositionRowViews,
  compositionStatus,
  compositionStatusLines,
  switchCompositionRow,
} from "./composition-cli";
import { governanceViews } from "@natalia/governance-ledger";
import {
  governanceListLines,
  governanceShow,
  governanceShowLines,
  governanceWhy,
  governanceWhyLines,
} from "./governance-cli";
import { captureDebugBundle } from "./debug-bundle";
import { createInterface } from "node:readline/promises";
import {
  exportStores,
  listPurgeTargets,
  nataliaHome,
  purgeConfirmation,
  purgeData,
  resolvePurgeGate,
  uninstallProgram,
} from "./store-maintenance";

/** A positive-integer flag, with its default and its name for the refusal. */
function positiveInt(
  raw: string | undefined,
  fallback: number,
  name: string,
): number {
  if (raw === undefined) return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value < 1) {
    console.error(`${name} must be a positive integer, got ${raw}`);
    process.exit(1);
  }
  return value;
}

/**
 * A deterministic random for the engine's parent draw: a run's population
 * path must be reproducible, or a score difference between two runs cannot
 * be attributed to the candidates.
 */
function seededRandom(seed: number): () => number {
  let state = (seed * 2654435761) % 2147483647;
  if (state <= 0) state += 2147483646;
  return () => {
    state = (state * 16807) % 2147483647;
    return (state - 1) / 2147483646;
  };
}

export async function handleLocalCommands(argv: string[]) {
  const subcommand = argv[0];
  if (
    !new Set([
      "diagnose",
      "--diagnostics",
      "status",
      "workgraph",
      "doctor",
      "composition",
      "governance",
      "session",
      "fs",
      "trust",
      "replay",
      "uninstall",
      "purge",
      "store",
      "debug-bundle",
      "bench",
      "runs",
      "consults",
      "evolution",
      "skills",
      "update",
    ]).has(subcommand ?? "")
  )
    return false;

  // The argument shape is validated BEFORE the config home is created, and the
  // order is the whole point. `ensureNataliaConfigPath` CREATES `.natalia/` and
  // its config file as a side effect, so calling it before the shape checks made
  // every rejected form leave that directory behind — which is what
  // apps/cli/test/cli.test.ts:511 pins ("old top-level install and uninstall no
  // longer write tool activation"). On Linux CI that assertion failed with
  // `Expected: false, Received: true`, i.e. the directory existed.
  //
  // The uninstall case's own comment already said this ("must fail before
  // anything touches the filesystem"); the call ordering simply did not match
  // it. Refusing first and creating only on the paths that need the config keeps
  // the guarantee real instead of aspirational.
  const rejectBeforeTouchingDisk = (usage: string): never => {
    console.error(usage);
    process.exit(1);
  };

  if (subcommand === "uninstall") {
    // The app-level uninstall takes NO arguments — and the dead
    // `uninstall <tool> --workspace` form must fail before anything
    // touches the filesystem (a CLI test asserts that exit, and an
    // argument-bearing call here would otherwise operate on the real
    // home while "succeeding").
    if (argv.slice(1).filter((arg) => !arg.startsWith("-")).length > 0) {
      rejectBeforeTouchingDisk(
        "usage: natalia uninstall (the old top-level `uninstall <tool>` form is gone)",
      );
    }
  }

  // Resolved THROUGH the shared entry point, which also makes sure the
  // directory and the file exist. The previous inline spelling produced the
  // same path and then handed it to a strict reader, so a fresh install crashed
  // on the config it was supposed to create itself.
  const configPath = (await ensureNataliaConfigPath(nataliaConfigPath())).path;
  switch (subcommand) {
    case "uninstall": {
      // NO arguments — already enforced above, before the config home was
      // created. Keeping the check here too would be dead code, and moving it
      // back would restore the leak.
      // Study §5: uninstall removes the PROGRAM and states where the
      // rescue ring stays. Nothing under stores/ is opened for deletion.
      const home = nataliaHome();
      const report = await uninstallProgram(home);
      for (const entry of report.removed) console.log(`removed ${entry}/`);
      if (!report.programPresent)
        console.log(`no program files under ${home} (bin/, versions/)`);
      console.log(report.message);
      break;
    }
    case "purge": {
      // 火化要明确: the full list prints BEFORE any confirmation.
      const home = nataliaHome();
      const targets = await listPurgeTargets(home);
      console.log(JSON.stringify({ willDelete: targets }, null, 2));
      const gate = resolvePurgeGate({
        yes: argv.includes("--yes"),
        isTTY: Boolean(process.stdin.isTTY),
      });
      if (gate.ask) {
        const rl = createInterface({
          input: process.stdin,
          output: process.stdout,
        });
        const answer = await rl.question('type "purge" to confirm: ');
        rl.close();
        if (!purgeConfirmation(answer)) {
          console.error("purge cancelled — nothing was deleted");
          process.exit(1);
        }
      } else if (!gate.proceed) {
        console.error(gate.reason);
        process.exit(1);
      }
      const { removed } = await purgeData(home);
      console.log(`purged: ${removed.join(", ") || "(nothing present)"}`);
      console.log(
        "the program is not this command's business — run natalia uninstall for bin/ and versions/",
      );
      break;
    }
    case "debug-bundle": {
      // One-key capture (decisions §5): journal slice + operational log +
      // redacted configs + doctor + a queried recents summary, inventoried
      // with SHA256SUMS. Usage: natalia debug-bundle <dest-dir> [--workspace]
      const dest = argv.filter((arg) => !arg.startsWith("--"))[1];
      if (!dest) {
        console.error(
          "usage: natalia debug-bundle <dest-dir> [--workspace <root>]",
        );
        process.exit(1);
      }
      try {
        const report = await captureDebugBundle({
          workspaceRoot: valueAfter(argv, "--workspace") ?? process.cwd(),
          dest,
        });
        console.log(JSON.stringify(report, null, 2));
        console.log(
          `debug bundle at ${report.dest} — journal + logs + config (redacted)`,
        );
      } catch (error) {
        console.error(error instanceof Error ? error.message : String(error));
        process.exit(1);
      }
      break;
    }
    case "update": {
      // D3a: check → verify-at-source → stage → atomic swap → exact
      // --version probe → automatic rollback. POSIX-first (the atomic
      // swap is a symlink rename; install.ps1 parity is the plan's own
      // Windows follow-up). The default channel lands in D5 — until
      // then a source is an explicit --from (the plan's own staging).
      const valueFlags = new Set([
        "--from",
        "--home",
        "--restart-unit",
        "--channel",
      ]);
      const positionals: string[] = [];
      let from: string | undefined;
      let home: string | undefined;
      let restartUnit: string | undefined;
      let channelFlag: string | undefined;
      for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (valueFlags.has(arg)) {
          if (arg === "--from") from = argv[index + 1];
          if (arg === "--home") home = argv[index + 1];
          if (arg === "--restart-unit") restartUnit = argv[index + 1];
          if (arg === "--channel") channelFlag = argv[index + 1];
          index += 1;
          continue;
        }
        if (arg.startsWith("--")) continue;
        positionals.push(arg);
      }
      if (positionals.length) {
        console.error(
          "usage: natalia update --from <dir|https-url> [--home <dir>]",
        );
        process.exit(1);
      }
      // D5's resolution order: an explicit --from wins (any exact
      // source, downgrade allowed = an operator's deliberate install);
      // otherwise the channel — --channel, then NATALIA_UPDATE_CHANNEL,
      // then the plan's contracted default URL (it activates when ops
      // serves natalia.dev; until then the failure is bounded and
      // honest, naming both overrides).
      let channelLatest: string | undefined;
      if (!from) {
        const descriptor =
          channelFlag ??
          process.env.NATALIA_UPDATE_CHANNEL ??
          DEFAULT_UPDATE_CHANNEL_URL;
        try {
          const resolved = await resolveChannel(descriptor);
          from = resolved.source;
          channelLatest = resolved.channel.latest;
        } catch (error) {
          console.error(
            `update: ${error instanceof Error ? error.message : String(error)} — set NATALIA_UPDATE_CHANNEL or pass --from <dir|url>`,
          );
          process.exit(1);
        }
      }
      const installHome = resolveUpdateHome(process.env, home);
      // The daemon store IS the detection (its own status is the
      // liveness authority: pid + protocol version, stale records
      // self-clean). What the store knows, the update never asks for.
      const store = createRuntimeDaemonStore({ dir: daemonDir() });
      const daemonStatus = await runtimeDaemonStatus(store);
      if (
        daemonStatus.state === "stale" ||
        daemonStatus.state === "incompatible"
      )
        console.error(
          `update: daemon store ${daemonStatus.state} — not draining (${daemonStatus.state === "stale" ? "the recorded pid is dead and the record was removed" : "record/protocol version mismatch"})`,
        );
      const runtime =
        daemonStatus.state === "running" && daemonStatus.registration
          ? {
              url: daemonStatus.registration.url,
              token: await daemonToken(store),
            }
          : undefined;
      const result = await updateProgram({
        home: installHome,
        from: from!,
        ...(channelLatest !== undefined ? { channelLatest } : {}),
        ...(runtime ? { runtime } : {}),
        ...(restartUnit ? { restartUnit } : {}),
      });
      console.log(
        `update: ${result.outcome}` +
          (result.reason ? ` — ${result.reason}` : "") +
          (result.warning ? `\nwarning: ${result.warning}` : "") +
          (result.receiptPath ? `\nreceipt: ${result.receiptPath}` : ""),
      );
      process.exit(result.exitCode);
    }
    case "bench": {
      // G-c's outer half (the object-store study's batch): the frozen
      // benchmark's tasks listed offline, and RUN through the daemon's
      // live turn machinery. No daemon answers no_daemon per task —
      // nothing is recorded, nothing faked. (The subcommand is `bench`:
      // `eval` is the runtime's own REPL face.)
      const action = argv[1];
      if (action !== "list" && action !== "run") {
        console.error(
          "usage: natalia bench list|run [--dir <path>] [--task <id>]... [--limit N] [--json]",
        );
        process.exit(1);
      }
      if (action === "list") {
        const lines = await evalListLines(argv);
        console.log(
          argv.includes("--json")
            ? JSON.stringify({ lines }, null, 2)
            : lines.join("\n"),
        );
        break;
      }
      const result = await evalRun(argv);
      console.log(
        argv.includes("--json")
          ? JSON.stringify(result, null, 2)
          : [
              `eval run: ${result.scanned} scanned, ${result.recorded} recorded, ${result.failed} failed`,
              ...result.outcomes.map((outcome) => {
                const entry = outcome as {
                  taskID: string;
                  recorded: boolean;
                  success?: boolean;
                  reason?: string;
                };
                const verb = entry.recorded
                  ? entry.success === undefined
                    ? "recorded (unscored)"
                    : entry.success
                      ? "recorded (success)"
                      : "recorded (failed)"
                  : `skipped (${entry.reason ?? "unknown"})`;
                return `${entry.taskID} — ${verb}`;
              }),
            ].join("\n"),
      );
      break;
    }
    case "runs": {
      // G-b's internal-evaluation report: score every turn from the
      // workspace journal and show the same-prompt distribution — pure
      // offline replay, no telemetry, no daemon.
      // Flag VALUES are not positionals (the --workspace <path> value
      // must not trip the usage gate): value-taking flags skip their
      // argument, boolean flags stand alone.
      const valueFlags = new Set(["--workspace", "--prompt"]);
      const positionals: string[] = [];
      for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (valueFlags.has(arg)) {
          index += 1;
          continue;
        }
        if (arg.startsWith("--")) continue;
        positionals.push(arg);
      }
      if (positionals.length) {
        console.error(
          "usage: natalia runs [--prompt <sha-prefix>] [--workspace <root>] [--json]",
        );
        process.exit(1);
      }
      const workspaceRoot = valueAfter(argv, "--workspace") ?? process.cwd();
      const promptFilter = valueAfter(argv, "--prompt");
      const service = createLocalSessionService(workspaceRoot);
      const rows = await service.list();
      const scores = [];
      for (const row of rows) {
        const events = await service.events(row.id).catch(() => []);
        for (const window of segmentTurns(events))
          scores.push(scoreRun(window, { sessionID: row.id }));
      }
      const groups = groupRunsByPrompt(scores)
        .filter(
          (group) => !promptFilter || group.promptKey.startsWith(promptFilter),
        )
        .sort((left, right) => right.runs - left.runs);
      if (argv.includes("--json")) {
        console.log(JSON.stringify({ groups, runs: scores.length }, null, 2));
        break;
      }
      if (!groups.length) {
        console.log("no turns found");
        break;
      }
      console.log("PROMPT\tRUNS\tOK%\tAVG_IN\tAVG_OUT\tAVG_MS\tRETRIES");
      for (const group of groups)
        console.log(
          [
            group.promptKey,
            group.runs,
            `${group.successRate}%`,
            group.avgInputTokens ?? "-",
            group.avgOutputTokens ?? "-",
            group.avgDurationMs ?? "-",
            group.retries,
          ].join("\t"),
        );
      break;
    }
    case "evolution": {
      // L2's dataset miner and L3's evaluation face, offline: mine the
      // workspace journal into (task, response) pairs (secret-filtered at
      // the entry, split deterministically), or report a mined dataset's
      // shape and its baseline floor. Pure replay over the journal (the
      // same read `runs` scores), no daemon, no telemetry, and the main
      // session's live cache is never touched.
      const usage =
        "usage: natalia evolution mine --target <name> [--workspace <root>] [--json]\n" +
        "       natalia evolution evaluate --target <name> [--workspace <root>] [--json]\n" +
        "       natalia evolution optimize --target <name> --engine best-of-n --n <count> [--workspace <root>] [--json]";
      const action = argv[1];
      if (action !== "mine" && action !== "evaluate" && action !== "optimize") {
        console.error(usage);
        process.exit(1);
      }
      const target = valueAfter(argv, "--target");
      if (!target) {
        console.error(usage);
        process.exit(1);
      }
      const workspaceRoot = valueAfter(argv, "--workspace") ?? process.cwd();
      if (action === "mine") {
        const service = createLocalSessionService(workspaceRoot);
        const rows = await service.list();
        const pairs = [];
        const dropped = { secrets: 0, empty: 0, internal: 0, trivial: 0 };
        let sessions = 0;
        for (const row of rows) {
          const events = await service.events(row.id).catch(() => []);
          if (!events.length) continue;
          sessions += 1;
          const mined = mineSessionPairs(row.id, events);
          pairs.push(...mined.pairs);
          dropped.secrets += mined.dropped.secrets;
          dropped.empty += mined.dropped.empty;
          dropped.internal += mined.dropped.internal;
          dropped.trivial += mined.dropped.trivial;
        }
        const written = await writeDataset({ workspaceRoot, target, pairs });
        const report = {
          target,
          sessions,
          pairs: pairs.length,
          ...written,
          dropped,
        };
        if (argv.includes("--json")) {
          console.log(JSON.stringify(report, null, 2));
          break;
        }
        console.log(
          [
            `dataset: ${target} → ${written.dir}`,
            `sessions read: ${sessions}`,
            `pairs: ${written.train} train / ${written.val} val / ${written.holdout} holdout`,
            `dropped: ${dropped.secrets} secret-shaped, ${dropped.empty} without a response, ${dropped.internal} without a human task, ${dropped.trivial} too trivial to learn from`,
          ].join("\n"),
        );
        break;
      }
      // evaluate: the mined dataset's shape and its baseline floor. The
      // baseline is the journal's own recorded responses scored through
      // the cheap overlap judge — the number a candidate must beat by the
      // strict-improvement rule. The holdout's score rides the sealed
      // door (a number, never its cases); the dimensions the cheap judge
      // cannot measure are REPORTED, not invented.
      if (action === "evaluate") {
        const dataset = await readDataset(workspaceRoot, target);
        if (!dataset) {
          console.error(
            `no dataset named ${target} under ${workspaceRoot}/.natalia/evolution/datasets — run: natalia evolution mine --target ${target}`,
          );
          process.exit(1);
        }
        const { baseline, holdoutScore } = evaluateBaseline({
          pool: {
            samples: samplesFromPairs(dataset.visible, (pair) =>
              splitForPair(pair),
            ),
          },
          holdout: samplesFromPairs(dataset.holdout, () => "holdout" as const),
        });
        const report = {
          target,
          dir: dataset.dir,
          samples: {
            train: dataset.train.length,
            val: dataset.val.length,
            holdout: dataset.holdout.length,
          },
          baseline: {
            score: baseline.score,
            holdoutScore,
            unjudgedDimensions: ["procedureFollowing", "conciseness"],
          },
        };
        if (argv.includes("--json")) {
          console.log(JSON.stringify(report, null, 2));
          break;
        }
        console.log(
          [
            `dataset: ${target} → ${dataset.dir}`,
            `samples: ${dataset.train} train / ${dataset.val} val / ${dataset.holdout.length} holdout (sealed)`,
            `baseline score: ${baseline.score.toFixed(4)} (holdout ${holdoutScore.toFixed(4)})`,
            `judge: keyword overlap — procedure_following and conciseness are UNJUDGED, not measured`,
          ].join("\n"),
        );
        break;
      }
      // optimize: L4a's floor engine. N independent answers to the
      // dataset's first train task, each submitted through the daemon as
      // its own turn, scored by the cheap judge against the recorded
      // reference. No daemon answers no_daemon per attempt — nothing is
      // faked, the batch reports what it could not do.
      if (argv[1] === "optimize") {
        const engine = valueAfter(argv, "--engine");
        if (engine !== "best-of-n" && engine !== "reflective") {
          console.error(
            "usage: natalia evolution optimize --target <name> --engine best-of-n|reflective --n <count> [--rounds <count>] [--samples <count>] [--seed <n>] [--merge-every <K>] [--out <dir>] [--idle-only] [--idle-timeout <seconds>] [--workspace <root>] [--json]",
          );
          process.exit(1);
        }
        const nRaw = valueAfter(argv, "--n");
        const n = nRaw === undefined ? Number.NaN : Number(nRaw);
        if (!Number.isInteger(n) || n < 1) {
          console.error(
            "natalia evolution optimize requires --n <count> (a positive integer)",
          );
          process.exit(1);
        }
        const optimizeRoot = valueAfter(argv, "--workspace") ?? process.cwd();
        const dataset = await readDataset(optimizeRoot, target);
        if (!dataset || !dataset.train.length) {
          console.error(
            `no mined dataset named ${target} with train samples under ${optimizeRoot} — run: natalia evolution mine --target ${target}`,
          );
          process.exit(1);
        }
        const task = dataset.train[0]!;
        const pool = samplesFromPairs(dataset.visible, (pair) =>
          splitForPair(pair),
        );
        const sealed = samplesFromPairs(
          dataset.holdout,
          () => "holdout" as const,
        );
        const { baseline } = evaluateBaseline({
          pool: { samples: pool },
          holdout: sealed,
        });
        const store = createRuntimeDaemonStore({ dir: daemonDir() });
        const registration = await readRuntimeDaemonRegistration(store);
        const token = registration ? await daemonToken(store) : undefined;
        // One daemon turn per sampling call: the instruction is submitted,
        // the turn's final assistant text comes back. The reference
        // harness's SkillModule pattern — the artifact under optimization
        // IS the instruction a real turn follows.
        //
        // The answer is located BY TURN, not by "the last assistant row in
        // the session": every sample of every candidate submits into the
        // SAME session, so a turn that produced no answer would otherwise
        // silently hand back the PREVIOUS sample's answer and score it as
        // this one's — corrupt data that looks like a weak candidate.
        // `session.messages` answers a page of projected turns
        // (`{data: [{turnID, submitted, rows}]}`); the assistant's
        // confirmed text is the `content.done` row inside the turn's own
        // projection.
        // W5: the evolution never competes with a live session. The
        // reference design's resource rule — the trainer waits for the
        // inference pipeline to be idle, because a user's turn must never
        // queue behind a mutation experiment. The busy signal is the
        // session's own last projected turn: an unsettled one (no
        // stopReason) is a turn in flight.
        const idleOnly = argv.includes("--idle-only");
        const idleTimeout = positiveInt(
          valueAfter(argv, "--idle-timeout"),
          300,
          "idle-timeout",
        );
        const waitForIdle = async (): Promise<void> => {
          if (!idleOnly || !registration) return;
          const deadline = Date.now() + idleTimeout * 1_000;
          for (;;) {
            const page = await callRuntimeRPC<{
              data?: Array<{ stopReason?: string }>;
            }>({
              url: registration.url,
              token,
              method: "session.messages",
            });
            if (!daemonIsMidTurn(page)) return;
            if (Date.now() >= deadline)
              throw new Error(
                `the daemon is mid-turn and did not settle within ${idleTimeout}s (--idle-only)`,
              );
            await new Promise((resolve) => setTimeout(resolve, 5_000));
          }
        };
        const sampleTurn = async (prompt: string): Promise<string> => {
          if (!registration)
            throw new Error("no_daemon: start one with `natalia daemon`");
          await waitForIdle();
          const turn = await callRuntimeRPC<{ id?: string }>({
            url: registration.url,
            token,
            method: "submit.andWait",
            params: { text: prompt },
            signal: AbortSignal.timeout(45_000),
          });
          const page = await callRuntimeRPC<TurnMessagePage>({
            url: registration.url,
            token,
            method: "session.messages",
          });
          const answer = assistantAnswerFromPage(page, turn.id);
          if (!answer.ok) throw new Error(answer.reason);
          return answer.text;
        };
        if (engine === "reflective") {
          const rounds = positiveInt(valueAfter(argv, "--rounds"), 2, "rounds");
          const samplesWanted = positiveInt(
            valueAfter(argv, "--samples"),
            2,
            "samples",
          );
          const seed = positiveInt(valueAfter(argv, "--seed"), 1, "seed");
          // S3 (merge half): the free merge cadence. Off by default — the
          // channel earns its keep on a population with branches, and a
          // one-round run has none.
          const mergeEvery = positiveInt(
            valueAfter(argv, "--merge-every"),
            0,
            "merge-every",
          );
          const outOverride = valueAfter(argv, "--out");
          // The visible pool is bounded by the flag (each sample costs a
          // turn per candidate); the sealed holdout runs in full — it is
          // the whole point of sealing it.
          const visible = pool.slice(0, samplesWanted);
          // The judge: the run's answer against the sample's recorded
          // response, through the documented cheap proxy, with the
          // candidate's instruction in hand so procedure following has a
          // criterion (W1). conciseness stays UNJUDGED — the report says
          // so.
          const evaluateInstruction = async (
            id: string,
            instruction: string,
          ) => {
            // One real run per sample (the reference harness's SkillModule
            // pattern), then the ONE protocol (W10) assembles the score —
            // the same function the BestOfN floor is measured by.
            const answers: string[] = [];
            for (const sample of [...visible, ...sealed]) {
              answers.push(
                await sampleTurn(
                  `${sample.input}\n\nFollow this instruction:\n${instruction}\n\nProduce the answer.`,
                ),
              );
            }
            return scoreUnderProtocol({
              outputs: answers,
              samples: [...visible, ...sealed],
              instruction,
              sizes: {
                artifactSize: Buffer.byteLength(instruction, "utf8"),
                maxSize: Number.MAX_SAFE_INTEGER,
              },
            });
          };
          // The baseline instruction: the trivial one, measured for real.
          const baselineInstruction =
            "Answer the user's task directly and completely.";
          // A daemon that cannot answer even the baseline is a named
          // failure, not a stack trace.
          let baselineResult;
          try {
            baselineResult = await evaluateInstruction(
              "baseline",
              baselineInstruction,
            );
          } catch (error) {
            const reason =
              error instanceof Error ? error.message : String(error);
            if (argv.includes("--json"))
              console.log(
                JSON.stringify(
                  { target, engine: "reflective", failed: reason },
                  null,
                  2,
                ),
              );
            else
              console.error(`reflective run failed at the baseline: ${reason}`);
            process.exit(1);
          }
          const results = new Map([["baseline", baselineResult]]);
          // S7: the loop's memory. The summary accumulates one line per
          // evaluated candidate (with its parent diff and the conditions
          // it was measured under), the frontier carries the best and the
          // per-example ownership, and the tried-list is what the NEXT
          // round's proposer reads — without it the mutator is amnesiac
          // and the cheapest way to waste an evaluation is to re-run a
          // hypothesis that already lost.
          const runDir = outOverride
            ? resolve(optimizeRoot, outOverride)
            : evolutionStateDir(optimizeRoot, `runs/${target}-${Date.now()}`);
          const gateVerdict = (text: string) =>
            gateCandidate({
              target: { kind: "prompt-segment" as const, name: target },
              baseline: baselineInstruction,
              candidate: text,
              suite: {
                ok: false,
                detail:
                  "unverified — the optimize path does not run the suite; apply_generation does",
              },
            });
          const summaryLines: string[] = [];
          const tried: TriedCandidate[] = [];
          // W4: the curiosity controller. It owns the explore/exploit mix:
          // the axis used to be whatever the sampler happened to produce.
          // Idle capacity and recent gain raise curiosity, consecutive
          // failures pull it down, and the round's axis follows.
          let curiosity = INITIAL_CURIOSITY;
          let previousBest = baselineResult.score;
          const provenance = `judge=keyword dataset=${target}`;
          const writeRunState = async () => {
            await mkdir(runDir, { recursive: true });
            await writeFile(
              joinPath(runDir, "task.md"),
              renderTaskFile({
                objective: `evolve the instruction for ${target}`,
                background:
                  "reflective engine: parent selection -> reflection -> a real run per sample -> atomic join",
                evaluationModel:
                  "keyword overlap against the recorded responses; procedure and conciseness UNJUDGED",
              }),
            );
            await writeFile(
              joinPath(runDir, "evolution_summary.jsonl"),
              summaryLines.join("\n").concat(summaryLines.length ? "\n" : ""),
            );
            await writeFile(
              joinPath(runDir, "frontier.json"),
              renderFrontier({
                best: bestMember(population)
                  ? {
                      name: bestMember(population)!.id,
                      score: bestMember(population)!.score,
                    }
                  : null,
                perExample: Object.fromEntries(
                  bestMember(population)
                    ? Object.entries(bestMember(population)!.perExample).map(
                        ([sampleID, score]) => [
                          sampleID,
                          { name: bestMember(population)!.id, score },
                        ],
                      )
                    : [],
                ),
              }),
            );
            for (const member of population.members)
              await writeFile(
                joinPath(runDir, "agents", `${member.id}.txt`),
                member.components.instruction ?? "",
              );
          };
          let population: Population = {
            members: [
              {
                id: "baseline",
                components: { instruction: baselineInstruction },
                score: baselineResult.score,
                perExample: baselineResult.perExample,
                trainableFailures: baselineResult.trainableFailureCases.length,
                isViable: baselineResult.isViable,
                children: 0,
                // The seed: exempt from the viability gate so a baseline
                // that already matches the recorded answers (no trainable
                // failure case) can still take the loop's first step. The
                // exemption is never inherited.
                seed: true,
                lineage: {},
              },
            ],
          };
          let stopped: string | undefined;
          for (let round = 1; round <= rounds && !stopped; round += 1) {
            let outcome;
            try {
              outcome = await runRound({
                population,
                random: seededRandom(seed * 1000 + round),
                // S3 (merge half): every K-th round also attempts one free
                // merge over a common ancestor.
                round,
                mergeEvery,
                hooks: {
                  propose: async (parent) => {
                    const parentResult = results.get(parent.id)!;
                    const proposal = await proposeReflective({
                      components: ["instruction"],
                      currentParam: parent.components.instruction!,
                      result: parentResult,
                      pool: visible,
                      // The memory: what has been tried and how it ended,
                      // so this round does not re-run a lost hypothesis.
                      history: tried,
                      // The controller's axis for this round (a hint, not
                      // a command — the sampler may answer otherwise).
                      axisHint: curiosityAxis(curiosity),
                      sampler: async ({ prompt }) => await sampleTurn(prompt),
                    });
                    if (!proposal.ok)
                      throw new Error(`reflection refused: ${proposal.reason}`);
                    return {
                      id: `iter${round}_${proposal.candidate.axis}`,
                      components: { instruction: proposal.candidate.text },
                      hypothesis: proposal.candidate.hypothesis,
                      axis: proposal.candidate.axis,
                    };
                  },
                  evaluate: async (proposal) => {
                    const result = await evaluateInstruction(
                      proposal.id,
                      proposal.components.instruction!,
                    );
                    results.set(proposal.id, result);
                    return {
                      score: result.score,
                      perExample: result.perExample,
                      trainableFailures: result.trainableFailureCases.length,
                      isViable: result.isViable,
                    };
                  },
                },
              });
            } catch (error) {
              // A dead turn mid-run stops the loop with its reason; the
              // rounds that did run stay in the report.
              stopped = `round failed: ${
                error instanceof Error ? error.message : String(error)
              }`;
              break;
            }
            population = outcome.population;
            stopped = outcome.stopped;
            // The controller learns from the round: the gain is the best
            // score's movement, and the idle ratio is the CLI's own (a
            // foreground command is not idle).
            const roundBest = Math.max(
              ...population.members.map((member) => member.score),
            );
            curiosity = updateCuriosity(curiosity, {
              idleRatio: 0,
              gain: roundBest - previousBest,
            });
            previousBest = roundBest;
            // The record: each added member's diff against its parent, the
            // conditions it was measured under, and its place in the
            // tried-list the next proposer reads.
            for (const member of outcome.added) {
              const parent = population.members.find(
                (candidate) => candidate.id === member.lineage.parent,
              );
              const diff = parent
                ? await parentDiff(
                    parent.components.instruction ?? "",
                    member.components.instruction ?? "",
                  )
                : undefined;
              const memberGate = gateVerdict(
                member.components.instruction ?? "",
              );
              summaryLines.push(
                summaryLine({
                  iteration: round,
                  name: member.id,
                  score: member.score,
                  axis: member.axis ?? "exploitation",
                  hypothesis: member.hypothesis ?? "(unstated)",
                  delta: parent ? member.score - parent.score : 0,
                  outcome:
                    member.score > (parent?.score ?? 0)
                      ? "accepted"
                      : "rejected",
                  components: Object.keys(member.components),
                  ...(diff ? { parentDiff: diff.patch } : {}),
                  provenance,
                  // W9: the gate verdict rides the line. A candidate that
                  // scored well and was refused is the most instructive
                  // line in the history — where the loop learned what
                  // fitness cannot see.
                  gate: {
                    passed: memberGate.passed,
                    refusals: memberGate.refusals,
                  },
                }),
              );
              tried.push({
                hypothesis: member.hypothesis ?? "(unstated)",
                outcome: member.learningLog?.observedOutcome ?? "(unobserved)",
                ...(member.axis ? { axis: member.axis } : {}),
              });
            }
            await writeRunState();
          }
          // S3 (selection half): the reported best is drawn from the
          // Pareto front with frequency weighting — a candidate that is
          // extraordinary on one kind of example and ordinary elsewhere
          // OWNS the front it wins, which is how it stays selectable. The
          // max-score pick would let one well-rounded average bury every
          // specialist. The seed is fixed, so the draw is reproducible.
          const best = selectReportedBest(population, seededRandom(seed));
          const gate = beatsFloor({
            best,
            floorScore: baselineResult.score,
          });
          // S2/S6: the seven gates on the reported best, and on the
          // baseline (a gate the baseline fails is pre-existing, not the
          // candidate's fault).
          const candidateGate = best
            ? gateVerdict(best.components.instruction ?? "")
            : undefined;
          const baselineGate = gateVerdict(baselineInstruction);
          // S2/S6: the loop's output is GATED before it is reported, and
          // the baseline is gated too (a gate the baseline fails is a
          // pre-existing problem, not the candidate's fault). The seams the
          // optimize path cannot honestly fill — the full suite and the
          // benchmark — answer UNVERIFIED rather than passing: a gate that
          // cannot check says so, and the report shows which half of the
          // verdict was measured. Blocking on them here would make the
          // command useless before L6 exists; they are the landing path's
          // job (apply_generation runs the real suite).
          const report = {
            target,
            engine: "reflective",
            rounds,
            samples: visible.length,
            holdoutSamples: sealed.length,
            // Where the loop's memory lives: the summary, the frontier and
            // every candidate's body, readable after the run.
            runDir,
            baseline: {
              instruction: baselineInstruction,
              score: baselineResult.score,
              trainableFailures: baselineResult.trainableFailureCases.length,
            },
            best: best
              ? {
                  id: best.id,
                  score: best.score,
                  instruction: best.components.instruction,
                  hypothesis: best.hypothesis,
                  axis: best.axis,
                }
              : null,
            beatBaseline: gate.ok,
            gateReason: gate.reason,
            // The controller's last state, so a reader sees WHY the last
            // rounds asked for what they asked for.
            curiosity: {
              value: curiosity.value,
              failures: curiosity.failures,
              axis: curiosityAxis(curiosity),
            },
            // The seven gates on the reported best, and on the baseline
            // (pre-existing problems named as such).
            candidateGate: candidateGate && {
              passed: candidateGate.passed,
              gates: candidateGate.gates,
              refusals: candidateGate.refusals,
            },
            baselineGate: {
              passed: baselineGate.passed,
              gates: baselineGate.gates,
              refusals: baselineGate.refusals,
            },
            population: population.members.map((member) => ({
              id: member.id,
              score: member.score,
              children: member.children,
              ...(member.hypothesis ? { hypothesis: member.hypothesis } : {}),
              ...(member.axis ? { axis: member.axis } : {}),
            })),
            ...(stopped ? { stopped } : {}),
            judge:
              "keyword overlap — procedure_following and conciseness are UNJUDGED, not measured",
          };
          console.log(
            argv.includes("--json")
              ? JSON.stringify(report, null, 2)
              : [
                  `reflective on ${target}: ${rounds} round(s) × ${visible.length} sample(s) (+${sealed.length} sealed)`,
                  `memory: ${runDir}`,
                  `baseline: ${baselineResult.score.toFixed(4)} (${baselineResult.trainableFailureCases.length} trainable failures)`,
                  ...population.members.map(
                    (member) =>
                      `  ${member.id}: ${member.score.toFixed(4)}${member.axis ? ` [${member.axis}]` : ""}`,
                  ),
                  best
                    ? `best: ${best.id} at ${best.score.toFixed(4)}`
                    : "best: none",
                  `phase gate: ${gate.reason}`,
                  `judge: keyword overlap — the recorded responses score 1.0 against themselves, so the ceiling is the reference; a real judge is what closes the gap`,
                ].join("\n"),
          );
          break;
        }
        const result = await runBestOfN({
          prompt: task.task,
          n,
          sampler: async ({ prompt }) => await sampleTurn(prompt),
          // The ONE protocol (W10): the same score function the reflective
          // engine is measured by, so the floor and the engine's numbers
          // are comparable. One sampled answer, judged across the pool.
          score: (text) =>
            scoreUnderProtocol({ outputs: text, samples: pool }).score,
          baselineScore: baseline.score,
        });
        const report = {
          target,
          engine: "best-of-n",
          task: { turnID: task.turnID, chars: task.task.length },
          baselineScore: baseline.score,
          best: result.best
            ? {
                attempt: result.best.attempt,
                score: result.best.score,
                chars: result.best.chars,
              }
            : null,
          beatBaseline: result.beatBaseline,
          attempts: result.attempts.map((attempt) => ({
            attempt: attempt.attempt,
            score: attempt.score,
            chars: attempt.chars,
          })),
          failures: result.failures,
        };
        if (argv.includes("--json")) {
          console.log(JSON.stringify(report, null, 2));
          break;
        }
        console.log(
          [
            `best-of-n on ${target} (task ${task.turnID}):`,
            `baseline score: ${baseline.score.toFixed(4)}`,
            ...result.attempts.map(
              (attempt) =>
                `  attempt ${attempt.attempt}: ${attempt.score.toFixed(4)} (${attempt.chars} chars)`,
            ),
            ...result.failures.map(
              (failure) =>
                `  attempt ${failure.attempt}: FAILED — ${failure.reason}`,
            ),
            result.best
              ? `best: attempt ${result.best.attempt} — ${result.beatBaseline ? "BEATS" : "does not beat"} the baseline`
              : "best: none (every attempt failed)",
            `judge: keyword overlap — the recorded reference scores 1.0 against itself, so the floor's ceiling is the reference; the reflective engine is what closes the gap`,
          ].join("\n"),
        );
        break;
      }
      // The gate above refuses any other action; this break is the
      // structural proof of it (a switch case that can fall through is a
      // case that one day will).
      break;
    }
    case "skills": {
      // The skills CLI: the catalog, the durable off-switch, and the
      // remove (attempted for any name; the boundary's refusal is the
      // answer). The daemon owns the service, so this is the operator's
      // path for what the settings panel deliberately does not offer.
      await skillsCli(argv.slice(1));
      break;
    }
    case "consults": {
      // The advisor pattern's measurement (the Navi advisor plan's block
      // D): the main agent's questions to Navi and her answers, folded
      // from every workspace session's journal — pure offline replay, no
      // daemon, no telemetry. v1 records; the trigger policy waits for
      // this distribution (先量的东西不许自动).
      const valueFlags = new Set(["--workspace"]);
      const positionals: string[] = [];
      for (let index = 1; index < argv.length; index += 1) {
        const arg = argv[index]!;
        if (valueFlags.has(arg)) {
          index += 1;
          continue;
        }
        if (arg.startsWith("--")) continue;
        positionals.push(arg);
      }
      if (positionals.length) {
        console.error("usage: natalia consults [--workspace <root>] [--json]");
        process.exit(1);
      }
      const workspaceRoot = valueAfter(argv, "--workspace") ?? process.cwd();
      const service = createLocalSessionService(workspaceRoot);
      const rows = await service.list();
      const records = [];
      for (const row of rows) {
        const events = await service.events(row.id).catch(() => []);
        records.push(...consultRecords(events));
      }
      const summary = consultSummary(records);
      if (argv.includes("--json")) {
        console.log(JSON.stringify({ summary, records }, null, 2));
        break;
      }
      if (!records.length) {
        console.log("no consults found");
        break;
      }
      console.log("ASKED\tANSWERED\tDECLINED\tOPEN\tAVG_MS\tMAX_MS");
      console.log(
        [
          summary.asked,
          summary.answered,
          summary.declined,
          summary.open,
          summary.avgLatencyMs ?? "-",
          summary.maxLatencyMs ?? "-",
        ].join("\t"),
      );
      for (const record of records.slice(-20))
        console.log(
          [
            record.outcome,
            record.askedAt,
            record.latencyMs ?? "-",
            record.questionPreview,
          ].join("\t"),
        );
      break;
    }
    case "store": {
      const action = argv[1];
      if (action === "export" && argv[2]) {
        try {
          const report = await exportStores(nataliaHome(), argv[2]);
          console.log(JSON.stringify(report, null, 2));
        } catch (error) {
          console.error(error instanceof Error ? error.message : String(error));
          process.exit(1);
        }
        break;
      }
      console.error("usage: natalia store export <dest-dir>");
      process.exit(1);
    }
    case "diagnose":
    case "--diagnostics": {
      console.log(
        JSON.stringify(await startupDiagnostics(configPath), null, 2),
      );
      break;
    }

    case "status": {
      console.log(JSON.stringify(await plainStatus(configPath), null, 2));
      break;
    }

    case "workgraph": {
      const action = argv[1] ?? "list";
      const sessionID = argv[2];
      if (action !== "list" || !sessionID)
        throw new Error("workgraph list requires a session ID");
      const graph = await localWorkGraph(
        sessionID,
        valueAfter(argv, "--workspace") ?? process.cwd(),
      );
      console.log(
        argv.includes("--json")
          ? JSON.stringify(graph, null, 2)
          : workGraphLines(graph).join("\n"),
      );
      break;
    }

    case "doctor": {
      const report = await doctorReport({
        configPath,
        workspaceRoot: valueAfter(argv, "--workspace"),
      });
      console.log(
        argv.includes("--json")
          ? JSON.stringify(report, null, 2)
          : [
              `config: ${report.configPath}`,
              `migration: ${report.migration}`,
              `layers: @anthelia ${report.layers.anthelia.length} · @natalia ${report.layers.natalia.length} (${report.layers.source})`,
              // DoD #4: the build identity rides the same manifest the
              // layers do — an incident report must name the build.
              report.layers.version
                ? `build: ${report.layers.version}${report.layers.target ? ` (${report.layers.target})` : ""}`
                : "build: source checkout (no baked version)",
              `default model: ${report.defaultModel.key} (${report.defaultModel.selected ? "selected" : (report.defaultModel.reason ?? "unavailable")})`,
              `sessions: ${report.sessions.count} (${report.sessions.pendingInputs} pending inputs)`,
              EGRESS_ADVISORY,
            ].join("\n"),
      );
      break;
    }

    case "governance": {
      // CST3's read face (constitution/decision ledger plan §5): what the
      // law is and why. The override grant/approve half runs the live
      // runtime's approval seam and stays on that face — this one only
      // explains.
      const action = argv[1];
      const workspace = valueAfter(argv, "--workspace") ?? process.cwd();
      if (action === "list") {
        console.log(
          argv.includes("--json")
            ? JSON.stringify(governanceViews(workspace), null, 2)
            : governanceListLines(workspace).join("\n"),
        );
        break;
      }
      if (action === "show") {
        const ruleID = argv[2];
        if (!ruleID)
          throw new Error(
            "governance show requires a rule id (see: natalia governance list)",
          );
        console.log(
          argv.includes("--json")
            ? JSON.stringify(governanceShow(workspace, ruleID), null, 2)
            : governanceShowLines(workspace, ruleID).join("\n"),
        );
        break;
      }
      if (action === "why") {
        const decisionID = argv[2];
        if (!decisionID)
          throw new Error(
            "governance why requires a decision id (see: natalia governance list)",
          );
        console.log(
          argv.includes("--json")
            ? JSON.stringify(governanceWhy(workspace, decisionID), null, 2)
            : governanceWhyLines(workspace, decisionID).join("\n"),
        );
        break;
      }
      throw new Error(
        "governance <list|show|why> (the constitution/decision ledger's read face)",
      );
    }

    case "composition": {
      // Decision 12's v1 face: list / status / apply / switch over the
      // workspace's drop-in layer. `switch` is decision 17's factory
      // selection (the row's impl), not the gated NGM generation switch.
      const action = argv[1];
      const workspace = valueAfter(argv, "--workspace") ?? process.cwd();
      const home = nataliaHome();
      if (action === "list") {
        const rows = compositionRowViews();
        console.log(
          argv.includes("--json")
            ? JSON.stringify(rows, null, 2)
            : rows
                .map(
                  (row) =>
                    `${row.rowID} — ${row.legalSummary}${row.implIDs.length ? ` (impl ∈ ${row.implIDs.join(" | ")})` : ""}`,
                )
                .join("\n"),
        );
        break;
      }
      if (action === "status") {
        const status = await compositionStatus({ workspace, home });
        console.log(
          argv.includes("--json")
            ? JSON.stringify(status, null, 2)
            : compositionStatusLines(status).join("\n"),
        );
        break;
      }
      if (action === "apply") {
        const file = argv[2];
        if (!file)
          throw new Error("composition apply requires a patch file path");
        const result = await applyCompositionPatch({ file, workspace });
        console.log(
          [
            `applied ${result.rows.length} row(s) to ${result.file}`,
            ...result.rows.map((row) => `  ${row.id}`),
            "the workspace layer wins over the shipped base at the next boot or config reload",
          ].join("\n"),
        );
        break;
      }
      if (action === "switch") {
        const rowID = argv[2];
        if (!rowID)
          throw new Error(
            "composition switch requires a row id (see: natalia composition list)",
          );
        const result = await switchCompositionRow({
          rowID,
          impl: valueAfter(argv, "--impl"),
          workspace,
          disabled: argv.includes("--disabled") ? true : undefined,
        });
        console.log(
          `switched ${rowID} in ${result.file} (takes effect at the next boot or config reload)`,
        );
        break;
      }
      throw new Error(
        "composition <list|status|apply|switch> (decision 12's v1 face; see: natalia composition list)",
      );
    }

    case "session": {
      const action = argv[1] ?? "list";
      const workspaceRoot = valueAfter(argv, "--workspace");
      if (action === "list") {
        const sessions = await listLocalSessions(workspaceRoot);
        console.log(
          argv.includes("--json")
            ? JSON.stringify(sessions, null, 2)
            : sessionTable(sessions),
        );
        break;
      }
      if (action === "delete") {
        const id = argv[2];
        if (!id) throw new Error("session delete requires an ID");
        console.log(
          JSON.stringify(await deleteLocalSession(id, workspaceRoot), null, 2),
        );
        break;
      }
      if (action === "show") {
        const id = argv[2];
        if (!id) throw new Error("session show requires an ID");
        const result = await showLocalSession(id, workspaceRoot);
        console.log(
          argv.includes("--json")
            ? JSON.stringify(result, null, 2)
            : [
                `id: ${result.id}`,
                `title: ${result.title}`,
                `events: ${result.events}`,
                `pending inputs: ${result.pendingInputs}`,
                `pinned: ${result.pinned ? "yes" : "no"}`,
                `resumable: ${result.resumable ? "yes" : "no"}`,
              ].join("\n"),
        );
        break;
      }
      if (action === "rename") {
        const id = argv[2];
        const workspaceIndex = argv.indexOf("--workspace");
        const title = argv
          .slice(3, workspaceIndex >= 0 ? workspaceIndex : undefined)
          .join(" ");
        if (!id || !title)
          throw new Error("session rename requires an ID and title");
        console.log(
          JSON.stringify(
            await renameLocalSession(id, title, workspaceRoot),
            null,
            2,
          ),
        );
        break;
      }
      if (action === "pin" || action === "unpin") {
        const id = argv[2];
        if (!id) throw new Error(`session ${action} requires an ID`);
        console.log(
          JSON.stringify(
            await setLocalSessionPinned(id, action === "pin", workspaceRoot),
            null,
            2,
          ),
        );
        break;
      }
      if (action === "duplicate") {
        const id = argv[2];
        if (!id) throw new Error("session duplicate requires an ID");
        console.log(
          JSON.stringify(
            await duplicateLocalSession(id, {
              title: valueAfter(argv, "--title"),
              newID: valueAfter(argv, "--id"),
              workspaceRoot,
            }),
            null,
            2,
          ),
        );
        break;
      }
      if (action === "export") {
        const id = argv[2];
        if (!id) throw new Error("session export requires an ID");
        console.log(
          JSON.stringify(
            await exportLocalSessionMetadata(id, workspaceRoot),
            null,
            2,
          ),
        );
        break;
      }
      if (action === "import") {
        const raw = argv[2];
        if (!raw)
          throw new Error("session import requires a metadata JSON value");
        const bundle = JSON.parse(
          raw,
        ) as import("./index").SessionMetadataBundle;
        console.log(
          JSON.stringify(
            await importLocalSessionMetadata(bundle, {
              workspaceRoot,
              id: valueAfter(argv, "--id"),
              title: valueAfter(argv, "--title"),
            }),
            null,
            2,
          ),
        );
        break;
      }
      throw new Error(`unknown session action: ${action}`);
    }

    case "fs": {
      const action = argv[1] as "list" | "read" | "glob" | "search" | undefined;
      if (!action || !["list", "read", "glob", "search"].includes(action))
        throw new Error("fs requires list, read, glob, or search");
      const positional = argv.filter(
        (value, index) =>
          index > 1 &&
          !value.startsWith("--") &&
          argv[index - 1] !== "--workspace" &&
          argv[index - 1] !== "--path" &&
          argv[index - 1] !== "--include" &&
          argv[index - 1] !== "--limit",
      );
      console.log(
        JSON.stringify(
          await workspaceFilesystemCommand({
            action,
            workspaceRoot: valueAfter(argv, "--workspace"),
            path:
              valueAfter(argv, "--path") ??
              (action === "read" ? positional[0] : undefined),
            pattern: action === "glob" ? positional[0] : undefined,
            query: action === "search" ? positional[0] : undefined,
            include: valueAfter(argv, "--include"),
            offset: valueAfter(argv, "--offset")
              ? Number(valueAfter(argv, "--offset"))
              : undefined,
            limit: valueAfter(argv, "--limit")
              ? Number(valueAfter(argv, "--limit"))
              : undefined,
          }),
          null,
          2,
        ),
      );
      break;
    }
    case "trust": {
      const action = argv[1] as "list" | "remove" | undefined;
      const workspaceRoot = valueAfter(argv, "--workspace") ?? process.cwd();
      if (action === "list") {
        console.log(JSON.stringify(await trustList(workspaceRoot), null, 2));
        break;
      }
      if (action === "remove") {
        const key = argv[2];
        if (!key) throw new Error("trust remove requires a key");
        console.log(
          JSON.stringify(await trustRemove(workspaceRoot, key), null, 2),
        );
        break;
      }
      throw new Error("trust requires list or remove");
    }

    case "replay": {
      const cassettePath = argv[1];
      if (!cassettePath) throw new Error("replay requires a cassette path");
      const replay = createRecordedFetch({ mode: "replay", cassettePath });
      const cassette = await readCassette(cassettePath);
      console.log(
        `replaying ${cassette.interactions.length} recorded requests`,
      );
      for (const entry of cassette.interactions) {
        const response = await replay(entry.request.url, entry.request);
        console.log(
          `${entry.request.method} ${entry.request.url} -> ${response.status}`,
        );
      }
      break;
    }
  }
  return true;
}
