import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { countFullContentReads, type FullReadClass } from "./full-events-reads";

/**
 * The RINA study's acceptance #1 as a LIVE INVENTORY: every content
 * read of the session's full event array is named, counted and
 * CLASSIFIED — the study's taxonomy enforced by drift detection rather
 * than by hope. A new read without a deliberate inventory edit goes
 * red; a changed count — including a count that fell to zero — goes
 * red too (the table tracks reality in both directions: a file that
 * stopped reading the array moved the surface as much as one that
 * started).
 *
 * The classes and their notes are the acceptance itself:
 *   explicit-history  — behind ensure/complete in the same function
 *   state-first       — the fact fold answers, the resident array is
 *                       only the emergency belt (the boundary's shape)
 *   paged-mechanism   — the completion/window machinery's own reads
 *   derivation        — a change-signal/revision over what is resident
 *   fold-direct       — NAMED DEBT: a pre-facts domain folding the
 *                       resident journal (correctness under a fast
 *                       attach awaits its fact twin — counted, never
 *                       silently assumed)
 */

type InventoryEntry = { count: number; cls: FullReadClass; note: string };

export const FULL_READ_INVENTORY: Readonly<Record<string, InventoryEntry>> = {
  "packages/domains/collab/src/chat-tools.ts": {
    count: 1,
    cls: "state-first",
    note: "mailbox projection: fact fold first, resident fallback",
  },
  "packages/domains/collab/src/chat.ts": {
    count: 5,
    cls: "explicit-history",
    note: "chat log pages + rollback scans behind ensureSessionFullEvents — the study's sanctioned class",
  },
  "packages/domains/collab/src/chat-prompt.ts": {
    count: 12,
    cls: "state-first",
    note: "the live-context builders pass the events into fact-first helpers (mailbox/collab/drift/decision/constitution ternaries); the audit/constitution-check display folds read the diagnostic slice through diagnosticStreamFor (paid since the slice rollout)",
  },
  "packages/domains/collab/src/chat-turn-common.ts": {
    count: 4,
    cls: "state-first",
    note: "provider-history ternaries (fact fold -> resident projection); the fourth is chatHistoryEvents, which must read the SAME events the tool-call pairing looks at so the pairing cannot describe a different window than the fold",
  },
  "packages/domains/collab/src/collab-snapshot.ts": {
    count: 1,
    cls: "paged-mechanism",
    note: "reads only after await completeSessionFactState (the completion machinery itself)",
  },
  "packages/domains/collab/src/mailbox-plans.ts": {
    count: 1,
    cls: "explicit-history",
    note: "enqueue anchors the whole mailbox behind its ensure (wake lifecycle)",
  },
  "packages/domains/collab/src/mailbox.ts": {
    count: 1,
    cls: "state-first",
    note: "fact fold -> worker-backed projection fallback",
  },
  "packages/domains/collab/src/boundary.ts": {
    count: 2,
    cls: "derivation",
    note: "the reconcile path's two remaining reads are windowed/backward scans (drift behaviour signals, last narration) — tail-correct by design; its constitution/workContracts/goal constraints and invariant/instruction triggers are fact-first through driftJudgeReadsFor (belt = the ?? [] empty-default, uncounted)",
  },
  "packages/domains/collab/src/plan-contract-tools.ts": {
    count: 6,
    cls: "state-first",
    note: "constitution/work-contract/drift ternaries + two request-marker scans counted with them",
  },
  "packages/domains/engineering-intelligence/src/intelligence.ts": {
    count: 26,
    cls: "state-first",
    note: "the EI folds are fact-first with resident fallbacks; one store.history paged read, the override-grant merge (instance + session, deduped by id), the growth branch's folds (the completions/unbacked-task derivation's reads, the writer's idempotence guard, the proposal reader), the prompt-run-groups scorer (segmentTurns/scoreRun/groupRunsByPrompt — a defensive replay fold, no fork), the external-benchmark folds (the internal aggregate beside the baseline, the join record's turn-window read, the join reader), the correction-patterns read (the three safe sources clustered), and the promotion's reads (the triggers' assembly's own facts, the writer's idempotence guard, the promotions reader) ride the same class family",
  },
  "packages/domains/goal-runtime/src/goal-runtime.ts": {
    count: 5,
    cls: "state-first",
    note: "the service reads take the durable view from the completed fact state (pre-epoch goals visible under a fast attach); the resident array is the belt",
  },
  "packages/domains/goal-runtime/src/goal-tools.ts": {
    count: 1,
    cls: "state-first",
    note: "the tool face reads the same durable view; the belt rides along",
  },
  "packages/framework/client/src/runtime/session-execution/sessions.ts": {
    count: 1,
    cls: "paged-mechanism",
    note: "the load/restore path hands the loaded record's events to the factory (the machinery itself)",
  },
  "packages/framework/client/src/runtime/tool-execution/execute-calls.ts": {
    count: 2,
    cls: "state-first",
    note: "constitution + override ternaries in the tool pipeline",
  },
  "packages/framework/client/src/runtime/initialize/framework-services.ts": {
    count: 2,
    cls: "state-first",
    note: "resident-defaults and a telemetry field pass in the wire",
  },
  "packages/framework/client/src/runtime/composition/foundation.ts": {
    count: 1,
    cls: "state-first",
    note: "the project-grant restore fold's source: the collab fact slice when complete, the resident tail as the belt (the collaborationEventsFor accessor, one layer over)",
  },
  "packages/framework/client/src/runtime/composition/execution.ts": {
    count: 1,
    cls: "explicit-history",
    note: "the self-review's violations input: D1/D2's invariant.violation facts behind ensureSessionFullEvents — the study's sanctioned class",
  },
  "packages/framework/client/src/runtime/terminal-runtime/native-terminal.ts": {
    count: 1,
    cls: "state-first",
    note: "resident-default for the terminal's projection input",
  },
  "packages/framework/client/src/runtime/provider-selection/selection.ts": {
    count: 2,
    cls: "derivation",
    note: "the context-instructions revision: a change-signal over what is resident",
  },
  "packages/framework/client/src/runtime/sandbox-runtime.ts": {
    count: 1,
    cls: "state-first",
    note: "resident-default for the sandbox projection",
  },
  "packages/framework/client/src/runtime/snapshot.ts": {
    count: 2,
    cls: "state-first",
    note: "snapshot assembly prefers the hot state, projects the resident tail otherwise",
  },
  "packages/framework/client/src/runtime/subagent-runtime.ts": {
    count: 3,
    cls: "explicit-history",
    note: "subagent history pages behind its ensure (the inspector face)",
  },
  "packages/framework/client/src/runtime/turn-runner.ts": {
    count: 1,
    cls: "state-first",
    note: "collab messages: snapshot/fact first, resident projection otherwise",
  },
  "packages/framework/client/src/runtime/work-graph-tools.ts": {
    count: 2,
    cls: "state-first",
    note: "work-graph queries read facts when complete (the window edge falls back)",
  },
  "packages/framework/client/src/runtime/session-attach.ts": {
    count: 2,
    cls: "derivation",
    note: "attach-time scans (seq anchoring + a revision walk) over the resident tail by design",
  },
  "packages/framework/client/src/runtime/event-sink.ts": {
    count: 6,
    cls: "derivation",
    note: "wake/audit gates: presence derivations over what the sink just wrote",
  },
  "packages/framework/client/src/runtime/config-reload.ts": {
    count: 2,
    cls: "derivation",
    note: "a revision + a rules projection feeding the reload",
  },
  "packages/framework/client/src/runtime/record-tools.ts": {
    count: 1,
    cls: "state-first",
    note: "drift-acknowledge answers from the completed fact fold (resident projection = the belt)",
  },
  "packages/framework/substrate/src/session-audit-scan.ts": {
    count: 2,
    cls: "paged-mechanism",
    note: "the audit scan's own paged store read + its resident-tail union — the shared fix the two fold-direct debts named",
  },
  "packages/framework/substrate/src/session-event-window.ts": {
    count: 8,
    cls: "paged-mechanism",
    note: "the window's own paged reads + its sanctioned ensure fallbacks",
  },
  "packages/framework/substrate/src/session-facts.ts": {
    count: 4,
    cls: "paged-mechanism",
    note: "the fact state's seeding and paged completion — the machinery itself",
  },
};

/**
 * The inventory defaults to the repository's own table; the parameter is
 * the test seam — a small fixture inventory proves every branch (clean,
 * unclassified read, count drift, vanished source) against a tmp tree.
 */
export async function findFullReadInventoryViolations(
  repoRoot: string,
  inventory: Readonly<Record<string, InventoryEntry>> = FULL_READ_INVENTORY,
): Promise<string[]> {
  const failures: string[] = [];
  const seen = new Set<string>();

  async function walk(dir: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const full = join(dir, entry.name);
      if (entry.isDirectory()) {
        // test trees are fixtures (the house rule: every guard exempts
        // them as such) — the acceptance binds PRODUCTION sources.
        if (/(?:^|[\\/])test(?:[\\/]|$)/u.test(entry.name)) continue;
        await walk(full);
      } else if (
        /\.(?:ts|tsx)$/u.test(entry.name) &&
        !/\.(?:test|spec)\.[cm]?tsx?$/u.test(entry.name)
      ) {
        const rel = full.slice(repoRoot.length + 1);
        seen.add(rel);
        const text = await Bun.file(full)
          .text()
          .catch(() => undefined);
        if (text === undefined) continue;
        const actual = countFullContentReads(text);
        const expected = inventory[rel];
        if (!expected) {
          if (actual > 0)
            failures.push(
              `${rel}: ${actual} full-event content read(s) with no inventory entry — classify it (explicit-history | state-first | paged-mechanism | derivation | fold-direct) and add it to FULL_READ_INVENTORY with a note`,
            );
        } else if (expected.count !== actual)
          failures.push(
            `${rel}: ${actual} content read(s), inventory says ${expected.count} [${expected.cls}] — the acceptance surface moved: fix the reads or update the inventory deliberately, with its note`,
          );
      }
    }
  }

  await walk(join(repoRoot, "packages"));
  await walk(join(repoRoot, "apps"));
  for (const rel of Object.keys(inventory))
    if (!seen.has(rel))
      failures.push(
        `${rel}: in the inventory (${inventory[rel]!.count}, ${inventory[rel]!.cls}) but no such source exists — prune the entry`,
      );
  return failures;
}
