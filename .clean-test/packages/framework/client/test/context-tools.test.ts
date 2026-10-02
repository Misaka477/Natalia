import { afterAll, expect, test } from "bun:test";
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
import { createRinaContextTools } from "../src/runtime/context-tools";

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
