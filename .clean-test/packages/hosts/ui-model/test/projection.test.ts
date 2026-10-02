import { expect, test } from "bun:test";
import {
  EventBatcher,
  ProjectionCache,
  classifyTool,
  collapseToolOutput,
  projectToolCall,
  projectToolRender,
  resultView,
  shouldLazyRenderDetail,
} from "../src";

test("shell tools classify separately from terminal and generic tools", () => {
  expect(classifyTool("run_shell")).toBe("shell");
  expect(classifyTool("bash")).toBe("shell");
  expect(classifyTool("terminal_create")).toBe("terminal");
});

test("file tools classify into dedicated presentation kinds", () => {
  expect(classifyTool("read_file")).toBe("read");
  expect(classifyTool("write_file")).toBe("write");
  expect(classifyTool("grep")).toBe("grep");
  expect(classifyTool("glob")).toBe("glob");
});

test("interaction tools classify into dedicated presentation kinds", () => {
  expect(classifyTool("web_fetch")).toBe("webfetch");
  expect(classifyTool("web_search")).toBe("websearch");
  expect(classifyTool("ask_user")).toBe("question");
  expect(classifyTool("agent_spawn")).toBe("subagent");
  expect(classifyTool("skill_load")).toBe("skill");
});

test("tool output collapse follows line and character budgets", () => {
  expect(collapseToolOutput("one\ntwo", 2, 20)).toEqual({
    output: "one\ntwo",
    overflow: false,
  });
  expect(collapseToolOutput("one\ntwo\nthree", 2, 20)).toEqual({
    output: "one\ntwo\n…",
    overflow: true,
  });
  expect(collapseToolOutput("abcdefgh", 2, 5)).toEqual({
    output: "abcd…",
    overflow: true,
  });
});

test("projection cache reuses long markdown and tool projections", () => {
  const cache = new ProjectionCache();
  const text = "# title\n\n" + "内容🙂e\u0301\n".repeat(2000);
  const first = cache.markdownSegment("m", 1, text);
  const second = cache.markdownSegment("m", 1, text);
  expect(second).toBe(first);
  expect(cache.stats.markdownHits).toBe(1);

  const tool = cache.toolResult("tool", 1, "line\n".repeat(100));
  expect(cache.toolResult("tool", 1, "line\n".repeat(100))).toBe(tool);
  expect(cache.stats.toolHits).toBe(1);
  expect(shouldLazyRenderDetail("x".repeat(5000))).toBe(true);
});

test("event batcher throttles background projection while modal is active", () => {
  const batcher = new EventBatcher<string>();
  batcher.push("a");
  expect(batcher.shouldFlush({ now: 0, modalActive: true })).toBe(true);
  batcher.flush(0);
  batcher.push("b");
  expect(batcher.shouldFlush({ now: 50, modalActive: true })).toBe(false);
  expect(batcher.shouldFlush({ now: 120, modalActive: true })).toBe(true);
});

test("tool result projection turns sandbox JSON into readable change summaries", () => {
  const result = resultView(
    JSON.stringify([
      {
        kind: "modify",
        path: "sandbox-file.txt",
        content: "sandbox write test content",
      },
    ]),
    8,
    1200,
    { kind: "diff", name: "sandbox_diff" },
  );
  expect(result.summary).toBe("1 sandbox change");
  expect(result.preview).toBe(
    "Modified sandbox-file.txt\n  sandbox write test content",
  );
  expect(result.detail).toContain('"kind":"modify"');
});

test("generic structured result projects scalar fields without raw JSON", () => {
  const result = resultView(
    JSON.stringify({ id: "proc_1", status: "running", pid: 1234 }),
    8,
    1200,
    { name: "process_start" },
  );
  expect(result.preview).toBe("id: proc_1\nstatus: running\npid: 1234");
  expect(result.preview).not.toContain("{");
});

test("browser and question JSON results project as human-readable summaries", () => {
  const browser = resultView(
    JSON.stringify({
      url: "https://example.com/",
      status: 200,
      title: "Example Domain",
      contentType: "text/html",
      textPreview: "Example Domain documentation preview",
    }),
    8,
    1200,
    { name: "browser_visit" },
  );
  expect(browser.summary).toBe("Visited Example Domain · HTTP 200");
  expect(browser.preview).toContain("Preview: Example Domain");
  const question = resultView(
    JSON.stringify({ answers: [["选项1"]] }),
    8,
    1200,
    {
      name: "ask_user",
    },
  );
  expect(question.summary).toBe("User answered");
  expect(question.preview).toBe("Answer: 选项1");
});

test("projectToolRender decodes a tool's self-projected card", () => {
  const intent = projectToolRender({
    render: {
      kind: "read",
      title: "src/index.ts",
      summary: "1,024 chars",
      body: "export const x = 1;",
      meta: [["lines", "1"]],
    },
  });
  expect(intent).toEqual({
    kind: "read",
    title: "src/index.ts",
    summary: "1,024 chars",
    body: "export const x = 1;",
    meta: [["lines", "1"]],
  });
});

test("projectToolRender ignores a missing or malformed intent", () => {
  expect(projectToolRender({})).toBeUndefined();
  expect(projectToolRender({ render: "read" })).toBeUndefined();
  expect(projectToolRender({ render: { kind: "read" } })).toBeUndefined();
  expect(
    projectToolRender({ render: { title: "x", summary: "y" } }),
  ).toBeUndefined();
});

test("projectToolCall decodes the call card from metadata.call", () => {
  const call = projectToolCall({
    call: { kind: "terminal", title: "make build", summary: "run" },
  });
  expect(call).toEqual({
    kind: "terminal",
    title: "make build",
    summary: "run",
  });
  expect(
    projectToolCall({ render: { kind: "read", title: "x", summary: "y" } }),
  ).toBeUndefined();
});
