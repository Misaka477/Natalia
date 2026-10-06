import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createPluginRegistry,
  pluginWorkspaceResourcePath,
} from "@anthelia/plugin";
import { createToolRegistry } from "@anthelia/tools";
import { initialState, applyEvent } from "@natalia/view-store";
import {
  createTodoPlugin,
  todoItemsFromProjection,
  TODO_PLUGIN_ID,
  TODO_RESOURCE_NAME,
  todoRelativePath,
  todoTools,
  todoToolFamily,
} from "../src";

test("the todo family describes the tools it ships", () => {
  const family = todoToolFamily();
  expect(family.id).toBe("todo");
  expect(family.scope).toBe("session");
  expect(family.tools).toEqual(todoTools);
  expect(
    todoTools.find((tool) => tool.name === "todo_write")?.requiresApproval,
  ).toBe(false);
});

test("the todo plugin owns its stable tools and unloads cleanly", async () => {
  const tools = createToolRegistry([]);
  const registry = createPluginRegistry({ tools });
  await registry.load(createTodoPlugin());
  expect(registry.list()[0]).toMatchObject({
    id: TODO_PLUGIN_ID,
    scope: "session",
  });
  for (const tool of todoTools) expect(tools.has(tool.name)).toBe(true);
  await registry.unload(TODO_PLUGIN_ID);
  for (const tool of todoTools) expect(tools.has(tool.name)).toBe(false);
});

test("the todo plugin declares its session file as a read resource", async () => {
  const tools = createToolRegistry([]);
  const contributions: Array<{
    kind: string;
    name: string;
    payload: unknown;
  }> = [];
  const registry = createPluginRegistry({
    tools,
    registerOwner: () => ({
      contribute(kind, name, payload) {
        contributions.push({ kind, name, payload });
        return () => undefined;
      },
      release() {},
    }),
  });
  await registry.load(createTodoPlugin());

  expect(contributions).toEqual(
    expect.arrayContaining([
      {
        kind: "resources",
        name: TODO_RESOURCE_NAME,
        payload: expect.objectContaining({
          kind: "workspace-file",
          access: "read",
          scope: "session",
          path: ".natalia/todos/{sessionID}.json",
          readers: ["natalia.ui.todo"],
          audit: true,
        }),
      },
    ]),
  );
  expect(todoRelativePath("ses_current")).toBe(
    ".natalia/todos/ses_current.json",
  );
});

test("the todo resource template and the plugin path helper stay in sync", () => {
  expect(
    pluginWorkspaceResourcePath(
      {
        name: TODO_RESOURCE_NAME,
        kind: "workspace-file",
        access: "read",
        scope: "session",
        path: ".natalia/todos/{sessionID}.json",
      },
      { sessionID: "ses_current" },
    ),
  ).toBe(todoRelativePath("ses_current"));
});

test("todo tools isolate durable items by session", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-todo-"));
  const tools = createToolRegistry(todoTools);
  await tools
    .get("todo_write")!
    .execute(
      { items: [{ content: "finish migration", status: "in_progress" }] },
      { workspaceRoot: root, sessionID: "ses_a" },
    );
  expect(
    await tools
      .get("todo_read")!
      .execute({}, { workspaceRoot: root, sessionID: "ses_a" }),
  ).toContain("finish migration");
  // An empty session reports the same envelope: zero items, not a bare "[]".
  expect(
    JSON.parse(
      await tools
        .get("todo_read")!
        .execute({}, { workspaceRoot: root, sessionID: "ses_b" }),
    ),
  ).toEqual({ items: [], total: 0, truncated: false });
  await tools
    .get("todo_write")!
    .execute(
      { items: [{ content: "cutover evidence", status: "pending" }] },
      { workspaceRoot: root, sessionID: "ses_a" },
    );
  expect(
    await tools
      .get("todo_read")!
      .execute({}, { workspaceRoot: root, sessionID: "ses_a" }),
  ).toContain("cutover evidence");
});

test("todo tools require a session id", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-todo-session-"));
  const tools = createToolRegistry(todoTools);
  await expect(
    tools.get("todo_read")!.execute({}, { workspaceRoot: root }),
  ).rejects.toThrow("todo tools require a session ID");
});

test("todo items are derived from the generic tool transcript", () => {
  const state = initialState();
  applyEvent(state, {
    type: "tool.update",
    id: "t1:call_todo",
    name: "todo_write",
    callID: "call_todo",
    status: "succeeded",
    summary: "saved 1 todo item",
    result: JSON.stringify({
      saved: 1,
      items: [{ content: "read generic projection", status: "in_progress" }],
    }),
  } as Parameters<typeof applyEvent>[1]);

  expect(todoItemsFromProjection(state)).toEqual([
    { content: "read generic projection", status: "in_progress" },
  ]);
});

test("todo plugin falls back to write arguments for prose-only results", () => {
  const state = initialState();
  applyEvent(state, {
    type: "tool.update",
    id: "t1:call_todo",
    name: "todo_write",
    callID: "call_todo",
    status: "succeeded",
    summary: "saved 1 todo items",
    argumentsDelta: JSON.stringify({
      items: [{ content: "old durable format", status: "pending" }],
    }),
  } as Parameters<typeof applyEvent>[1]);

  expect(todoItemsFromProjection(state)).toEqual([
    { content: "old durable format", status: "pending" },
  ]);
});

test("last successful write wins and an empty write clears the list", () => {
  const state = initialState();
  applyEvent(state, {
    type: "tool.update",
    id: "t1:call_todo",
    name: "todo_write",
    callID: "call_todo",
    status: "succeeded",
    summary: "saved 1 todo item",
    result: JSON.stringify({
      saved: 1,
      items: [{ content: "first", status: "completed" }],
    }),
  } as Parameters<typeof applyEvent>[1]);
  applyEvent(state, {
    type: "tool.update",
    id: "t1:call_todo_2",
    name: "todo_write",
    callID: "call_todo_2",
    status: "failed",
    summary: "write failed",
    result: JSON.stringify({
      saved: 1,
      items: [{ content: "failed write", status: "pending" }],
    }),
  } as Parameters<typeof applyEvent>[1]);
  expect(todoItemsFromProjection(state)).toEqual([
    { content: "first", status: "completed" },
  ]);

  applyEvent(state, {
    type: "tool.update",
    id: "t1:call_todo_3",
    name: "todo_write",
    callID: "call_todo_3",
    status: "succeeded",
    summary: "cleared",
    result: JSON.stringify({ saved: 0, items: [] }),
  } as Parameters<typeof applyEvent>[1]);
  expect(todoItemsFromProjection(state)).toEqual([]);
});

test("todo_read bounds its page and reports the total", async () => {
  // The whole list used to arrive in one result. Now a limit pages it and the
  // result says how many exist — the shape mailbox_status and the terminal
  // readers already use.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-todo-page-"));
  const tools = createToolRegistry(todoTools);
  await tools.get("todo_write")!.execute(
    {
      items: [
        { content: "one", status: "pending" },
        { content: "two", status: "pending" },
        { content: "three", status: "pending" },
      ],
    },
    { workspaceRoot: root, sessionID: "ses_p" },
  );
  const read = tools.get("todo_read")!;
  expect(
    JSON.parse(
      await read.execute(
        { limit: 2 },
        { workspaceRoot: root, sessionID: "ses_p" },
      ),
    ),
  ).toEqual({
    items: [
      { content: "one", status: "pending" },
      { content: "two", status: "pending" },
    ],
    total: 3,
    truncated: true,
  });
  expect(
    JSON.parse(
      await read.execute({}, { workspaceRoot: root, sessionID: "ses_p" }),
    ).truncated,
  ).toBe(false);
});

test("todo_write answers with the same envelope todo_read returns (T-01)", async () => {
  // The two tools used to speak different shapes — read returned
  // {items,total,truncated} while write answered {saved,items} — so a model
  // that read the list and echoed the result back into write sent the
  // envelope itself. One envelope now, and the descriptions name it.
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-todo-shape-"));
  const tools = createToolRegistry(todoTools);
  const written = JSON.parse(
    await tools.get("todo_write")!.execute(
      {
        items: [
          { content: "one", status: "in_progress" },
          { content: "two", status: "pending" },
        ],
      },
      { workspaceRoot: root, sessionID: "ses_shape" },
    ),
  ) as { items: unknown[]; total: number; truncated: boolean };
  expect(written).toEqual({
    items: [
      { content: "one", status: "in_progress" },
      { content: "two", status: "pending" },
    ],
    total: 2,
    truncated: false,
  });
  // The read's envelope has the same keys — a round trip needs no reshaping.
  const read = JSON.parse(
    await tools
      .get("todo_read")!
      .execute({}, { workspaceRoot: root, sessionID: "ses_shape" }),
  ) as Record<string, unknown>;
  expect(Object.keys(read).sort()).toEqual(Object.keys(written).sort());
  expect(read.items).toEqual(written.items);
  // The write's parameter takes the items array, not the envelope: passing
  // the envelope back is refused by name.
  await expect(
    tools
      .get("todo_write")!
      .execute(
        { items: read.items },
        { workspaceRoot: root, sessionID: "ses_shape" },
      ),
  ).resolves.toBeTruthy();
});
