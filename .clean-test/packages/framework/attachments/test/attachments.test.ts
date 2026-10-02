import { expect, test } from "bun:test";
import { mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LocalAttachment } from "@anthelia/contracts";
import { attachmentService } from "../src";
import {
  attachmentDataURL,
  attachmentText,
  cleanupUnreferencedAttachments,
  createAttachmentService,
  storeLocalAttachments,
} from "../src";

function pngBytes(width = 1, height = 1, totalBytes = 24): Buffer {
  const bytes = Buffer.alloc(totalBytes, 0x61);
  Buffer.from("89504e470d0a1a0a", "hex").copy(bytes, 0);
  bytes.writeUInt32BE(13, 8);
  bytes.write("IHDR", 12, "ascii");
  bytes.writeUInt32BE(width, 16);
  bytes.writeUInt32BE(height, 20);
  return bytes;
}

function webpBytes(width = 1, height = 1): Buffer {
  const bytes = Buffer.alloc(30);
  Buffer.from("524946460000000057454250", "hex").copy(bytes, 0);
  bytes.write("VP8L", 12, "ascii");
  bytes[20] = 0x2f;
  const header = (width - 1) | ((height - 1) << 14);
  bytes.writeUInt32LE(header, 21);
  return bytes;
}

test("local attachment store rejects workspace escapes and extension spoofing", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-attachment-store-"));
  const outside = await mkdtemp(join(tmpdir(), "natalia-attachment-outside-"));
  await writeFile(join(root, "spoof.png"), "not an image");
  await writeFile(join(outside, "image.png"), pngBytes());
  await expect(
    storeLocalAttachments({ workspaceRoot: root, paths: ["spoof.png"] }),
  ).rejects.toThrow("attachment type is unsupported");
  await expect(
    storeLocalAttachments({
      workspaceRoot: root,
      paths: [join(outside, "image.png")],
    }),
  ).rejects.toThrow("attachment path escapes workspace");
});

test("attachment store accepts an in-workspace name that starts with '..'", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-attachment-dotdot-"));
  await writeFile(join(root, "..config.png"), pngBytes());
  // A name that merely starts with ".." is in-workspace, not an escape — the
  // check matches the whole leading path segment, not a ".." prefix.
  const stored = await storeLocalAttachments({
    workspaceRoot: root,
    paths: ["..config.png"],
  });
  expect(stored).toHaveLength(1);
  expect(stored[0].filename).toBe("..config.png");
});

test("attachment store accepts a workspace reached through a symlink", async () => {
  const real = await mkdtemp(join(tmpdir(), "natalia-attachment-real-"));
  const link = `${real}-link`;
  await symlink(real, link);
  try {
    await writeFile(join(real, "image.png"), pngBytes());
    // The source is realpath'd, so the root must be too; comparing a lexical
    // root to a canonical source made every in-workspace path look like an escape.
    const stored = await storeLocalAttachments({
      workspaceRoot: link,
      paths: ["image.png"],
    });
    expect(stored).toHaveLength(1);
    expect(stored[0].filename).toBe("image.png");
    // The reader must agree with the store: reading the stored attachment back
    // through the same symlinked root must not look like an escape either.
    const dataURL = await attachmentDataURL(link, stored[0]);
    expect(dataURL.startsWith("data:image/png;base64,")).toBe(true);
  } finally {
    await rm(link, { recursive: true, force: true });
  }
});

test("attachment cleanup removes only unreferenced Natalia attachment files", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-attachment-cleanup-"));
  await writeFile(join(root, "image.png"), pngBytes());
  const [attachment] = await storeLocalAttachments({
    workspaceRoot: root,
    paths: ["image.png"],
  });
  const store = join(root, ".natalia", "attachments");
  await writeFile(join(store, "att_orphan.png"), "orphan");
  await writeFile(join(store, "user-note.txt"), "do not delete");
  expect(
    await cleanupUnreferencedAttachments({
      workspaceRoot: root,
      attachments: [attachment!],
    }),
  ).toEqual(["att_orphan.png"]);
  expect(await Bun.file(join(store, "att_orphan.png")).exists()).toBe(false);
  expect(await Bun.file(join(store, "user-note.txt")).exists()).toBe(true);
});

test("local attachment store derives a private data URL from validated bytes", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-attachment-data-url-"));
  await writeFile(join(root, "image.png"), pngBytes());
  const [attachment] = await storeLocalAttachments({
    workspaceRoot: root,
    paths: ["image.png"],
  });
  expect(attachment).toBeDefined();
  expect(attachment).toMatchObject({ width: 1, height: 1 });
  expect(await attachmentDataURL(root, attachment!)).toMatch(
    /^data:image\/png;base64,/u,
  );
});

test("local attachment store rejects PDF attachments", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-attachment-pdf-"));
  await writeFile(join(root, "doc.pdf"), "%PDF-1.7 fake");
  await expect(
    storeLocalAttachments({
      workspaceRoot: root,
      paths: ["doc.pdf"],
    }),
  ).rejects.toThrow(/unsupported/u);
});

test("local attachment store recognizes webp, gif, mp4 and webm signatures", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-attachment-media-"));
  const cases: Array<[string, Uint8Array, LocalAttachment["mediaType"]]> = [
    ["pic.webp", webpBytes(), "image/webp"],
    ["anim.gif", Buffer.from("47494638396101000100", "hex"), "image/gif"],
    ["clip.mp4", Buffer.from("000000186674797000000000", "hex"), "video/mp4"],
    ["clip.webm", Buffer.from("1a45dfa3", "hex"), "video/webm"],
  ];
  for (const [filename, bytes, expected] of cases) {
    await writeFile(join(root, filename), bytes);
    const [attachment] = await storeLocalAttachments({
      workspaceRoot: root,
      paths: [filename],
    });
    expect(attachment.mediaType, filename).toBe(expected);
  }
});

test("image attachments enforce per-file, count, aggregate, and pixel limits", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-attachment-limits-"));
  const big = pngBytes(1, 1, 5 * 1024 * 1024 + 1);
  await writeFile(join(root, "big.png"), big);
  await expect(
    storeLocalAttachments({ workspaceRoot: root, paths: ["big.png"] }),
  ).rejects.toThrow("exceeds 5242880 bytes");

  const tooManyPixels = pngBytes(7_000, 7_000);
  await writeFile(join(root, "pixels.png"), tooManyPixels);
  await expect(
    storeLocalAttachments({ workspaceRoot: root, paths: ["pixels.png"] }),
  ).rejects.toThrow("pixel limit");

  const small = pngBytes();
  await writeFile(join(root, "small.png"), small);
  await expect(
    storeLocalAttachments({
      workspaceRoot: root,
      paths: Array.from({ length: 21 }, () => "small.png"),
    }),
  ).rejects.toThrow("too many image attachments (max 20)");

  const aggregateA = pngBytes(1, 1, 4 * 1024 * 1024);
  const aggregateB = pngBytes(1, 1, 4 * 1024 * 1024);
  await writeFile(join(root, "aggregate-a.png"), aggregateA);
  await writeFile(join(root, "aggregate-b.png"), aggregateB);
  await expect(
    storeLocalAttachments({
      workspaceRoot: root,
      paths: ["aggregate-a.png", "aggregate-b.png"],
      limits: { maxMessageImageBytes: 6 * 1024 * 1024 },
    }),
  ).rejects.toThrow("exceed 6291456 aggregate bytes");
});

test("text attachments remain outside the image ceiling", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-attachment-large-"));
  const text = Buffer.alloc(2 * 1024 * 1024, 0x61);
  await writeFile(join(root, "big.txt"), text);
  const [textAttachment] = await storeLocalAttachments({
    workspaceRoot: root,
    paths: ["big.txt"],
  });
  expect(textAttachment.mediaType).toBe("text/plain");
  const read = await attachmentText(root, textAttachment);
  expect(read.length).toBe(2 * 1024 * 1024);
});

test("attachment.upload bytes are sniffed and bounded before storage", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-attachment-bytes-"));
  const service = createAttachmentService(root);
  await expect(
    service.storeBytes({
      name: "spoof.png",
      mediaType: "image/png",
      data: Buffer.from("not an image"),
    }),
  ).rejects.toThrow("unsupported or does not match");
  await expect(
    service.storeBytes({
      name: "too-big.png",
      mediaType: "image/png",
      data: pngBytes(1, 1, 5 * 1024 * 1024 + 1),
    }),
  ).rejects.toThrow("exceeds 5242880 bytes");
  const stored = await service.storeBytes({
    name: "ok.png",
    mediaType: "image/png",
    data: pngBytes(2, 3),
  });
  expect(stored).toMatchObject({ width: 2, height: 3 });
});

test("local attachment store admits bounded UTF-8 text with a durable filename", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-attachment-text-"));
  await writeFile(join(root, "notes.md"), "# Notes\r\nhello\r\n");
  const [attachment] = await storeLocalAttachments({
    workspaceRoot: root,
    paths: ["notes.md"],
  });
  expect(attachment).toMatchObject({
    filename: "notes.md",
    mediaType: "text/plain",
  });
  expect(await attachmentText(root, attachment!)).toBe("# Notes\nhello\n");
});

test("attachment service is a framework service with a durable store", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-attachment-service-"));
  await writeFile(join(root, "image.png"), pngBytes());
  const service = createAttachmentService(root);
  expect(attachmentService.id).toBe("attachment.service");
  expect(service.store).toBeTypeOf("function");
  expect(service.dataURL).toBeTypeOf("function");
  expect(service.text).toBeTypeOf("function");
  expect(service.cleanup).toBeTypeOf("function");
  expect(service.referencedForSessions).toBeTypeOf("function");

  const [attachment] = await service.store(["image.png"]);
  expect(attachment).toBeDefined();
  expect(await service.dataURL(attachment!)).toMatch(
    /^data:image\/png;base64,/u,
  );
});
