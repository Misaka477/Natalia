import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import type { RuntimeEvent } from "@anthelia/contracts";
import { CapabilityRegistry } from "@anthelia/capability";
import {
  sandboxService,
  type SandboxService,
} from "@anthelia/runtime-services";
import { createRealRuntimeClient } from "../src";
import {
  pollHistoryForFinished,
  singleToolProvider,
} from "./real-runtime-harness";
import { useWorkspaceCleanup } from "./plugin-test-helpers";

useWorkspaceCleanup();

/**
 * T2-1/T2-2/T2-3, end to end through the client's merge path.
 *
 * The candidate is a checkout of the tracked tree, so the promotion gate's
 * command used to die on an absent `node_modules` before it tested anything
 * — the round-after-round npm failure. Three things had to be true at once
 * for a merge to mean anything: the candidate carries the host's
 * dependencies (T2-1), the gate runs INSIDE the candidate where the model's
 * change lives (T2-2), and it runs exactly ONCE (T2-3) — the client used to
 * run the same command a second time before the promotion, which paid for
 * the gate twice and let the first run's build output survive the
 * promotion's own artifact cleanup as a "before" path, so a merge promoted
 * artifacts the validation had produced.
 */

async function bootWorkspace(
  root: string,
  config: Record<string, unknown>,
  sessionID: `ses_${string}`,
) {
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3, ...config }),
  );
  const kernel = new CapabilityRegistry();
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    capabilityRegistry: kernel,
    permissionMode: "auto",
    provider: singleToolProvider("sandbox_create", { id: "box" }),
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!("create sandbox");
  await pollHistoryForFinished(client);
  const sandboxes = kernel.service<SandboxService>(sandboxService.id)!;
  return { client, sandboxes, events };
}

test("the promotion gate runs inside the candidate and reads the linked dependencies", async () => {
  // The workspace is a node project whose installed dependency is NOT
  // tracked: the candidate has it only through the link created at
  // candidate creation. The gate's command is DISCOVERED from the marker
  // (no promoteCommand configured — the old hardcoded default made that
  // path dead code), and it reads through the link.
  const root = await mkdtemp(join(tmpdir(), "natalia-gate-link-"));
  await mkdir(join(root, "node_modules", "fixture-dep"), { recursive: true });
  await writeFile(
    join(root, "node_modules", "fixture-dep", "package.json"),
    '{"name":"fixture-dep"}\n',
  );
  await writeFile(
    join(root, "package.json"),
    JSON.stringify({
      name: "fixture",
      scripts: {
        typecheck:
          "node -e \"process.stdout.write(require('fs').readFileSync('node_modules/fixture-dep/package.json','utf8'))\"",
      },
    }),
  );
  const { client, sandboxes } = await bootWorkspace(root, {}, "ses_gate_link");

  // The link is in the candidate: the dependency the host installed is
  // reachable from the gate's working directory.
  const candidate = (await sandboxes.list()).find(
    (entry) => entry.id === "box",
  );
  expect(candidate).toBeDefined();
  expect(
    existsSync(
      join(candidate!.root, "node_modules", "fixture-dep", "package.json"),
    ),
  ).toBe(true);

  await sandboxes.write("box", "promoted.txt", "landed");
  const changes = await client.sandboxMerge!("box");
  expect(changes).toContainEqual(
    expect.objectContaining({ path: "promoted.txt" }),
  );
  expect(await readFile(join(root, "promoted.txt"), "utf8")).toBe("landed");
  await client.dispose?.();
});

test("the promotion gate validates exactly once", async () => {
  // The command's side effect is the count: it appends one line per run to
  // a file outside the workspace (and inside the floor's writable /tmp), so
  // a second run is visible rather than inferred. The client used to run
  // the same command once more before the promotion.
  const root = await mkdtemp(join(tmpdir(), "natalia-gate-once-"));
  const counter = join(
    await mkdtemp(join(tmpdir(), "natalia-gate-counter-")),
    "runs.txt",
  );
  const { client, sandboxes } = await bootWorkspace(
    root,
    { sandbox: { promoteCommand: `date +%s%N >> ${counter}` } },
    "ses_gate_once",
  );

  await sandboxes.write("box", "promoted.txt", "landed");
  await client.sandboxMerge!("box");
  const runs = (await readFile(counter, "utf8"))
    .trim()
    .split("\n")
    .filter(Boolean);
  expect(runs).toHaveLength(1);
  await client.dispose?.();
});

test("a validation command's own output is never merged into the host", async () => {
  // The hole the duplicate run left: the first validation's build output was
  // in the candidate BEFORE the promotion captured its "before" index, so
  // the artifact cleanup could not see it and the merge carried it into the
  // host. The output path here is not ignored by .nataliaignore, so the
  // only thing standing between it and the host is the cleanup.
  const root = await mkdtemp(join(tmpdir(), "natalia-gate-artifact-"));
  const { client, sandboxes } = await bootWorkspace(
    root,
    {
      sandbox: {
        promoteCommand: "mkdir -p .verify && echo built > .verify/marker.txt",
      },
    },
    "ses_gate_artifact",
  );

  await sandboxes.write("box", "promoted.txt", "landed");
  await client.sandboxMerge!("box");
  // The model's change landed …
  expect(await readFile(join(root, "promoted.txt"), "utf8")).toBe("landed");
  // … and the gate's own output did not.
  expect(existsSync(join(root, ".verify", "marker.txt"))).toBe(false);
  await client.dispose?.();
});
