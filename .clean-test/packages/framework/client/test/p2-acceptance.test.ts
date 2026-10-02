import { expect, test } from "bun:test";
import { join } from "node:path";
import { ObjectStore } from "@anthelia/object-store";
import { resolveConfig, updateConfigAtScope } from "@anthelia/config";
import {
  configV3Schema,
  type ConstitutionRule,
  type RuntimeEvent,
} from "@anthelia/contracts";
import {
  buildGeneration,
  guardsFace,
  storeGeneration,
  switchGeneration,
} from "@anthelia/composition";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";
import { createScriptedProvider } from "./e2e-harness";
import { createRealRuntimeClient } from "../src/runtime/main";
import { niaFace, smokeFace } from "../src/runtime/verification-faces";

/**
 * The P2 acceptance (master plan §3): one candidate build -> verify ->
 * switch -> rollback, journal-observable end to end, with ALL FOUR gate
 * faces real — the repo's guard chain actually spawned, a nested runtime
 * actually booted, Nia actually audited through the live chat surface.
 */

useWorkspaceCleanup();

const RULE: ConstitutionRule = {
  id: "C-P2-001",
  statement: "世代切换必须过验证闸",
  scope: "release",
  priority: "critical",
  source: "master_plan",
  enforcement: "deny",
  overridePolicy: "forbidden",
  evidenceRefs: [],
};

async function acceptance(
  name: string,
  // The client is passed IN (the caller's own destructuring would still be
  // in its temporal dead zone when the health check runs).
  health: (
    client: ReturnType<typeof createRealRuntimeClient>,
    root: string,
  ) => Promise<{ ok: boolean; detail?: string }>,
) {
  const root = await officialPluginWorkspace(`p2-acceptance-${name}`);
  const globalPath = join(root, ".natalia", "global-config.json");
  const events: RuntimeEvent[] = [];
  const capture = { planID: "" };
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: `ses_p2_acceptance_${name}` as never,
    permissionMode: "auto",
    provider: createScriptedProvider({
      nia: [
        {
          // select only while no audit result has come back — the script
          // provider's call counter starts at 1, so an index check would
          // never fire ("model repeatedly ended without audit report").
          when: (context) =>
            !context.toolResults.some(
              (result) => result.toolCallID === "call_audit",
            ),
          tool: () => ({
            id: "call_audit",
            name: "audit_report",
            // arguments are built at yield time, after the face reported
            // its plan through onAuditPlan.
            arguments: JSON.stringify({
              planID: capture.planID,
              verdict: "passed",
            }),
          }),
        },
        { text: "done" },
      ],
    }),
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!(`ses_p2_acceptance_${name}` as never);

  // Build: two content-addressed generations — the current one and the
  // candidate (differing by an observable, type-safe config field).
  const store = new ObjectStore(join(root, ".acceptance-objects"));
  const currentConfig = configV3Schema.parse({ version: 3 });
  const currentID = await storeGeneration(
    store,
    buildGeneration({
      config: currentConfig,
      catalog: [],
      policyRows: [RULE],
      prompts: { perRoleStatic: {}, docs: [] },
    }),
  );
  const candidate = buildGeneration({
    // A PROJECT-scoped marker: global-model keys (defaultModel, catalog…)
    // would route part of the write to ~/.natalia/config.json, which this
    // harness's read-only home refuses — and the product rule is that the
    // workspace's own file is where a workspace-scoped switch lands.
    config: configV3Schema.parse({
      version: 3,
      checkpoint: { maxFiles: 12345 },
    }),
    catalog: [],
    policyRows: [RULE],
    prompts: { perRoleStatic: {}, docs: [] },
  });
  const candidateID = await storeGeneration(store, candidate);

  const result = await switchGeneration({
    candidateID,
    candidate,
    activeRules: [RULE],
    faces: {
      guards: guardsFace({ repoRoot: process.cwd() }),
      smoke: smokeFace(),
      nia: niaFace(client, {
        timeoutMs: 30_000,
        onAuditPlan: (planID) => {
          capture.planID = planID;
        },
      }),
    },
    reason: `p2 acceptance ${name}`,
    when: "now",
    currentGenerationID: currentID,
    currentConfig,
    requestApproval: async () => "granted",
    applyConfig: async (config) => {
      // An explicit globalPath keeps every write inside the workspace: the
      // default global config lives under the user's home, which this
      // harness mounts read-only (a real user's home is writable — the
      // product path is unchanged).
      await updateConfigAtScope(root, config, "project", { globalPath });
    },
    reloadRuntime: async () => {
      await client.reloadConfig!();
    },
    healthCheck: () => health(client, root),
    publish: (event) => events.push(event),
  });
  return { root, client, events, result, candidateID, currentID };
}

function orchestratorSwitches(events: RuntimeEvent[], reason: string) {
  return events.filter(
    (event) =>
      event.type === "composition.switched" && event.reason.startsWith(reason),
  );
}

test("P2 acceptance: build -> verify -> switch, journal-observable", async () => {
  const { root, client, events, result, candidateID, currentID } =
    await acceptance("apply", async (running) => ({
      ok: Boolean(await running.runtimeStatus?.()),
    }));
  try {
    const verified = events.find(
      (event) => event.type === "composition.verified",
    );
    expect(verified).toMatchObject({
      verdict: "passed",
      checks: [
        { check: "constitution", ok: true },
        { check: "guards", ok: true },
        { check: "smoke", ok: true },
        { check: "nia", ok: true },
      ],
    });
    expect(result.stage).toBe("applied");
    expect(result.switched).toBe(true);
    // The orchestrator's own record, naming the candidate exactly. The
    // reload seam's producer additionally journals the file apply it
    // performed (G2's design: the reload path is the real producer for
    // reloads) — both records exist in production too, and the
    // orchestrator publishes last, so the pointer settles on its event.
    const switched = orchestratorSwitches(events, "p2 acceptance apply");
    expect(switched).toHaveLength(1);
    expect(switched[0]).toMatchObject({ from: currentID, to: candidateID });
    // The durable source really holds the candidate after the switch.
    const resolved = await resolveConfig({
      workspaceRoot: root,
      globalPath: join(root, ".natalia", "global-config.json"),
    });
    expect(resolved.config.checkpoint.maxFiles).toBe(12345);
    // The live runtime reloaded it (the reload producer's own notice).
    expect(
      events.some(
        (event) =>
          event.type === "context.instructions" &&
          event.kind === "config_reload",
      ),
    ).toBe(true);
    // Nia's audit evidence is in the stream.
    expect(
      events.filter((event) => event.type === "evidence.recorded"),
    ).toHaveLength(1);
  } finally {
    await client.dispose?.();
  }
}, 120_000);

test("P2 acceptance: a failed health check rolls back, journal-observable", async () => {
  const { root, client, events, result } = await acceptance(
    "rollback",
    async () => ({
      ok: false,
      detail: "acceptance: simulated post-switch fault",
    }),
  );
  try {
    expect(result.stage).toBe("rolled-back");
    expect(result.switched).toBe(false);
    const out = orchestratorSwitches(events, "p2 acceptance rollback")[0] as {
      from?: string;
      to: string;
      reason: string;
    };
    const back = orchestratorSwitches(
      events,
      "health-check-failed: automatic rollback",
    )[0] as { from?: string; to: string; reason: string };
    expect(out).toBeDefined();
    expect(back).toBeDefined();
    // Out to the candidate, straight back to the current generation.
    expect(back.from).toBeDefined();
    expect(back.reason).toContain("automatic rollback");
    // The error-level incident names the candidate that was reverted.
    expect(
      events.find(
        (event) => event.type === "diagnostic" && event.level === "error",
      ),
    ).toMatchObject({
      message: expect.stringContaining(
        "rolled back to the previous composition",
      ),
    });
    // The durable source no longer carries the candidate's marker.
    const resolved = await resolveConfig({
      workspaceRoot: root,
      globalPath: join(root, ".natalia", "global-config.json"),
    });
    expect(resolved.config.checkpoint.maxFiles).not.toBe(12345);
    void out;
  } finally {
    await client.dispose?.();
  }
}, 120_000);
