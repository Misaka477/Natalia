import { expect, test } from "bun:test";
import type { LocalAttachment, RuntimeEvent } from "@anthelia/contracts";
import { contextLedgerFactory, createContextLedgerFactory } from "../src";

test("context ledger restores completed turns and tool pairs once", () => {
  const attachment: LocalAttachment = {
    id: "att-1",
    path: ".natalia/attachments/att-1.png",
    filename: "diagram.png",
    mediaType: "image/png",
    byteLength: 3,
    sha256: "fixture",
  };
  const events: RuntimeEvent[] = [
    {
      type: "turn.submitted",
      id: "turn-1",
      text: "inspect",
      byteLength: 7,
      lineCount: 1,
      sha256: "input",
      attachments: [attachment],
    },
    { type: "content.delta", id: "turn-1", text: "partial" },
    { type: "content.done", id: "turn-1", text: "final answer" },
    {
      type: "tool.update",
      id: "turn-1:tool",
      callID: "call-1",
      name: "read_file",
      status: "receiving_arguments",
      summary: "receiving",
      argumentsDelta: '{"path":"a.txt"}',
    },
    {
      type: "tool.update",
      id: "turn-1:tool",
      callID: "call-1",
      name: "read_file",
      status: "queued",
      summary: "queued",
    },
    {
      type: "tool.update",
      id: "turn-1:tool",
      callID: "call-1",
      name: "read_file",
      status: "succeeded",
      summary: "read",
      result: "contents",
    },
    {
      type: "tool.update",
      id: "turn-1:tool",
      callID: "call-1",
      name: "read_file",
      status: "succeeded",
      summary: "duplicate",
      result: "duplicate",
    },
    { type: "turn.finished", id: "turn-1", stopReason: "done" },
    { type: "content.delta", id: "turn-incomplete", text: "discard me" },
  ];

  const factory = createContextLedgerFactory();
  const context = factory.create();
  factory.restore(context, events);
  expect(context.snapshot().entries).toEqual([
    expect.objectContaining({
      id: "turn-1:user",
      role: "user",
      content: "inspect",
      attachments: [attachment],
    }),
    expect.objectContaining({
      role: "tool_call",
      pairID: "call-1",
      content: 'read_file {"path":"a.txt"}',
    }),
    expect.objectContaining({
      role: "tool_result",
      pairID: "call-1",
      content: "contents",
    }),
    expect.objectContaining({
      id: "turn-1:assistant",
      role: "assistant",
      content: "final answer",
    }),
  ]);
});

test("context ledger restores provider reasoning and tool thought signatures", () => {
  const events: RuntimeEvent[] = [
    {
      type: "turn.submitted",
      id: "turn-reasoning",
      text: "inspect",
      byteLength: 7,
      lineCount: 1,
      sha256: "input",
    },
    {
      type: "thinking.done",
      id: "turn-reasoning",
      text: "need to read the file",
      reasoningField: "reasoning_content",
      reasoningSignature: "signature-1",
      reasoningBlocks: [
        { text: "need to read the file", signature: "signature-1" },
      ],
    },
    {
      type: "content.done",
      id: "turn-reasoning",
      text: "answer",
      textSignature: "text-signature",
      contentParts: [{ type: "text", text: "answer" }],
      providerMetadata: {
        openrouter: {
          reasoning_details: [{ type: "reasoning.text", text: "thinking" }],
        },
      },
    },
    {
      type: "tool.update",
      id: "turn-reasoning:call-1",
      callID: "call-1",
      name: "read_file",
      status: "succeeded",
      summary: "read",
      argumentsDelta: '{"path":"a.txt"}',
      result: "contents",
      thoughtSignature: "tool-signature",
    },
    { type: "turn.finished", id: "turn-reasoning", stopReason: "done" },
  ];
  const factory = createContextLedgerFactory();
  const context = factory.create();
  factory.restore(context, events);
  expect(context.snapshot().entries).toContainEqual(
    expect.objectContaining({
      role: "tool_call",
      pairID: "call-1",
      reasoningContent: "need to read the file",
      reasoningField: "reasoning_content",
      reasoningSignature: "signature-1",
      reasoningBlocks: [
        { text: "need to read the file", signature: "signature-1" },
      ],
      textSignature: "text-signature",
      contentParts: [{ type: "text", text: "answer" }],
      providerMetadata: {
        openrouter: {
          reasoning_details: [{ type: "reasoning.text", text: "thinking" }],
        },
      },
      thoughtSignature: "tool-signature",
    }),
  );
});

test("context ledger factory is provided under the shared service key", () => {
  const factory = createContextLedgerFactory();
  expect(contextLedgerFactory.id).toBe("context-ledger.factory");
  expect(factory.create).toBeTypeOf("function");
  expect(factory.restore).toBeTypeOf("function");
});

test("context ledger restores an injected next-step message", () => {
  const events: RuntimeEvent[] = [
    {
      type: "turn.submitted",
      id: "turn-1",
      text: "start",
      byteLength: 5,
      lineCount: 1,
      sha256: "x",
    },
    {
      type: "turn.input",
      turnID: "turn-1",
      inputID: "in-1",
      text: "also do X",
      delivery: "next-step",
    },
    { type: "content.done", id: "turn-1", text: "done" },
    { type: "turn.finished", id: "turn-1", stopReason: "done" },
  ];
  const factory = createContextLedgerFactory();
  const context = factory.create();
  factory.restore(context, events);
  expect(context.snapshot().entries).toEqual([
    expect.objectContaining({
      id: "turn-1:user",
      role: "user",
      content: "start",
    }),
    expect.objectContaining({
      id: "in-1:user",
      role: "user",
      content: "also do X",
    }),
    expect.objectContaining({
      id: "turn-1:assistant",
      role: "assistant",
      content: "done",
    }),
  ]);
});
