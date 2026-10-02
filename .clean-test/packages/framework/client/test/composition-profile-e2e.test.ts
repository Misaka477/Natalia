import { expect, test } from "bun:test";
import { existsSync, mkdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import {
  createOfficialRuntimeClient,
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";
import { createScriptedProvider } from "./e2e-harness";

/**
 * P3 base profile, end to end: a WORKSPACE DROP-IN (the user-facing
 * mechanism) retunes the shipped base's confinement row, the boot wire
 * loads it, and a real run_shell turn feels it — with a control run
 * proving the shipped default behaves exactly as before (the stage
 * acceptance: the CLI keeps working as it did).
 */

useWorkspaceCleanup();

async function runTouchTurn(options: {
  prefix: string;
  readOnlyDropIn: boolean;
}) {
  const root = await officialPluginWorkspace(options.prefix);
  const probe = join(root, "probe.txt");
  if (options.readOnlyDropIn) {
    const dir = join(root, ".natalia", "composition.d");
    mkdirSync(dir, { recursive: true });
    writeFileSync(
      join(dir, "10-confinement.json"),
      JSON.stringify({
        schema: "natalia.composition-profile/1",
        rows: [{ id: "anthelia.sandbox", config: { mode: "read-only" } }],
      }),
    );
  }
  const sessionID = `ses_${options.prefix.replaceAll("-", "_")}` as SessionID;
  const events: RuntimeEvent[] = [];
  const client = createOfficialRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: createScriptedProvider({
      main: [
        {
          tool: () => ({
            name: "run_shell",
            arguments: { command: `touch "${probe}"` },
          }),
        },
        { text: "done" },
      ],
    }),
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!(sessionID);
  await client.submitAndWait!("create a scratch file");
  await client.dispose?.();
  const shellUpdates = events.filter(
    (event) => event.type === "tool.update" && event.name === "run_shell",
  );
  return { probe, shellUpdates };
}

test("a workspace drop-in's read-only row stops the write the shipped base allows", async () => {
  const readOnly = await runTouchTurn({
    prefix: "profile-e2e-readonly",
    readOnlyDropIn: true,
  });
  // The tool RAN (the update is there) — and the file is not: the
  // confinement row from the drop-in refused the write.
  expect(readOnly.shellUpdates.length).toBeGreaterThan(0);
  expect(existsSync(readOnly.probe)).toBe(false);

  // Control: the same turn in a plain workspace — the shipped base says
  // workspace-write, so the file lands. The stage acceptance made
  // executable: this change retunes nothing until an overlay says so.
  const control = await runTouchTurn({
    prefix: "profile-e2e-control",
    readOnlyDropIn: false,
  });
  expect(control.shellUpdates.length).toBeGreaterThan(0);
  expect(existsSync(control.probe)).toBe(true);
});
