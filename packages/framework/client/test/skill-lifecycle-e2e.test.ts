import { expect, test } from "bun:test";
import { mkdir, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";
import { createRealRuntimeClient, waitForAsync } from "./real-runtime-harness";

// This file creates workspaces through the helper, so it registers its own
// cleanup: a hook registered by an IMPORTED module attaches only to the
// first file that loads it (probed), and the harness's own registration is
// exactly such an import.
useWorkspaceCleanup();

/**
 * Discovery D4's lifecycle, end to end: a skill activated inside a turn is
 * journaled, the journal folds into per-skill usage, and the garbage
 * collector's dry run reads it — the first time the GC has ever had real
 * numbers. A skill whose activating turn finished done is a success; one
 * whose turn was cancelled is a use without a verdict. The eviction itself
 * stays a human act: this face APPLIES NOTHING.
 */

/** Seeds a project skill with an OLD mtime: past the cold-start window, so
 *  the GC may consider it. */
async function seedSkill(root: string, name: string) {
  const file = join(root, ".natalia", "skills", name, "SKILL.md");
  await mkdir(join(root, ".natalia", "skills", name), { recursive: true });
  await writeFile(
    file,
    `---\nname: ${name}\ndescription: ${name} skill\n---\n\n${name} guidance\n`,
  );
  const old = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);
  await utimes(file, old, old);
}

test("the gc reads real usage: a cancelled turn's skill is evictable, a done turn's is not, and a pin protects", async () => {
  // An official-plugin workspace: the skills fiber mounts from the store,
  // so the catalog (and the skill_load tool) exist for the seeded skills.
  const root = await officialPluginWorkspace("natalia-skill-gc-");
  await seedSkill(root, "worker");
  await seedSkill(root, "dead");

  // The script, step by step: load worker, answer and end that turn, load
  // dead, then STALL — the test cancels the turn, so the use is recorded
  // and the verdict never arrives.
  let step = 0;
  const provider = {
    provider: "gc-script",
    model: "gc-script",
    async *stream(request: {
      messages: Array<{ role: string; content: unknown }>;
    }) {
      const hasToolResult = request.messages.some(
        (message) => message.role === "tool",
      );
      if (!hasToolResult) {
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: `call_${step === 0 ? "worker" : "dead"}`,
              name: "skill_load",
              arguments: JSON.stringify({
                name: step === 0 ? "worker" : "dead",
              }),
            },
          ],
        };
        step += 1;
        return;
      }
      if (step === 1) {
        // worker's turn: the answer, and the end.
        step += 1;
        yield { type: "content" as const, text: "used the worker skill" };
        yield { type: "done" as const };
        return;
      }
      // dead's turn: never answers. The cancellation is the verdict's
      // absence, and absence is not a failure.
      await new Promise(() => {});
    },
  };

  const events: RuntimeEvent[] = [];
  let deadLoaded = false;
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID: "ses_skill_gc" as never,
    // Auto so the scripted skill_load is not parked on an approval the
    // test has no human to answer.
    permissionMode: "auto",
    provider: provider as never,
  });
  client.start((event) => {
    events.push(event);
    const loaded = (event as { meta?: { name?: string } }).meta?.name;
    if (
      event.type === "tool.update" &&
      event.name === "skill_load" &&
      event.status === "succeeded" &&
      loaded === "dead"
    ) {
      deadLoaded = true;
      // Stop the stalled turn: the use is on the record, the verdict never
      // arrives.
      client.cancel("stop the stalled turn");
    }
  });

  await client.submitAndWait!("use the worker skill");
  // The stalled turn: fire it, let the tool land, let the cancel land.
  void client.submit("use the dead skill").catch(() => undefined);
  await waitForAsync(
    async () =>
      deadLoaded &&
      events.some(
        (event) =>
          event.type === "turn.finished" && event.stopReason === "cancelled",
      ),
    15_000,
  );

  // The activation facts are on the record.
  const activations = events.filter(
    (event) => event.type === "skill.activated",
  );
  expect(
    activations.map((event) => (event as { name: string }).name).sort(),
  ).toEqual(["dead", "worker"]);

  // The dry run: real usage, folded from the journal.
  const report = (await client.skillsGc?.()) as {
    evict: Array<{ name: string }>;
    keep: Array<{ name: string; reason: string }>;
  };
  // "worker" worked: kept. "dead" was used and never delivered: the
  // catalog's mean puts it below the line — the first real eviction this
  // GC has ever been able to name.
  expect(report.evict.map((row) => row.name)).toEqual(["dead"]);
  expect(report.keep.map((row) => row.name)).toContain("worker");

  // A pin outranks every number.
  await client.skillSetPinned?.({ name: "dead", pinned: true });
  const pinned = (await client.skillsGc?.()) as {
    evict: Array<{ name: string }>;
    keep: Array<{ name: string; reason: string }>;
  };
  expect(pinned.evict.map((row) => row.name)).not.toContain("dead");
  expect(pinned.keep.find((row) => row.name === "dead")!.reason).toBe(
    "protected by the user",
  );

  await client.dispose?.();
}, 60_000);
