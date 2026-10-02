import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  fallbackSessionTitle,
  generateSessionTitle,
  isInvalidGeneratedSessionTitle,
  normalizeSessionTitle,
  sanitizeSessionTitleInput,
} from "../src/session-title";
import { createSessionStoreController } from "@anthelia/session-store";
import { createAttachmentService } from "@anthelia/attachments";

test("session titles sanitize secrets, JWTs, and home paths", () => {
  const input = sanitizeSessionTitleInput(
    "Fix token=super-secret-value /home/alice/.config key=abc eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxIn0.signature",
  );
  expect(input).toContain("[redacted]");
  expect(input).toContain("[home path]");
  expect(input).not.toContain("super-secret-value");
  expect(input).not.toContain("/home/alice");
  expect(normalizeSessionTitle('## "Fix: cache!"\nnow')).toBe("Fix cache now");
});

test("session title generator sends only bounded text and normalizes output", async () => {
  let request: unknown;
  const provider = {
    provider: "test",
    model: "test",
    async *stream(value: unknown) {
      request = value;
      yield { type: "content" as const, text: "** 修复: 登录! **" };
    },
  };
  const title = await generateSessionTitle(
    provider,
    "修复 登录 " + "x".repeat(700),
  );
  expect(title).toBe("修复 登录");
  const userContent = (request as { messages: Array<{ content: string }> })
    .messages[1]!.content;
  expect(userContent.length).toBeLessThanOrEqual(600);
});

test("session title generator rejects provider and tool protocol IDs", async () => {
  expect(isInvalidGeneratedSessionTitle("chatcmpl-tool-b10625d073fa5e8d")).toBe(
    true,
  );
  expect(normalizeSessionTitle("chatcmpl-tool-b10625d073fa5e8d")).toBe("");
  expect(normalizeSessionTitle("chatcmpl tool b10625d073fa5e8d")).toBe("");

  const idProvider = {
    provider: "test",
    model: "test",
    async *stream() {
      yield {
        type: "content" as const,
        text: "chatcmpl-tool-b10625d073fa5e8d",
      };
    },
  };
  expect(await generateSessionTitle(idProvider, "修复会话标题")).toBe("");

  const toolProvider = {
    provider: "test",
    model: "test",
    async *stream() {
      yield { type: "content" as const, text: "Valid looking title" };
      yield { type: "tool_call" as const, calls: [] };
    },
  };
  expect(await generateSessionTitle(toolProvider, "Fix session titles")).toBe(
    "",
  );
});

test("session title generation aborts on timeout and external cancellation", async () => {
  let timeoutAborted = false;
  const provider = {
    provider: "test",
    model: "test",
    async *stream(request: { signal?: AbortSignal }) {
      await new Promise<void>((resolve) => {
        request.signal?.addEventListener(
          "abort",
          () => {
            timeoutAborted = true;
            resolve();
          },
          { once: true },
        );
      });
      yield { type: "done" as const };
    },
  };
  await expect(
    generateSessionTitle(provider, "A valid title request", { timeoutMs: 10 }),
  ).rejects.toThrow("timed out");
  expect(timeoutAborted).toBe(true);

  const controller = new AbortController();
  const cancelled = generateSessionTitle(provider, "Another valid request", {
    signal: controller.signal,
    timeoutMs: 1_000,
  });
  controller.abort(new Error("runtime disposed"));
  await expect(cancelled).rejects.toThrow();
});

test("session title fallback and manual rename take precedence in JSON and SQLite", async () => {
  for (const useSqliteStore of [false, true]) {
    const root = await mkdtemp(join(tmpdir(), "natalia-session-title-"));
    const controller = createSessionStoreController({
      workspaceRoot: root,
      sessionID: () => "ses_host" as const,
      useSqliteStore,
      attachments: createAttachmentService(root),
    });
    await controller.init();
    try {
      await controller.create({ id: "ses_title" });
      await controller.setAutoTitle("ses_title", "Fallback topic", "fallback");
      await controller.rename("ses_title", "My manual topic");
      await controller.setAutoTitle(
        "ses_title",
        "Delayed generated topic",
        "generated",
      );
      const title = (await controller.list()).find(
        (item) => item.id === "ses_title",
      )?.title;
      expect(title).toBe("My manual topic");
      expect(fallbackSessionTitle("  Fix the cache. ")).toBe("Fix the cache");
    } finally {
      await controller.close();
    }
  }
});
