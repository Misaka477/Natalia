import { expect, test } from "bun:test";
import { createTestContext } from "@anthelia/runtime-services";
import { providerModelController } from "@anthelia/provider-model";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, LocalAttachment } from "@anthelia/contracts";
import { defaultConfigV3 } from "@anthelia/config";
import {
  ContextLedger,
  TokenMeter,
  type ProviderStreamRequest,
  type StreamingProvider,
} from "@anthelia/runtime";

import {
  attachmentService as attachmentServiceToken,
  createAttachmentService,
} from "@anthelia/attachments";
import type {
  RuntimeContext,
  SessionExecutionState,
} from "@anthelia/substrate";
import { createNaviChatTurn } from "@natalia/collab";
import { createNiaChatTurn } from "@natalia/collab";
import { createNaviChatSurface, createNiaChatSurface } from "@natalia/collab";

function pngBytes(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(24, 0x61);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

type Harness = {
  root: string;
  config: ReturnType<typeof defaultConfigV3>;
  events: RuntimeEvent[];
  requests: ProviderStreamRequest[];
  exec: SessionExecutionState;
  ctx: RuntimeContext;
  provider: StreamingProvider;
  store: (paths: string[]) => Promise<LocalAttachment[]>;
};

async function makeHarness(
  input: {
    imageInput?: boolean;
    videoInput?: boolean;
    providerImageInput?: boolean;
    providerVideoInput?: boolean;
  } = {},
): Promise<Harness> {
  const root = await mkdtemp(join(tmpdir(), "natalia-chat-attachment-"));
  const config = defaultConfigV3();
  config.providers.local = {
    name: "Local",
    driver: "openai",
    enabled: true,
    connection: { apiKey: "test-only" },
    requestDefaults: { stream: true, headers: {}, options: {} },
  };
  config.catalog.providers.local = {
    models: {
      chat: {
        name: "chat",
        status: "stable",
        source: "manual",
        capabilities: {
          toolCall: true,
          reasoning: true,
          thinking: true,
          imageInput: input.imageInput ?? false,
          videoInput: input.videoInput ?? false,
        },
        limits: { contextWindow: "auto", maxOutputTokens: null },
      },
    },
  };
  config.defaultModel = { provider: "local", model: "chat" };

  const requests: ProviderStreamRequest[] = [];
  const provider: StreamingProvider = {
    provider: "fake",
    model: "chat",
    imageInput: input.providerImageInput ?? true,
    videoInput: input.providerVideoInput ?? true,
    async *stream(request) {
      requests.push(request);
      yield { type: "content", text: "ok" };
      yield { type: "done", finishReason: "stop" };
    },
  };

  const events: RuntimeEvent[] = [];
  let sequence = 0;
  const attachmentService = createAttachmentService(root);
  const exec = {
    session: { id: "ses_chat_attachment", events },
    // This is an in-memory test event log, not a fast-attach tail: tell the
    // fact-state completion path there is no store page left to fetch.
    fullEventsLoaded: true,
    tokenMeter: new TokenMeter(),
    naviTokenMeter: new TokenMeter(),
    niaTokenMeter: new TokenMeter(),
    naviChatLedger: new ContextLedger(),
    niaChatLedger: new ContextLedger(),
    naviPendingQueue: [],
    niaPendingQueue: [],
  } as unknown as SessionExecutionState;
  const ctx = {
    // The chat turn path resolves services through the directory now; the
    // hand-rolled port stub stays for the paths still on ports.
    state: {
      // The chat turn path resolves services through the directory now; the
      // attachment service has a real double, everything else stays absent.
      serviceDirectory: createTestContext([
        attachmentServiceToken.mock(attachmentService),
      ]),
    },
    ports: {
      getTsRuntimeConfig: () => config,
      getContextWindowResolver: () => ({
        resolve: async () => ({ contextWindow: 200_000, source: "test" }),
      }),
      resolveContextStatusConfig: async () => ({
        max: 200_000,
        thresholdPercent: 85,
        reserved: 20_000,
      }),
      modelRefKeyForSelection: () => "local/chat",
      getChatDefaultProvider: () => provider,
      providerFromEnvironment: () => undefined,
      publishForSession: (_exec: unknown, event: RuntimeEvent) => {
        events.push(event);
      },
      nextChatSequence: () => sequence++,
      nextPlanSequence: () => sequence++,
      naviChatPersona: () => "<navi_chat_persona>Navi</navi_chat_persona>",
      naviChatLiveContext: () => "",
      niaChatPersona: () => "<nia_chat_persona>Nia</nia_chat_persona>",
      niaChatLiveContext: () => "",
      naviChatTools: () => [],
      niaChatTools: () => [],
      effectiveMaxSteps: () => 1,
      redactToolOutput: (text: string) => text,
      getWorkspaceRoot: () => root,
      getReady: async () => undefined,
      rememberTitleInput: () => undefined,
      resolveService: (name: string) =>
        name === attachmentServiceToken.id ? attachmentService : undefined,
    },
  } as unknown as RuntimeContext;
  return {
    root,
    config,
    events,
    requests,
    exec,
    ctx,
    provider,
    store: (paths) => attachmentService.store(paths),
  };
}

async function runChannel(
  channel: "navi" | "nia",
  harness: Harness,
  input: {
    text: string;
    responseMessageID: string;
    attachments?: LocalAttachment[];
  },
) {
  const event = {
    type:
      channel === "navi"
        ? ("navi.chat.message.new" as const)
        : ("nia.chat.message.new" as const),
    id: `${input.responseMessageID}:user`,
    messageID: `${input.responseMessageID}:user`,
    role: "user" as const,
    text: input.text,
    at: new Date().toISOString(),
    ...(input.attachments ? { attachments: input.attachments } : {}),
  } satisfies RuntimeEvent;
  harness.events.push(event);
  const signal = new AbortController().signal;
  const turnInput = { ...input, exec: harness.exec };
  if (channel === "navi")
    await createNaviChatTurn(harness.ctx).runNaviChatTurn(turnInput, signal);
  else await createNiaChatTurn(harness.ctx).runNiaChatTurn(turnInput, signal);
}

function lastUser(request: ProviderStreamRequest) {
  return request.messages.findLast((message) => message.role === "user");
}

function userMessages(request: ProviderStreamRequest) {
  return request.messages.filter((message) => message.role === "user");
}

test("Navi and Nia lower idle text attachments into provider content", async () => {
  for (const channel of ["navi", "nia"] as const) {
    const harness = await makeHarness();
    await writeFile(join(harness.root, "notes.txt"), "evidence\n");
    const [attachment] = await harness.store(["notes.txt"]);
    await runChannel(channel, harness, {
      text: "look",
      responseMessageID: `${channel}-text`,
      attachments: [attachment!],
    });
    const user = lastUser(harness.requests[0]!);
    expect(user?.content).toContain("[Attachment: notes.txt]\nevidence");
  }
});

test("Navi and Nia replay prior attachments into later provider turns", async () => {
  for (const channel of ["navi", "nia"] as const) {
    const harness = await makeHarness();
    await writeFile(join(harness.root, "history.txt"), "evidence");
    const [attachment] = await harness.store(["history.txt"]);
    await runChannel(channel, harness, {
      text: "first",
      responseMessageID: `${channel}-history-1`,
      attachments: [attachment!],
    });
    await runChannel(channel, harness, {
      text: "second",
      responseMessageID: `${channel}-history-2`,
    });
    const secondUser = userMessages(harness.requests[1]!).find((message) =>
      message.content.includes("first"),
    );
    expect(secondUser?.content).toContain(
      "[Attachment: history.txt]\nevidence",
    );
  }
});

test("Navi and Nia attach images only when the model and provider both support them", async () => {
  for (const channel of ["navi", "nia"] as const) {
    const supported = await makeHarness({ imageInput: true });
    await writeFile(join(supported.root, "image.png"), pngBytes());
    const [supportedAttachment] = await supported.store(["image.png"]);
    await runChannel(channel, supported, {
      text: "look",
      responseMessageID: `${channel}-image-supported`,
      attachments: [supportedAttachment!],
    });
    const supportedUser = lastUser(supported.requests[0]!);
    expect(supportedUser?.images).toHaveLength(1);
    expect(supportedUser?.content).not.toContain("[Attached image/png:");

    const unsupported = await makeHarness({
      imageInput: false,
      providerImageInput: true,
    });
    await writeFile(join(unsupported.root, "image.png"), pngBytes());
    const [unsupportedAttachment] = await unsupported.store(["image.png"]);
    await runChannel(channel, unsupported, {
      text: "look",
      responseMessageID: `${channel}-image-unsupported`,
      attachments: [unsupportedAttachment!],
    });
    const unsupportedUser = lastUser(unsupported.requests[0]!);
    expect(unsupportedUser?.images).toBeUndefined();
    expect(unsupportedUser?.content).toContain(
      "[Attached image/png: image.png]",
    );
  }
});

test("Navi and Nia attach videos only when the model and provider both support them", async () => {
  for (const channel of ["navi", "nia"] as const) {
    const supported = await makeHarness({ videoInput: true });
    await writeFile(
      join(supported.root, "clip.mp4"),
      Buffer.from("0000001866747970", "hex"),
    );
    const [supportedAttachment] = await supported.store(["clip.mp4"]);
    await runChannel(channel, supported, {
      text: "watch",
      responseMessageID: `${channel}-video-supported`,
      attachments: [supportedAttachment!],
    });
    const supportedUser = lastUser(supported.requests[0]!);
    expect(supportedUser?.videos).toHaveLength(1);
    expect(supportedUser?.content).not.toContain("[Attached video/mp4:");

    const unsupported = await makeHarness({
      videoInput: false,
      providerVideoInput: true,
    });
    await writeFile(
      join(unsupported.root, "clip.mp4"),
      Buffer.from("0000001866747970", "hex"),
    );
    const [unsupportedAttachment] = await unsupported.store(["clip.mp4"]);
    await runChannel(channel, unsupported, {
      text: "watch",
      responseMessageID: `${channel}-video-unsupported`,
      attachments: [unsupportedAttachment!],
    });
    const unsupportedUser = lastUser(unsupported.requests[0]!);
    expect(unsupportedUser?.videos).toBeUndefined();
    expect(unsupportedUser?.content).toContain(
      "[Attached video/mp4: clip.mp4]",
    );
  }
});

test("busy chat queues carry attachments and drain them per message", async () => {
  for (const channel of ["navi", "nia"] as const) {
    const harness = await makeHarness();
    await writeFile(join(harness.root, "one.txt"), "first");
    await writeFile(join(harness.root, "two.txt"), "second");
    const [one, two] = await harness.store(["one.txt", "two.txt"]);
    const queue =
      channel === "navi"
        ? harness.exec.naviPendingQueue
        : harness.exec.niaPendingQueue;
    queue.push(
      {
        messageID: "pending-one",
        text: "first pending",
        attachments: [one!],
      },
      {
        messageID: "pending-two",
        text: "second pending",
        attachments: [two!],
      },
    );

    await runChannel(channel, harness, {
      text: "start",
      responseMessageID: `${channel}-pending`,
    });
    const users = userMessages(harness.requests[0]!);
    expect(users[users.length - 2]?.content).toContain(
      "[Attachment: one.txt]\nfirst",
    );
    expect(users[users.length - 1]?.content).toContain(
      "[Attachment: two.txt]\nsecond",
    );
  }
});

test("Navi and Nia busy submits store the same attachments in their pending queue", async () => {
  for (const channel of ["navi", "nia"] as const) {
    const harness = await makeHarness();
    await writeFile(join(harness.root, "queued.txt"), "queued");
    const attachmentService = createAttachmentService(harness.root);
    const controller = {
      runTurn: async () => undefined,
      runNaviChatTurn: async () => undefined,
      runNiaChatTurn: async () => undefined,
      requestNaviWake: () => undefined,
      requestNiaWake: () => undefined,
      naviBusy: () => true,
      niaBusy: () => true,
      abortNavi: () => false,
      abortNia: () => false,
      dispose: async () => undefined,
    };
    harness.ctx.ports.getExecutionBySession = () =>
      new Map([[harness.exec.session.id, harness.exec]]);
    harness.ctx.ports.ensureExecution = async () => harness.exec;
    harness.ctx.ports.resolveService = ((name: string) => {
      if (name === attachmentServiceToken.id) return attachmentService;
      return undefined;
    }) as typeof harness.ctx.ports.resolveService;
    harness.ctx.state.serviceDirectory = createTestContext([
      providerModelController.mock(controller),
      attachmentServiceToken.mock(attachmentService),
    ]);
    const surface =
      channel === "navi"
        ? createNaviChatSurface(harness.ctx)
        : createNiaChatSurface(harness.ctx);
    await surface.submit({
      text: "busy",
      sessionID: harness.exec.session.id,
      attachments: ["queued.txt"],
    });
    const queue =
      channel === "navi"
        ? harness.exec.naviPendingQueue
        : harness.exec.niaPendingQueue;
    expect(queue).toHaveLength(1);
    expect(queue[0]?.attachments?.[0]?.filename).toBe("queued.txt");
  }
});

test("chat PDF attachments are diagnosed and never reach the provider", async () => {
  const harness = await makeHarness({ imageInput: true, videoInput: true });
  const pdf = {
    id: "att_pdf",
    path: ".natalia/attachments/att_pdf-report.pdf",
    filename: "report.pdf",
    mediaType: "application/pdf",
    byteLength: 4,
    sha256: "pdf-hash",
  } as unknown as LocalAttachment;
  await runChannel("navi", harness, {
    text: "read",
    responseMessageID: "navi-pdf",
    attachments: [pdf],
  });
  const user = lastUser(harness.requests[0]!);
  expect(user?.images).toBeUndefined();
  expect(user?.videos).toBeUndefined();
  expect(user?.content).not.toContain("report.pdf");
  expect(
    harness.events.some(
      (event) =>
        event.type === "diagnostic" &&
        event.message.includes("Unsupported attachment report.pdf"),
    ),
  ).toBe(true);
});
