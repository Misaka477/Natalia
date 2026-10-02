import { expect, test } from "bun:test";
import { join } from "node:path";
import { ObjectStore } from "@anthelia/object-store";
import { resolveConfig } from "@anthelia/config";
import { configV3Schema } from "@anthelia/contracts";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  buildGeneration,
  loadGeneration,
  storeGeneration,
} from "@anthelia/composition";
import { resolveWorkspaceObjectsRoot } from "@anthelia/platform";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";
import {
  createScriptedProvider,
  waitFor,
  type ScriptStep,
} from "./e2e-harness";
import { createRealRuntimeClient } from "../src/runtime/main";

/**
 * The L2 tool surface (NGM study §4.4) end to end through the real
 * runtime: propose -> apply (four-face gate, the tool floor asking the
 * human) -> rollback (always allowed). All gates run their real faces;
 * the scripted Nia reports on whatever plan the audit face files.
 */

useWorkspaceCleanup();

const globalPathFor = (root: string) =>
  // eslint-disable-next-line no-restricted-syntax -- mirrors the tool's apply seam
  `${root}/.natalia/global-config.json`;

async function makeWorkspace(name: string): Promise<string> {
  return await officialPluginWorkspace(`generation-tools-${name}`);
}

async function bootOn(
  root: string,
  sessionName: string,
  steps: ScriptStep[],
  audits = 0,
) {
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: `ses_generation_tools_${sessionName}` as never,
    permissionMode: "auto",
    // Hermetic config source: the tool's apply seam writes through the
    // runtime's own global path, which must not be the (read-only here)
    // user home.
    globalConfigPath: join(root, ".natalia", "global-config.json"),
    provider: createScriptedProvider({
      main: steps,
      nia: [
        ...Array.from({ length: audits }, () => ({
          tool: (context: { request: { messages?: unknown } }) => {
            // The tool path builds its audit face internally, so there is
            // no capture seam to read — the plan id lives in Nia's own
            // context (the face's message anchors it as planID=<id>; the
            // runtime context's Active plan line is the fallback — a bare
            // /plan_/ matches the TOOL names in her persona prompt, which
            // is how `plan_doc_write` was once reported as the plan id).
            const text = JSON.stringify(context.request.messages ?? []);
            // LAST match wins: a reopened thread carries the PREVIOUS
            // session's audit messages too, and auditing the stale id
            // leaves the live plan unreported (the face then times out).
            const anchored = [
              ...text.matchAll(/planID=(plan_[A-Za-z0-9_.:-]+)/gu),
            ];
            const active = [
              ...text.matchAll(/Active plan: (plan_[^ \u00b7\n"]+)/gu),
            ];
            const match = anchored.at(-1) ?? active.at(-1);
            // The face's sentence ends with a period — a phantom id like
            // "...tq." updates nothing and the runner then reports she
            // "ended without audit report".
            const planID = match?.[1].replace(/\.$/u, "");
            if (!planID)
              return {
                id: "call_audit",
                name: "audit_report",
                arguments: JSON.stringify({
                  planID: `probe-no-plan-id:${text.slice(0, 400)}`,
                  verdict: "passed",
                }),
              };
            return {
              id: "call_audit",
              name: "audit_report",
              arguments: JSON.stringify({ planID, verdict: "passed" }),
            };
          },
        })),
        { text: "done" },
      ],
    }),
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!(`ses_generation_tools_${sessionName}` as never);
  // One submit drives the whole linear script — a boot without a turn
  // would run nothing at all.
  await client.submitAndWait!("run the scripted generation flow");
  return { client, events };
}

async function boot(
  name: string,
  steps: ScriptStep[] | ((root: string) => Promise<ScriptStep[]>),
  audits = 0,
) {
  const root = await makeWorkspace(name);
  const resolved = typeof steps === "function" ? await steps(root) : steps;
  const { client, events } = await bootOn(root, name, resolved, audits);
  return { root, client, events };
}

function toolResults(events: RuntimeEvent[]) {
  return events.filter(
    (event) =>
      event.type === "tool.update" &&
      event.status === "succeeded" &&
      typeof event.result === "string",
  ) as Array<{ name: string; result: string }>;
}

function switched(events: RuntimeEvent[]) {
  return events.filter(
    (event) => event.type === "composition.switched",
  ) as Array<{ from?: string; to: string; reason: string }>;
}

test("the generation tools register with their governance declared", async () => {
  const { client, events } = await boot("registered", [{ text: "hello" }]);
  try {
    const registered = events.filter(
      (event) =>
        event.type === "tool.registered" &&
        [
          "propose_generation",
          "apply_generation",
          "rollback_generation",
        ].includes((event as { name: string }).name),
    ) as Array<{ name: string; requiresApproval: boolean }>;
    expect(registered).toHaveLength(3);
    const byName = new Map(registered.map((event) => [event.name, event]));
    // The study's governance: apply confirms with the human (floor),
    // propose proposes, rollback is always allowed.
    expect(byName.get("apply_generation")?.requiresApproval).toBe(true);
    expect(byName.get("propose_generation")?.requiresApproval).toBe(false);
    expect(byName.get("rollback_generation")?.requiresApproval).toBe(false);
  } finally {
    await client.dispose?.();
  }
}, 60_000);

test("propose stores the candidate, journals the proposal, reports impact", async () => {
  const { root, client, events } = await boot("propose", [
    {
      tool: () => ({
        id: "propose",
        name: "propose_generation",
        arguments: {
          configPatch: { checkpoint: { maxFiles: 4321 } },
          plugins: [],
          note: "raise the checkpoint file ceiling for large workspaces",
        },
      }),
    },
    { text: "done" },
  ]);
  try {
    const proposal = events.find(
      (event) => event.type === "composition.proposed",
    );
    expect(proposal).toMatchObject({
      reason: "raise the checkpoint file ceiling for large workspaces",
    });
    const candidateID = (proposal as { candidateID: string }).candidateID;
    // The stored candidate really carries the merged config.
    const store = new ObjectStore(resolveWorkspaceObjectsRoot(root));
    const generation = await loadGeneration(store, candidateID);
    expect(generation.config.checkpoint.maxFiles).toBe(4321);
    // The result told the caller what the change would touch.
    const result = toolResults(events).find(
      (entry) => entry.name === "propose_generation",
    );
    expect(JSON.parse(result!.result)).toMatchObject({
      candidateID,
      effect: expect.stringContaining("next session"),
    });
  } finally {
    await client.dispose?.();
  }
}, 60_000);

test("apply defaults to the next session: durable, not live, not switched", async () => {
  const { root, client, events } = await boot(
    "deferred",
    [
      {
        tool: () => ({
          id: "propose",
          name: "propose_generation",
          arguments: {
            configPatch: { checkpoint: { maxFiles: 4321 } },
            note: "deferred apply candidate",
          },
        }),
      },
      {
        tool: (context) => {
          const proposed = context.toolResults.find(
            (entry) => entry.toolName === "propose_generation",
          );
          if (!proposed) return undefined;
          const { candidateID } = JSON.parse(proposed.content) as {
            candidateID: string;
          };
          return {
            id: "apply",
            name: "apply_generation",
            arguments: { candidateID },
          };
        },
      },
      { text: "done" },
    ],
    1,
  );
  try {
    // Wire the audit plan id into the scripted Nia (the face reports it
    // before waking her).
    const result = toolResults(events).find(
      (entry) => entry.name === "apply_generation",
    );
    expect(result).toBeDefined();
    const parsed = JSON.parse(result!.result) as {
      stage: string;
      verdict: { result: string };
    };
    expect(parsed.verdict.result).toBe("passed"); // all four real faces
    expect(parsed.stage).toBe("deferred");
    // Durable: the workspace config holds the candidate.
    const resolved = await resolveConfig({
      workspaceRoot: root,
      globalPath: globalPathFor(root),
    });
    expect(resolved.config.checkpoint.maxFiles).toBe(4321);
    // Not live yet: no switch was claimed.
    expect(switched(events)).toHaveLength(0);
  } finally {
    await client.dispose?.();
  }
}, 120_000);

test("propose -> apply now -> apply now -> rollback restores the first candidate", async () => {
  // One session per gate: the pointer lives in the SESSION's journal, and
  // the workspace's session store persists across reopens — so each
  // provider needs only one Nia audit step (the linear script cursor has
  // no way to tell an audit wake from a content round otherwise), and the
  // rollback reads the persisted pointer through the real recovery path.
  const root = await makeWorkspace("flow");
  const open: Array<{ dispose?: () => Promise<void> }> = [];
  try {
    const proposeStep = (
      marker: number,
      note: string,
      id: string,
    ): ScriptStep => ({
      tool: () => ({
        id,
        name: "propose_generation",
        arguments: {
          configPatch: { checkpoint: { maxFiles: marker } },
          note,
        },
      }),
    });
    const applyStep = (
      proposeID: string,
      applyID: string,
      reason: string,
    ): ScriptStep => ({
      tool: (context) => {
        const proposed = context.toolResults.find(
          (entry) => entry.toolName === "propose_generation",
        );
        if (!proposed) return undefined;
        const { candidateID } = JSON.parse(proposed.content) as {
          candidateID: string;
        };
        return {
          id: applyID,
          name: "apply_generation",
          arguments: { candidateID, now: true, reason },
        };
      },
    });
    void proposeStep;
    void applyStep;

    // Session 1: candidate A applied live.
    const first = await bootOn(
      root,
      "flow",
      [
        {
          tool: () => ({
            id: "propose-a",
            name: "propose_generation",
            arguments: {
              configPatch: { checkpoint: { maxFiles: 4321 } },
              note: "first candidate",
            },
          }),
        },
        {
          tool: (context) => {
            const proposed = context.toolResults.find(
              (entry) => entry.toolName === "propose_generation",
            );
            if (!proposed) return undefined;
            const { candidateID } = JSON.parse(proposed.content) as {
              candidateID: string;
            };
            return {
              id: "apply-a",
              name: "apply_generation",
              arguments: { candidateID, now: true, reason: "flow apply a" },
            };
          },
        },
        { text: "done" },
      ],
      1,
    );
    const appliedA = JSON.parse(
      toolResults(first.events)
        .filter((entry) => entry.name === "apply_generation")
        .at(-1)!.result,
    ) as { stage: string };
    expect(appliedA.stage).toBe("applied");
    const aSwitch = switched(first.events).find(
      (event) => event.reason === "flow apply a",
    );
    expect(aSwitch).toBeDefined();
    // Disposing flushes the session journal to the store — the reopened
    // session below must SEE this switch, so the flush happens before the
    // next attach (the finally-dispose is only the failure safety net).
    await first.client.dispose?.();
    open.splice(open.indexOf(first.client), 1);

    // Session 2 (same session id, reopened): candidate B applied live on
    // top of A — the persisted pointer supplies A as the from-link.
    const second = await bootOn(
      root,
      "flow",
      [
        {
          tool: () => ({
            id: "propose-b",
            name: "propose_generation",
            arguments: {
              configPatch: { checkpoint: { maxFiles: 8765 } },
              note: "second candidate",
            },
          }),
        },
        {
          tool: (context) => {
            const proposed = context.toolResults.find(
              (entry) => entry.toolName === "propose_generation",
            );
            if (!proposed) return undefined;
            const { candidateID } = JSON.parse(proposed.content) as {
              candidateID: string;
            };
            return {
              id: "apply-b",
              name: "apply_generation",
              arguments: { candidateID, now: true, reason: "flow apply b" },
            };
          },
        },
        { text: "done" },
      ],
      1,
    );
    const appliedB = JSON.parse(
      toolResults(second.events)
        .filter((entry) => entry.name === "apply_generation")
        .at(-1)!.result,
    ) as { stage: string };
    expect(appliedB.stage).toBe("applied");
    const bSwitch = switched(second.events).find(
      (event) => event.reason === "flow apply b",
    );
    expect(bSwitch).toBeDefined();
    expect(bSwitch!.from).toBe(aSwitch!.to);
    await second.client.dispose?.();
    open.splice(open.indexOf(second.client), 1);

    // Session 3 (reopened again): rollback with no steps beyond it —
    // default target = previous = A.
    const third = await bootOn(
      root,
      "flow",
      [
        {
          tool: { id: "rollback", name: "rollback_generation", arguments: {} },
        },
        { text: "done" },
      ],
      0,
    );
    const rollback = JSON.parse(
      toolResults(third.events).find(
        (entry) => entry.name === "rollback_generation",
      )!.result,
    ) as { switched: boolean; to: string; from?: string };
    expect(rollback.switched).toBe(true);
    expect(rollback.to).toBe(aSwitch!.to);
    expect(rollback.from).toBe(bSwitch!.to);
    const back = switched(third.events).find((event) =>
      event.reason.includes("rollback"),
    );
    expect(back).toMatchObject({
      from: bSwitch!.to,
      to: aSwitch!.to,
    });
    // The durable source ends on A's marker.
    const resolved = await resolveConfig({
      workspaceRoot: root,
      globalPath: globalPathFor(root),
    });
    expect(resolved.config.checkpoint.maxFiles).toBe(4321);
  } finally {
    for (const client of open) await client.dispose?.();
    // Workspace + plugin-store removal is the registered sweep's job
    // (useWorkspaceCleanup) — a manual rm would miss the store sibling.
  }
}, 240_000);

test("a candidate that drops a forbidden rule fails the gate at the tool", async () => {
  const { root, client, events } = await boot(
    "gate-teeth",
    async (workspace) => {
      // The propose tool always carries the active rows — only a forged
      // candidate can test the teeth, so it is stored up front.
      const store = new ObjectStore(resolveWorkspaceObjectsRoot(workspace));
      const id = await storeGeneration(
        store,
        buildGeneration({
          config: configV3Schema.parse({
            version: 3,
            checkpoint: { maxFiles: 1111 },
          }),
          catalog: [],
          policyRows: [], // drops every active forbidden rule
          prompts: { perRoleStatic: {}, docs: [] },
        }),
      );
      return [
        {
          tool: () => ({
            id: "apply-bad",
            name: "apply_generation",
            arguments: { candidateID: id, now: true },
          }),
        },
        { text: "done" },
      ];
    },
    1,
  );
  try {
    const result = toolResults(events).find(
      (entry) => entry.name === "apply_generation",
    );
    expect(result).toBeDefined();
    expect(JSON.parse(result!.result)).toMatchObject({
      switched: false,
      stage: "gate-failed",
    });
    expect(switched(events)).toHaveLength(0);
    const resolved = await resolveConfig({
      workspaceRoot: root,
      globalPath: globalPathFor(root),
    });
    expect(resolved.config.checkpoint.maxFiles).not.toBe(1111);
  } finally {
    await client.dispose?.();
  }
}, 120_000);

test("rollback with no history says so instead of inventing a target", async () => {
  const { client, events } = await boot("no-history", [
    { tool: { id: "rollback", name: "rollback_generation", arguments: {} } },
    { text: "done" },
  ]);
  try {
    const result = toolResults(events).find(
      (entry) => entry.name === "rollback_generation",
    );
    expect(result).toBeDefined();
    expect(result!.result).toContain("no previous generation");
    expect(switched(events)).toHaveLength(0);
  } finally {
    await client.dispose?.();
  }
}, 60_000);
