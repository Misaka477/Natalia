import { afterAll, expect, test } from "bun:test";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent } from "@anthelia/contracts";
import { createRealRuntimeClient } from "../src/runtime/main";

/**
 * Discovery D4 end-to-end: a real turn schedules the side-channel review,
 * the SAME runtime serves it a JSON candidate, the validated write lands
 * a skill on disk, and the journal records the completion — while the
 * review keeps its own system prompt, off the main conversation
 * entirely (hermes discipline 2: the main thread and its cache are
 * never touched).
 */

let scratch = "";

afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

test("a turn sediments a skill through the side-channel review", async () => {
  scratch = mkdtempSync(join(tmpdir(), "self-review-e2e-"));
  // The skills fiber mounts from a DESIRED entry: an absolute
  // plugins.paths entry points discovery at the repo's plugin source
  // (resolve() keeps absolute paths), so boot's mountPlugins finds it —
  // the same entry the plugin store would carry on an installed system.
  mkdirSync(join(scratch, ".natalia"), { recursive: true });
  // A SELF-CONTAINED plugin-layout fixture: the manifest's entry points
  // straight at the plugin SOURCE (.ts — bun loads it natively), so the
  // test never depends on a built dist being fresh (an artifact-linked
  // path once loaded a stale index.js without this round's upsertSkill
  // and rejected every candidate at the boundary).
  // The entry must stay INSIDE the fixture root (validatePluginPath's
  // anti-escape guard) — so the fixture dir carries the source itself as
  // a symlink: fresh as the checkout, layout as installed.
  const pluginSource = join(
    import.meta.dir,
    "..",
    "..",
    "..",
    "plugins",
    "skills",
  );
  const pluginFixture = join(scratch, "skills-plugin");
  mkdirSync(pluginFixture, { recursive: true });
  symlinkSync(join(pluginSource, "src"), join(pluginFixture, "src"), "dir");
  const manifest = JSON.parse(
    readFileSync(join(pluginSource, "natalia.plugin.json"), "utf8"),
  ) as Record<string, unknown>;
  manifest.entry = "src/index.ts";
  writeFileSync(
    join(pluginFixture, "natalia.plugin.json"),
    JSON.stringify(manifest),
  );
  writeFileSync(
    join(scratch, ".natalia", "config.json"),
    JSON.stringify({ version: 3, plugins: { paths: [pluginFixture] } }),
  );
  // A seeded skill mirrors the canonical-tool fixture: the skills fiber
  // discovers the project root, and its tool registers with the turn's
  // catalog (discovery-driven mount — an empty root registers nothing).
  mkdirSync(join(scratch, ".natalia", "skills", "seed"), { recursive: true });
  writeFileSync(
    join(scratch, ".natalia", "skills", "seed", "SKILL.md"),
    "---\nname: seed\ndescription: Seed skill\n---\nSeed guidance.",
  );
  const calls: Array<{ messages: unknown[] }> = [];
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: scratch,
    sessionID: "ses_d4_e2e" as never,
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream(request: { messages: unknown[] }) {
        calls.push(request);
        if (calls.length === 1) {
          yield { type: "content" as const, text: "patched the parser" };
          yield { type: "done" as const };
          return;
        }
        // The side-channel review's completion: one legal create, one
        // rejected action (the boundary counts it).
        yield {
          type: "content" as const,
          text: JSON.stringify({
            candidates: [
              {
                kind: "create",
                name: "parser-gotchas",
                description: "Parser pitfalls",
                content: "# Parser gotchas\nAvoid empty replies.",
              },
              {
                kind: "delete",
                name: "not-allowed",
                description: "x",
                content: "x",
              },
            ],
          }),
        };
        yield { type: "done" as const };
      },
    } as never,
  });
  client.start((event) => events.push(event));
  await client.submitAndWait!({ text: "fix the parser" });

  // The skills fiber mounts while the turn builds its tool catalog (cold
  // start, no reload: the canonical-tool test proves plain submit does
  // it) — so the write surface exists before the review fires at +delay.

  // The review fires SELF_REVIEW_DELAY_MS after turn end; wait it out.
  for (let elapsed = 0; elapsed < 4_000; elapsed += 50) {
    if (events.some((e) => e.type === "self_review.completed")) break;
    await new Promise((r) => setTimeout(r, 50));
  }
  await client.dispose?.();

  const completed = events.find((e) => e.type === "self_review.completed") as
    | Extract<RuntimeEvent, { type: "self_review.completed" }>
    | undefined;
  expect(completed).toBeDefined();
  expect(completed!.skillsCreated).toEqual(["parser-gotchas"]);
  // The boundary rejected the delete — counted, never fatal.
  expect(completed!.rejected).toBe(1);
  // The skill REALLY landed on disk through the validated write.
  const skillFile = join(
    scratch,
    ".natalia",
    "skills",
    "parser-gotchas",
    "SKILL.md",
  );
  expect(existsSync(skillFile)).toBe(true);
  expect(readFileSync(skillFile, "utf8")).toContain("Parser pitfalls");
  // No skipped edges on the happy path.
  expect(events.some((e) => e.type === "self_review.skipped")).toBe(false);
});
