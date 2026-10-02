import { EGRESS_ADVISORY } from "@natalia/client";
import {
  createRuntimeDaemonStore,
  daemonToken,
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
  groupRunsByPrompt,
  scoreRun,
  segmentTurns,
} from "@natalia/engineering-intelligence";
import { createLocalSessionService } from "@anthelia/session-store";
import { consultRecords, consultSummary } from "@natalia/collaboration";
import { evalListLines, evalRun } from "./eval-cli";
import { createRecordedFetch, readCassette } from "@natalia/transport";
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
      "update",
    ]).has(subcommand ?? "")
  )
    return false;
  const configPath =
    process.env.NATALIA_CONFIG ?? `${process.cwd()}/.natalia/config.json`;
  switch (subcommand) {
    case "uninstall": {
      // The app-level uninstall takes NO arguments — and the dead
      // `uninstall <tool> --workspace` form must fail before anything
      // touches the filesystem (a CLI test asserts that exit, and an
      // argument-bearing call here would otherwise operate on the real
      // home while "succeeding").
      if (argv.slice(1).filter((arg) => !arg.startsWith("-")).length > 0) {
        console.error(
          "usage: natalia uninstall (the old top-level `uninstall <tool>` form is gone)",
        );
        process.exit(1);
      }
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
