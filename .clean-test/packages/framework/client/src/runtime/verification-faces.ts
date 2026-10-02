import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Generation, RuntimeEvent, SessionID } from "@anthelia/contracts";
import type {
  VerificationCheck,
  VerificationFace,
} from "@anthelia/composition";
import type { StreamingProvider } from "@anthelia/runtime";
import { configV3Schema } from "@anthelia/contracts";
import { resolveConfig } from "@anthelia/config";
import { createRealRuntimeClient } from "./main";

/**
 * The sandbox smoke face of the verification gate (NGM study §4.3):
 * boot an isolated runtime with the CANDIDATE's config, run one trivial
 * turn, and report healthy only when the candidate actually loaded.
 *
 * The isolation is a throwaway workspace plus the candidate's own
 * confinement mode — the smoke is subject to the policy it is testing.
 * The health criterion includes the subtle half: the runtime swallows a
 * config-resolution failure by design (it falls back to defaults with a
 * warning), so a smoke that ignored that warning would happily "pass"
 * while having booted defaults — smoking nothing at all.
 */

/** A provider that answers any prompt with a fixed string and finishes. */
function smokeProvider(): StreamingProvider {
  return {
    provider: "composition-smoke",
    model: "composition-smoke-model",
    async *stream() {
      yield { type: "content", text: "ok" };
      yield { type: "done" };
    },
  };
}

async function waitForSignal(
  events: RuntimeEvent[],
  predicate: (event: RuntimeEvent) => boolean,
  timeoutMs: number,
  label: string,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (events.some(predicate)) return;
    await new Promise((resolve) => setTimeout(resolve, 20));
  }
  throw new Error(`${label} did not arrive within ${timeoutMs}ms`);
}

export function smokeFace(options: { timeoutMs?: number } = {}) {
  const timeoutMs = options.timeoutMs ?? 60_000;
  const face: VerificationFace = async (generation: Generation) => {
    const base = await mkdtemp(join(tmpdir(), "composition-smoke-"));
    const workspaceRoot = join(base, "workspace");
    const configPath = join(base, "config.json");
    await mkdir(workspaceRoot, { recursive: true });
    await writeFile(configPath, JSON.stringify(generation.config, null, 2));
    const events: RuntimeEvent[] = [];
    let client: ReturnType<typeof createRealRuntimeClient> | undefined;
    try {
      // Strict schema validation first. Two real holes make this the
      // smoke's job rather than a formality: loadGeneration does not
      // deep-validate a stored generation's config (a corrupted or forged
      // object parses), and the runtime deliberately swallows config errors
      // (a config error must never kill a running session) — so neither the
      // store nor the boot would ever say the candidate's config is invalid.
      try {
        configV3Schema.parse(generation.config);
      } catch (error) {
        return {
          check: "smoke",
          ok: false,
          detail: `candidate config invalid: ${error instanceof Error ? error.message : String(error)}`,
        };
      }
      // Resolution failures are recorded per scope (`applied: false` +
      // diagnostic) rather than thrown, so the face checks the scope
      // directly: a candidate whose file did not load must not be smoked
      // against defaults.
      const resolved = await resolveConfig({
        workspaceRoot,
        globalPath: configPath,
      });
      const globalSource = resolved.sources.find(
        (source) => source.scope === "global",
      );
      if (!globalSource?.applied)
        return {
          check: "smoke",
          ok: false,
          detail: `candidate config did not load: ${globalSource?.diagnostic ?? "global scope not applied"}`,
        };
      client = createRealRuntimeClient({
        sessionID: `ses_smoke_${Date.now().toString(36)}` as SessionID,
        workspaceRoot,
        globalConfigPath: configPath,
        provider: smokeProvider(),
        // Hermetic store paths: the smoke owns a throwaway home.
        checkpointDir: join(base, "checkpoints"),
        sessionDir: join(base, "sessions"),
        // Approval prompts would park the gate on a human; the smoke proves
        // the candidate boots and answers, not that a human is willing to.
        permissionMode: "auto",
      });
      client.start((event) => events.push(event));
      await waitForSignal(
        events,
        (event) => event.type === "session.ready",
        timeoutMs,
        "session.ready",
      );
      if (typeof client.submitAndWait !== "function")
        return {
          check: "smoke",
          ok: false,
          detail: "runtime exposes no submitAndWait — cannot prove a turn",
        };
      await client.submitAndWait("smoke: reply with a short ok.");
      return { check: "smoke", ok: true };
    } catch (error) {
      return {
        check: "smoke",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      } satisfies VerificationCheck;
    } finally {
      try {
        await client?.dispose?.();
      } catch {
        /* disposal failure must not mask the verdict */
      }
      await rm(base, { recursive: true, force: true });
    }
  };
  return face;
}

/**
 * The Nia audit face of the verification gate (study §4.3's audit face:
 * "只读审计候选组成,audit_report verdict=passed + evidence 落盘").
 *
 * It reuses the existing plan-audit machinery end to end rather than
 * inventing a target type for audit_report: the candidate is written as a
 * plan document, Nia is asked through the same Nia chat surface a user
 * would use, and her audit_report flips the plan's status — which the face
 * polls. The audit round checkpoint and evidence.recorded event her report
 * produces are the evidence trail, already in the journal.
 */
/**
 * What the audit face actually needs — the full client satisfies it, and
 * so does a runtime tool assembling the same surfaces from its context
 * (ports.planDocRuntime + the Nia chat surface).
 */
export type NiaFaceSurfaces = {
  planDocWrite?: (input: {
    path: string;
    content: string;
    title?: string;
    planID?: string;
    sessionID?: string;
  }) => Promise<{ written: boolean; planID?: string }>;
  planDocMark?: (input: {
    path: string;
    title?: string;
    createdBy?: "user" | "live_chat" | "main_agent";
    sessionID?: string;
  }) => Promise<{ marked: boolean; planID: string }>;
  planDocActivate?: (planID: string, sessionID?: string) => Promise<unknown>;
  planDocStatus?: (
    planID: string,
    sessionID?: string,
  ) => Promise<{ status: string }>;
  niaChat?: { submit?: (input: { text: string }) => Promise<unknown> };
};

export function niaFace(
  client: NiaFaceSurfaces,
  options: {
    timeoutMs?: number;
    /**
     * The plan the audit is filed under, reported as soon as it exists
     * (before Nia is woken): the orchestrator records it for evidence
     * linking, and a scripted auditor needs the id to report against —
     * planDocMark generates the id itself, so there is no other way in.
     */
    onAuditPlan?: (planID: string, path: string) => void;
  } = {},
) {
  const timeoutMs = options.timeoutMs ?? 120_000;
  const face: VerificationFace = async (generation: Generation) => {
    // The plan-doc members are functions; the chat surface is an OBJECT
    // ({ submit, abort, ... }) — capability is checked per surface, or the
    // object surface reads as "missing" forever.
    const missing: string[] = [];
    if (typeof client.planDocWrite !== "function") missing.push("planDocWrite");
    if (typeof client.planDocMark !== "function") missing.push("planDocMark");
    if (typeof client.planDocActivate !== "function")
      missing.push("planDocActivate");
    if (typeof client.planDocStatus !== "function")
      missing.push("planDocStatus");
    if (typeof client.niaChat?.submit !== "function")
      missing.push("niaChat.submit");
    if (missing.length)
      return {
        check: "nia",
        ok: false,
        detail: `runtime exposes no ${missing.join(", ")} — the audit face needs the plan and Nia surfaces`,
      };
    const short = generation.schema.replace(/[^a-z0-9]/gi, "").slice(0, 8);
    const path = `plans/generation-verify-${short}-${Date.now().toString(36)}.md`;
    const summary = [
      `# Composition generation audit: ${generation.schema}`,
      "",
      "Audit this composition generation candidate. When verified call",
      "audit_report with this plan's planID.",
      "",
      "## Plugins",
      ...generation.plugins.map(
        (plugin) =>
          `- ${plugin.id} (${plugin.enabled ? "enabled" : "disabled"}) ${plugin.fingerprint}`,
      ),
      "",
      "## Policy rows",
      ...generation.policyRows.map(
        (row) =>
          `- ${row.id}: ${row.statement} [${row.enforcement}/${row.overridePolicy}]`,
      ),
      "",
      "## Config",
      "```json",
      JSON.stringify(generation.config, null, 2),
      "```",
      "",
    ].join("\n");
    try {
      await client.planDocWrite!({
        path,
        content: summary,
        title: "Generation audit",
      });
      const marked = await client.planDocMark!({
        path,
        title: "Generation audit",
      });
      options.onAuditPlan?.(marked.planID, path);
      await client.planDocActivate!(marked.planID);
      await client.niaChat!.submit!({
        text: `Audit plan ${marked.planID} (${path}): a composition generation candidate. Verify it against the plan document and call audit_report with planID=${marked.planID}.`,
      });
      const deadline = Date.now() + timeoutMs;
      while (Date.now() < deadline) {
        const { status } = await client.planDocStatus!(marked.planID);
        if (status === "completed") return { check: "nia", ok: true };
        if (status === "audit_gaps")
          return {
            check: "nia",
            ok: false,
            detail: `Nia reported audit_gaps (evidence: the audit round checkpoint and evidence.recorded in the journal)`,
          };
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      return {
        check: "nia",
        ok: false,
        detail: `no audit_report verdict for plan ${marked.planID} within ${timeoutMs}ms`,
      };
    } catch (error) {
      return {
        check: "nia",
        ok: false,
        detail: error instanceof Error ? error.message : String(error),
      };
    }
  };
  return face;
}
