import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { rinaVault } from "@anthelia/rina";
import { createTestContext } from "@anthelia/runtime-services";
import type { RuntimeContext } from "@anthelia/substrate";
import {
  createContextVault,
  createRinaMemory,
  rinaMemory,
} from "@anthelia/rina";
import { workspaceStoreID } from "@anthelia/platform";
import type { SessionID } from "@anthelia/contracts";
import type { ProviderStreamRequest } from "@anthelia/runtime";
import { createRealRuntimeClient } from "../src";
import {
  officialPluginWorkspace,
  useWorkspaceCleanup,
} from "./plugin-test-helpers";
import { createRinaContextTools } from "../src/runtime/context-tools";

useWorkspaceCleanup();

/**
 * The RINA study's five Agent Tools (Phase2b-1): read-only faces over
 * a REAL vault in a fake context (the session-history test's template),
 * with the study's isolation as an EDGE RULE — an arg naming another
 * session is refused by every face, and the id-prefix gate backs the
 * by-id faces at the store too.
 */

const dirs: string[] = [];
const vaults: Array<{ close: () => void }> = [];
afterAll(() => {
  for (const v of vaults) v.close();
  for (const dir of dirs) rmSync(dir, { recursive: true, force: true });
});

const CURRENT = "ses_current";
const OTHER = "ses_other";

function harness(withVault = true) {
  const dir = mkdtempSync(join(tmpdir(), "ctx-tools-"));
  dirs.push(dir);
  const vault = createContextVault({ dir, flushMs: 1 });
  vaults.push(vault);
  const ctx = {
    state: {
      serviceDirectory: createTestContext(
        withVault ? [rinaVault.mock(vault as never)] : [],
      ),
    },
    ports: {
      getReady: () => Promise.resolve(),
      getSessionID: () => CURRENT,
    },
  } as unknown as RuntimeContext;
  const tools = createRinaContextTools(ctx);
  const byName = new Map(tools.map((tool) => [tool.name, tool]));
  return { byName, vault };
}

const context = { workspaceRoot: "/tmp/x", sessionID: CURRENT };

async function run(
  byName: Map<string, ReturnType<typeof createRinaContextTools>[number]>,
  name: string,
  input: unknown,
) {
  const tool = byName.get(name);
  if (!tool) throw new Error(`no tool ${name}`);
  return JSON.parse(await tool.execute(input, context as never)) as Record<
    string,
    unknown
  >;
}

test("all five tools exist, are read-only by declaration, and name their isolation", async () => {
  const { byName } = harness();
  for (const name of [
    "context_search",
    "context_read",
    "context_list",
    "context_history",
    "context_pack",
  ])
    expect(byName.has(name)).toBe(true);
  for (const tool of byName.values()) {
    expect(tool.requiresApproval).toBe(false);
    expect(tool.description.toLowerCase()).toContain("read-only");
    expect(JSON.stringify(tool.parameters)).toContain("sessionID");
  }
});

test("search/list/read/history refuse an ARG naming another session at the edge", async () => {
  const { byName, vault } = harness();
  vault.remember({
    id: `${CURRENT}:1`,
    workspaceID: "w",
    sessionID: CURRENT,
    recordType: "decision",
    entityKey: "gen-1",
    summary: "switched to gen-1",
  });
  for (const [name, input] of [
    ["context_search", { query: "switched", sessionID: OTHER }],
    ["context_list", { sessionID: OTHER }],
    ["context_read", { recordID: `${CURRENT}:1`, sessionID: OTHER }],
    ["context_history", { recordID: `${CURRENT}:1`, sessionID: OTHER }],
  ] as const) {
    const response = await run(byName, name, input);
    expect(response.error).toBe("cross_session_forbidden");
  }
  // an ECHO of the current session is accepted (the study's signature
  // names sessionID — explicitness, not a hole)
  const ok = await run(byName, "context_search", {
    query: "switched",
    sessionID: CURRENT,
  });
  expect(Array.isArray(ok.data)).toBe(true);
  // the by-id faces also refuse a cross-session PREFIX even without the arg
  const cross = await run(byName, "context_read", { recordID: `${OTHER}:9` });
  expect(cross.error).toBe("cross_session_forbidden");
  const missing = await run(byName, "context_read", {
    recordID: `${CURRENT}:99`,
  });
  expect(missing.error).toBe("not_found");
});

test("search scores, the time window bounds, list orders newest-first, history walks actions", async () => {
  const { byName, vault } = harness();
  vault.remember({
    id: `${CURRENT}:a`,
    workspaceID: "w",
    sessionID: CURRENT,
    recordType: "plan",
    entityKey: "plan-alpha",
    summary: "alpha planned",
    createdAt: new Date(Date.now() - 86_400_000).toISOString(),
  });
  vault.remember({
    id: `${CURRENT}:b`,
    workspaceID: "w",
    sessionID: CURRENT,
    recordType: "decision",
    entityKey: "gen-beta",
    summary: "beta decided",
    createdAt: new Date().toISOString(),
  });
  const found = (await run(byName, "context_search", { query: "planned" }))
    .data as Array<{ id: string; score?: number }>;
  expect(found).toHaveLength(1);
  expect(found[0]!.id).toBe(`${CURRENT}:a`);
  expect(typeof found[0]!.score).toBe("number");
  // the time window excludes the old record from a NEWER-than search
  const recent = (
    await run(byName, "context_search", {
      query: "planned",
      timeRange: { after: new Date().toISOString() },
    })
  ).data as unknown[];
  expect(recent).toHaveLength(0);
  const listed = (await run(byName, "context_list", {})).data as Array<{
    id: string;
  }>;
  expect(listed[0]!.id).toBe(`${CURRENT}:b`); // newest first
  // a history after a search touches the record's actions
  await run(byName, "context_search", { query: "planned" });
  const history = (
    await run(byName, "context_history", {
      recordID: `${CURRENT}:a`,
    })
  ).data as Array<{ action: string }>;
  expect(history.length).toBeGreaterThan(0);
  expect(history.some((row) => row.action === "accessed")).toBe(true);
  // a malformed range fails loudly
  const bad = await run(byName, "context_list", {
    timeRange: { after: "nope" },
  });
  expect(bad.error).toBe("time_range_malformed");
});

test("context_pack: the role enum, the budget, and the honest unavailable face", async () => {
  const { byName, vault } = harness();
  vault.remember({
    id: `${CURRENT}:p1`,
    workspaceID: "w",
    sessionID: CURRENT,
    recordType: "plan",
    entityKey: "plan-x",
    summary: "plan x moved forward today with details",
  });
  vault.remember({
    id: `${CURRENT}:m1`,
    workspaceID: "w",
    sessionID: CURRENT,
    recordType: "mailbox",
    entityKey: "mail-y",
    summary: "mailbox y has a message for the agent right now",
  });
  const unknownAgent = await run(byName, "context_pack", { agentID: "ghost" });
  expect(unknownAgent.error).toBe("unknown_agent");
  expect(String(unknownAgent.note)).toContain("natalia");
  const pack = (await run(byName, "context_pack", { agentID: "nia" })).data as {
    items: Array<{ recordType: string }>;
    tokens: number;
  };
  expect(pack.items.every((item) => item.recordType === "plan")).toBe(true); // nia's pick
  expect(pack.tokens).toBeGreaterThan(0);
  // a tiny budget truncates honestly
  const tiny = (
    await run(byName, "context_pack", {
      agentID: "natalia",
      budget: 1,
    })
  ).data as { items: unknown[]; truncated: boolean };
  expect(tiny.truncated).toBe(true);
  expect(tiny.items).toHaveLength(0);
  // cross-session is refused here too
  const cross = await run(byName, "context_pack", {
    agentID: "nia",
    sessionID: OTHER,
  });
  expect(cross.error).toBe("cross_session_forbidden");
});

test("with no vault provided, every face says so (honest, not empty)", async () => {
  const { byName } = harness(false);
  const response = await run(byName, "context_search", { query: "anything" });
  expect(response.error).toBe("vault_unavailable");
  expect(String(response.note)).toContain("not provided");
});

test("Phase 7's context_recall: the priority order, the isolation rule, the honest absence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "ctx-recall-"));
  dirs.push(dir);
  const vault = createContextVault({ dir, flushMs: 1 });
  vaults.push(vault);
  const memory = createRinaMemory({ dir: join(dir, "memory") });
  const withServices = {
    state: {
      serviceDirectory: createTestContext([
        rinaVault.mock(vault as never),
        rinaMemory.mock(memory as never),
      ]),
    },
    ports: {
      getReady: () => Promise.resolve(),
      getSessionID: () => CURRENT,
      getWorkspaceRoot: () => "/tmp/x",
    },
  } as unknown as RuntimeContext;
  const byName = new Map(
    createRinaContextTools(withServices).map(
      (tool) => [tool.name, tool] as const,
    ),
  );
  expect(byName.has("context_recall")).toBe(true);

  // The isolation rule: an arg naming another session is refused.
  const refused = await run(byName, "context_recall", { sessionID: OTHER });
  expect(refused.error).toBe("cross_session_forbidden");

  // The lanes: nothing yet -> an empty answer in the study's order.
  const empty = await run(byName, "context_recall", {});
  expect(empty.order).toEqual([]);

  // A workspace memory and a vault hit: the order is State -> Workspace
  // Memory -> Global -> Vault, and the vault lane rides the query.
  memory.remember({
    scope: `workspace:${workspaceStoreID("/tmp/x")}`,
    content: "the composer writes next-step by default",
    evidenceID: "ev:1",
    status: "active",
  });
  vault.remember({
    id: "v:1",
    workspaceID: "w",
    sessionID: CURRENT,
    recordType: "decision",
    entityKey: "composer-key",
    summary: "composer default decided",
  });
  const answered = await run(byName, "context_recall", { query: "composer" });
  expect(answered.order).toEqual(["workspace_memory", "vault"]);
  const sections = answered.sections as Array<{
    source: string;
    items: Array<Record<string, unknown>>;
  }>;
  expect(sections[0]!.items[0]).toMatchObject({
    content: "the composer writes next-step by default",
  });
  expect(sections[1]!.items[0]).toMatchObject({ id: "v:1" });

  // Without the services the answer says so (no guessed path, no throw).
  const bare = new Map(
    createRinaContextTools({
      state: { serviceDirectory: createTestContext([]) },
      ports: {
        getReady: () => Promise.resolve(),
        getSessionID: () => CURRENT,
        getWorkspaceRoot: () => "/tmp/x",
      },
    } as unknown as RuntimeContext).map((tool) => [tool.name, tool] as const),
  );
  const unavailable = await run(bare, "context_recall", {});
  expect(unavailable.error).toBe("knowledge_unavailable");
  memory.close();
});

test("a bad recordID is classified, not lumped into cross-session (T-17)", async () => {
  // The by-id faces used to answer cross_session_forbidden for EVERY id
  // that did not start with this session — so a fabricated or mistyped id
  // told the model to fix a session problem that did not exist, and a
  // remembered-session id naming no record was reported the same way as
  // another session's private record. Three problems, three answers:
  // another session's id, a malformed id, and a missing record.
  const { byName, vault } = harness();
  vault.remember({
    id: `${CURRENT}:real`,
    workspaceID: "w",
    sessionID: CURRENT,
    recordType: "decision",
    entityKey: "gen-2",
    summary: "switched to gen-2",
  });
  // A fabricated id with no session segment is malformed, not a session
  // violation.
  for (const name of ["context_read", "context_history"]) {
    const malformed = await run(byName, name, { recordID: "totally-made-up" });
    expect(malformed.error).toBe("invalid_record_id");
  }
  // A real other-session id is the genuine isolation refusal.
  const cross = await run(byName, "context_history", {
    recordID: `${OTHER}:1`,
  });
  expect(cross.error).toBe("cross_session_forbidden");
  // This session's id for a record that was never remembered is a missing
  // record — the same answer context_read has always given.
  const missingRead = await run(byName, "context_read", {
    recordID: `${CURRENT}:never-remembered`,
  });
  expect(missingRead.error).toBe("not_found");
  const missingHistory = await run(byName, "context_history", {
    recordID: `${CURRENT}:never-remembered`,
  });
  expect(missingHistory.error).toBe("not_found");
  // And the real record still answers.
  const present = await run(byName, "context_history", {
    recordID: `${CURRENT}:real`,
  });
  expect(present.error).toBeUndefined();
  expect(Array.isArray(present.data)).toBe(true);
});

test("a recorded validation reaches the context faces through the real runtime (T-18/RINA)", async () => {
  // The write-side slice of the RINA plan: record_* writes the governance
  // ledger, and the vault is a DERIVED index of the journal — the classifier
  // table is the bridge. Until the record family was classified, every
  // evidence/completion/decision landed in the ledger and NOTHING reached the
  // vault, so context_list/search/recall were empty no matter what was
  // written ("写完了 context 查不到" was a classifier gap, not a mystery).
  const root = await mkdtemp(join(tmpdir(), "natalia-ctx-rina-"));
  await mkdir(join(root, ".natalia"), { recursive: true });
  await writeFile(
    join(root, ".natalia", "config.json"),
    JSON.stringify({ version: 3 }),
  );
  const sessionID = "ses_ctx_rina_write" as SessionID;
  const results: string[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: root,
    sessionID,
    permissionMode: "auto",
    provider: {
      provider: "ctx-rina",
      model: "ctx-rina-model",
      async *stream(request: ProviderStreamRequest) {
        const messages = (
          request as {
            messages: Array<{
              role: string;
              content: string;
              toolCallID?: string;
            }>;
          }
        ).messages;
        const answered = messages
          .filter(
            (message) =>
              message.role === "tool" &&
              String(message.toolCallID ?? "").startsWith("call_ctx"),
          )
          .at(-1);
        if (answered) {
          results.push(String(answered.content ?? ""));
          if (results.length === 1) {
            // Then: the list face over this session's records.
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_ctx",
                  name: "context_list",
                  arguments: JSON.stringify({}),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          if (results.length === 2) {
            // Finally: recall by the objective's own words.
            yield {
              type: "tool_call" as const,
              calls: [
                {
                  id: "call_ctx",
                  name: "context_recall",
                  arguments: JSON.stringify({
                    query: "artifact wiring proof",
                  }),
                },
              ],
            };
            yield { type: "done" as const };
            return;
          }
          yield { type: "content" as const, text: "context wired" };
          yield { type: "done" as const };
          return;
        }
        // First: a validation record with a distinctive objective.
        yield {
          type: "tool_call" as const,
          calls: [
            {
              id: "call_ctx",
              name: "record_validation",
              arguments: JSON.stringify({
                taskID: "task_rina",
                objective: "the artifact wiring proof runs green",
                command: "true",
              }),
            },
          ],
        };
        yield { type: "done" as const };
      },
    },
  });
  client.start(() => undefined);
  await client.sessionAttach!(sessionID);
  await client.submitAndWait!("record then recall");

  expect(results).toHaveLength(3);
  // results[0] is record_validation's own answer; the faces follow.
  const validation = JSON.parse(results[0]!) as { evidenceID?: string };
  expect(validation.evidenceID).toStartWith("evidence:");
  // The list face carries the evidence record — the vault now classifies
  // the record family.
  const listed = JSON.parse(results[1]!) as {
    data?: Array<{ recordType?: string; entityKey?: string }>;
  };
  const evidence = (listed.data ?? []).find(
    (record) => record.entityKey === validation.evidenceID,
  );
  expect(evidence?.recordType).toBe("evidence");
  // The recall face answers with the same memory, scored and ranked.
  const recalled = JSON.parse(results[2]!) as {
    sections?: Array<{ source: string; items: Array<{ summary?: string }> }>;
  };
  const vaultItems = (recalled.sections ?? []).flatMap(
    (section) => section.items,
  );
  expect(
    vaultItems.some((hit) => hit.summary?.includes("artifact wiring proof")),
  ).toBe(true);
  await client.dispose?.();
}, 30_000);

test("a context read's card carries the records, not the envelope (S3)", () => {
  // The record faces answered with a `data: [...]` envelope and the generic
  // flatten rendered that array. The card now carries the records themselves
  // — one line each — and the count as a facet.
  const ctx = {
    ports: { getReady: () => Promise.resolve(), getSessionID: () => CURRENT },
  } as unknown as RuntimeContext;
  const tools = createRinaContextTools(ctx);
  const read = tools.find((tool) => tool.name === "context_list")!;
  const value = JSON.stringify({
    data: [
      {
        id: "ses_1:r1",
        recordType: "decision",
        entityKey: "use-sqlite",
        summary: "chose sqlite for the vault",
        sessionID: "ses_1",
        createdAt: "2026-10-09T00:00:00.000Z",
        seq: 1,
        rank: 0,
        score: 1,
      },
      {
        id: "ses_1:r2",
        recordType: "evidence",
        entityKey: "t-16",
        summary: "typecheck green",
        sessionID: "ses_1",
        createdAt: "2026-10-09T00:00:01.000Z",
        seq: 2,
        rank: 0,
        score: 1,
      },
    ],
  });
  const meta = read.output!.presentationMeta!({}, value);
  const card = read.output!.presentResult!({}, value, meta);
  expect(card).toMatchObject({
    kind: "generic",
    title: "records",
    summary: "listed · 2 records",
    body: [
      "decision · use-sqlite — chose sqlite for the vault",
      "evidence · t-16 — typecheck green",
    ].join("\n"),
    meta: [["total", "2"]],
  });
  // An error answer (no `data`) reads as the call verb, never a crash.
  const refused = read.output!.presentResult!(
    {},
    JSON.stringify({ error: "vault_unavailable" }),
  );
  expect(refused).toMatchObject({ kind: "generic", summary: "listed" });
});
