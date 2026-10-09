import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { configV3Schema } from "@anthelia/contracts";
import { createProposeGenerationTool } from "../src/runtime/generation-tools";
import type { RuntimeContext } from "@anthelia/substrate";

/**
 * `propose_generation`'s plugin refusal (the 2026-10-08 audit's P1-5).
 *
 * The audit proposed `natalia-task-module` — an id the config carries — and
 * was refused with "unknown plugin id (not in the desired catalog)". The two
 * lists had drifted apart and nothing said so, and the refusal itself gave
 * the model nothing to work with.
 */

const LIVE = configV3Schema.parse({
  version: 3,
  providers: {},
  catalog: { providers: {} },
  plugins: { enabled: { "natalia-task-module": true } },
});

function proposeTool() {
  const root = process.cwd();
  const ctx = {
    ports: {
      getReady: () => Promise.resolve(),
      getWorkspaceRoot: () => root,
      getSessionID: () => "ses_generation_refusal",
      getTsRuntimeConfig: () => LIVE,
      getPluginsController: () => ({
        catalog: () => [
          { id: "natalia-tool-shell", enabled: true, fingerprint: "fp-shell" },
          { id: "natalia-skills", enabled: true, fingerprint: "fp-skills" },
        ],
      }),
      publish: () => undefined,
      publishForSession: () => undefined,
      getExecutionBySession: () => new Map(),
      getActiveExec: () => undefined,
    },
    state: { serviceDirectory: { getOptional: () => undefined } },
  } as unknown as RuntimeContext;
  return createProposeGenerationTool(ctx);
}

test("an unknown plugin id refusal names what the catalog holds", async () => {
  const tool = proposeTool();
  const answer = String(
    await tool.execute(
      {
        plugins: [{ id: "natalia-task-module", enabled: true }],
        note: "enable the task module",
      },
      {
        sessionID: "ses_generation_refusal",
        workspaceRoot: process.cwd(),
      } as never,
    ),
  );
  // The id, the catalog's contents, and where an id would have to come from.
  expect(answer).toContain("unknown plugin id: natalia-task-module");
  expect(answer).toContain("The catalog holds 2 plugin(s)");
  expect(answer).toContain("natalia-skills, natalia-tool-shell");
  expect(answer).toContain("installed in the plugin store");
  expect(answer).toContain("a plugins.enabled entry alone does not");
});
