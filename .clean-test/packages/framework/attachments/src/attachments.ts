import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readdir,
  realpath,
  rm,
  stat,
  writeFile,
} from "node:fs/promises";
import { basename, isAbsolute, join, relative, resolve } from "node:path";
import type { LocalAttachment } from "@anthelia/contracts";
import { modelVisibleEvents, type SessionRecord } from "@anthelia/session";
import { DEFAULT_MAX_IMAGE_LONG_EDGE, scaleImage } from "./image-scale";

export type AttachmentLimits = {
  /** Maximum bytes for one image attachment. */
  maxImageBytes: number;
  /** Maximum number of image attachments accepted in one batch. */
  maxImagesPerMessage: number;
  /** Maximum aggregate bytes for image attachments in one batch. */
  maxMessageImageBytes: number;
  /** Maximum decoded pixels for one image attachment. */
  maxImagePixels: number;
  /**
   * Longest edge allowed before an image is scaled down. Anthropic resamples
   * anything over 1568px itself, so scaling here first keeps the stored bytes
   * deterministic and far smaller. Scaled once at admission and never again.
   */
  maxImageLongEdge: number;
};

/** Reference limits from the attachment research pass; callers may override. */
export const DEFAULT_ATTACHMENT_LIMITS: AttachmentLimits = {
  maxImageBytes: 5 * 1024 * 1024,
  maxImagesPerMessage: 20,
  maxMessageImageBytes: 100 * 1024 * 1024,
  maxImagePixels: 40_000_000,
  maxImageLongEdge: DEFAULT_MAX_IMAGE_LONG_EDGE,
};

function resolveAttachmentLimits(
  overrides: Partial<AttachmentLimits> | undefined,
): AttachmentLimits {
  return { ...DEFAULT_ATTACHMENT_LIMITS, ...overrides };
}

/**
 * Apply the one-time admission-time downscale. Returns the bytes and dimensions
 * that will be stored, which are the originals unless the image was over the
 * long-edge limit and the codec succeeded.
 *
 * Doing this before anything is written keeps the stored file, its sha256 and
 * its recorded dimensions in agreement — a caller that copies the source file
 * while reporting a scaled hash would disagree with itself.
 */
async function prepareImageForStorage(input: {
  bytes: Uint8Array;
  mediaType: string;
  dimensions: ImageDimensions | undefined;
  limits: AttachmentLimits;
}): Promise<{ bytes: Uint8Array; dimensions: ImageDimensions | undefined }> {
  if (!input.dimensions) return { bytes: input.bytes, dimensions: undefined };
  const scaled = await scaleImage({
    bytes: input.bytes,
    mediaType: input.mediaType,
    maxLongEdge: input.limits.maxImageLongEdge,
  });
  if (!scaled) return { bytes: input.bytes, dimensions: input.dimensions };
  return {
    bytes: scaled.bytes,
    dimensions: { width: scaled.width, height: scaled.height },
  };
}

type ImageDimensions = { width: number; height: number };

function assertImageAdmission(input: {
  bytes: Uint8Array;
  mediaType: LocalAttachment["mediaType"];
  label: string;
  limits: AttachmentLimits;
}): ImageDimensions {
  if (!input.mediaType.startsWith("image/"))
    throw new Error(`attachment is not an image: ${input.label}`);
  if (input.bytes.byteLength > input.limits.maxImageBytes)
    throw new Error(
      `image attachment exceeds ${input.limits.maxImageBytes} bytes: ${input.label}`,
    );
  const dimensions = readImageDimensions(input.bytes, input.mediaType);
  if (
    !dimensions ||
    dimensions.width <= 0 ||
    dimensions.height <= 0 ||
    dimensions.width * dimensions.height > input.limits.maxImagePixels
  )
    throw new Error(
      `image attachment exceeds pixel limit or has invalid dimensions: ${input.label}`,
    );
  return dimensions;
}

/**
 * True when `candidate` escapes `canonicalDir`. Both must already be realpath'd
 * so a symlinked root cannot make an in-dir path look like an escape. A real
 * escape is a leading ".." path SEGMENT or an absolute result (a different
 * drive on Windows); matching the whole first segment, not a ".." prefix, keeps
 * an in-dir name like "..config" from being misreported.
 *
 * The single confinement check for the attachment store and its readers — kept
 * in one place because the copies had drifted (a stale startsWith("..") form
 * survived in the readers after the store was corrected).
 */
function escapesDir(canonicalDir: string, candidate: string): boolean {
  const rel = relative(canonicalDir, candidate);
  return isAbsolute(rel) || rel.split(/[/\\]/u)[0] === "..";
}
export async function storeLocalAttachments(input: {
  workspaceRoot: string;
  paths: string[];
  limits?: Partial<AttachmentLimits>;
}) {
  const root = resolve(input.workspaceRoot);
  const store = join(root, ".natalia", "attachments");
  const limits = resolveAttachmentLimits(input.limits);
  await mkdir(store, { recursive: true, mode: 0o700 });
  // The containment check compares against the source's realpath, so the root
  // must be realpath'd too — otherwise a workspace reached through a symlink
  // (e.g. a macOS /tmp workspace) makes every in-workspace path look like an
  // escape. Store/return paths stay relative to the lexical root for read-back.
  const canonicalRoot = await realpath(root);

  const accepted: Array<{
    source: string;
    bytes: Uint8Array;
    filename: string;
    mediaType: LocalAttachment["mediaType"];
    byteLength: number;
    dimensions?: ImageDimensions;
  }> = [];
  let imageCount = 0;
  let imageBytes = 0;
  for (const path of input.paths) {
    const source = await realpath(resolve(root, path));
    if (escapesDir(canonicalRoot, source))
      throw new Error(`attachment path escapes workspace: ${path}`);
    const info = await stat(source);
    if (!info.isFile()) throw new Error(`attachment is not a file: ${path}`);
    const bytes = new Uint8Array(await Bun.file(source).arrayBuffer());
    const filename = basename(source);
    const mediaType = mediaTypeForBytes(bytes, filename);
    if (!mediaType) throw new Error(`attachment type is unsupported: ${path}`);
    const dimensions = mediaType.startsWith("image/")
      ? (() => {
          imageCount += 1;
          imageBytes += bytes.byteLength;
          if (imageCount > limits.maxImagesPerMessage)
            throw new Error(
              `too many image attachments (max ${limits.maxImagesPerMessage})`,
            );
          if (imageBytes > limits.maxMessageImageBytes)
            throw new Error(
              `image attachments exceed ${limits.maxMessageImageBytes} aggregate bytes`,
            );
          return assertImageAdmission({
            bytes,
            mediaType,
            label: path,
            limits,
          });
        })()
      : undefined;
    // Scale before the bytes enter the accepted set, so everything downstream
    // — the stored file, its sha256, its recorded byteLength and dimensions —
    // describes the same representation.
    const prepared = await prepareImageForStorage({
      bytes,
      mediaType,
      dimensions,
      limits,
    });
    accepted.push({
      source,
      bytes: prepared.bytes,
      filename,
      mediaType,
      byteLength: prepared.bytes.byteLength,
      ...(prepared.dimensions ? { dimensions: prepared.dimensions } : {}),
    });
  }

  return await Promise.all(
    accepted.map(async (item) => {
      const id = `att_${randomUUID().replace(/-/gu, "")}`;
      const target = join(store, `${id}-${item.filename}`);
      // Write the prepared bytes rather than copying the source: they differ
      // whenever the image was scaled, and the recorded sha256 hashes them.
      await writeFile(target, item.bytes, { mode: 0o600 });
      return {
        id,
        path: relative(root, target),
        filename: item.filename,
        mediaType: item.mediaType,
        byteLength: item.byteLength,
        sha256: createHash("sha256").update(item.bytes).digest("hex"),
        ...(item.dimensions
          ? { width: item.dimensions.width, height: item.dimensions.height }
          : {}),
      } satisfies LocalAttachment;
    }),
  );
}

export async function storeLocalAttachmentBytes(input: {
  workspaceRoot: string;
  name: string;
  mediaType: string;
  data: Uint8Array;
  limits?: Partial<AttachmentLimits>;
}): Promise<LocalAttachment> {
  const root = resolve(input.workspaceRoot);
  const store = join(root, ".natalia", "attachments");
  const limits = resolveAttachmentLimits(input.limits);
  await mkdir(store, { recursive: true, mode: 0o700 });
  const filename = basename(input.name || "attachment");
  const mediaType = mediaTypeForBytes(input.data, filename);
  if (!mediaType)
    throw new Error(
      `attachment type is unsupported or does not match its bytes: ${filename}`,
    );
  const dimensions = mediaType.startsWith("image/")
    ? assertImageAdmission({
        bytes: input.data,
        mediaType,
        label: filename,
        limits,
      })
    : undefined;
  const prepared = await prepareImageForStorage({
    bytes: input.data,
    mediaType,
    dimensions,
    limits,
  });
  const id = `att_${randomUUID().replace(/-/gu, "")}`;
  const target = join(store, `${id}-${filename}`);
  await writeFile(target, prepared.bytes, { mode: 0o600 });
  return {
    id,
    path: relative(root, target),
    filename,
    mediaType,
    byteLength: prepared.bytes.byteLength,
    sha256: createHash("sha256").update(prepared.bytes).digest("hex"),
    ...(prepared.dimensions
      ? { width: prepared.dimensions.width, height: prepared.dimensions.height }
      : {}),
  } satisfies LocalAttachment;
}

export async function attachmentDataURL(
  workspaceRoot: string,
  attachment: LocalAttachment,
) {
  const root = resolve(workspaceRoot);
  const path = await realpath(resolve(root, attachment.path));
  // realpath the store too, so a symlinked workspace does not make an in-store
  // path look like an escape (the store write and this read must agree).
  const store = await realpath(join(root, ".natalia", "attachments"));
  if (escapesDir(store, path))
    throw new Error(`attachment store path escapes root: ${attachment.id}`);
  const bytes = new Uint8Array(await Bun.file(path).arrayBuffer());
  return `data:${attachment.mediaType};base64,${Buffer.from(bytes).toString("base64")}`;
}

export async function attachmentText(
  workspaceRoot: string,
  attachment: LocalAttachment,
) {
  if (!isTextAttachment(attachment))
    throw new Error(`attachment is not text: ${attachment.id}`);
  const root = resolve(workspaceRoot);
  const path = await realpath(resolve(root, attachment.path));
  // realpath the store too, so a symlinked workspace does not make an in-store
  // path look like an escape (the store write and this read must agree).
  const store = await realpath(join(root, ".natalia", "attachments"));
  if (escapesDir(store, path))
    throw new Error(`attachment store path escapes root: ${attachment.id}`);
  return new TextDecoder("utf-8", { fatal: true })
    .decode(await Bun.file(path).arrayBuffer())
    .replace(/\r\n/g, "\n")
    .replace(/\r/g, "\n");
}

export function isTextAttachment(attachment: LocalAttachment) {
  return (
    attachment.mediaType.startsWith("text/") ||
    attachment.mediaType === "application/json"
  );
}

export async function cleanupUnreferencedAttachments(input: {
  workspaceRoot: string;
  attachments: LocalAttachment[];
}) {
  const store = join(resolve(input.workspaceRoot), ".natalia", "attachments");
  const referenced = new Set(
    input.attachments.map((attachment) => basename(attachment.path)),
  );
  const entries = await readdir(store, { withFileTypes: true }).catch(() => []);
  const orphaned = entries.filter(
    (entry) =>
      entry.isFile() &&
      entry.name.startsWith("att_") &&
      !referenced.has(entry.name),
  );
  await Promise.all(
    orphaned.map((entry) => rm(join(store, entry.name), { force: true })),
  );
  return orphaned.map((entry) => entry.name);
}

export function referencedAttachmentsForSessions(sessions: SessionRecord[]) {
  return sessions.flatMap((record) => {
    const checkpoint = [...record.events]
      .reverse()
      .find((event) => event.type === "context.checkpoint");
    const checkpointAttachments =
      checkpoint?.type === "context.checkpoint"
        ? checkpoint.snapshot.entries.flatMap(
            (entry) => entry.attachments ?? [],
          )
        : [];
    return [
      ...checkpointAttachments,
      ...modelVisibleEvents(record.events).flatMap((event) =>
        event.type === "turn.submitted" ? (event.attachments ?? []) : [],
      ),
      ...(record.inbox?.flatMap((input) => input.attachments ?? []) ?? []),
    ];
  });
}

function readImageDimensions(
  bytes: Uint8Array,
  mediaType: LocalAttachment["mediaType"],
): ImageDimensions | undefined {
  if (mediaType === "image/png") return pngDimensions(bytes);
  if (mediaType === "image/jpeg") return jpegDimensions(bytes);
  if (mediaType === "image/gif") return gifDimensions(bytes);
  if (mediaType === "image/webp") return webpDimensions(bytes);
  return undefined;
}

function pngDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (
    bytes.length < 24 ||
    bytes[0] !== 0x89 ||
    bytes[1] !== 0x50 ||
    bytes[2] !== 0x4e ||
    bytes[3] !== 0x47 ||
    bytes[4] !== 0x0d ||
    bytes[5] !== 0x0a ||
    bytes[6] !== 0x1a ||
    bytes[7] !== 0x0a
  )
    return undefined;
  return {
    width: readUInt32BE(bytes, 16),
    height: readUInt32BE(bytes, 20),
  };
}

function gifDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (
    bytes.length < 10 ||
    bytes[0] !== 0x47 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x38 ||
    (bytes[4] !== 0x37 && bytes[4] !== 0x39) ||
    bytes[5] !== 0x61
  )
    return undefined;
  return {
    width: readUInt16LE(bytes, 6),
    height: readUInt16LE(bytes, 8),
  };
}

function jpegDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (
    bytes.length < 4 ||
    bytes[0] !== 0xff ||
    bytes[1] !== 0xd8 ||
    bytes[2] !== 0xff
  )
    return undefined;
  let offset = 2;
  while (offset + 4 <= bytes.length) {
    if (bytes[offset] !== 0xff) {
      offset += 1;
      continue;
    }
    const marker = bytes[offset + 1]!;
    if (marker === 0xff) {
      offset += 1;
      continue;
    }
    offset += 2;
    if (
      marker === 0xd8 ||
      marker === 0xd9 ||
      (marker >= 0xd0 && marker <= 0xd7)
    )
      continue;
    if (marker === 0xda) break;
    if (offset + 2 > bytes.length) break;
    const length = readUInt16BE(bytes, offset);
    if (length < 2 || offset + length > bytes.length) return undefined;
    const isStartOfFrame =
      (marker >= 0xc0 && marker <= 0xc3) ||
      (marker >= 0xc5 && marker <= 0xc7) ||
      (marker >= 0xc9 && marker <= 0xcb) ||
      (marker >= 0xcd && marker <= 0xcf);
    if (isStartOfFrame) {
      if (offset + 7 > bytes.length) return undefined;
      return {
        height: readUInt16BE(bytes, offset + 3),
        width: readUInt16BE(bytes, offset + 5),
      };
    }
    offset += length;
  }
  return undefined;
}

function webpDimensions(bytes: Uint8Array): ImageDimensions | undefined {
  if (
    bytes.length < 30 ||
    bytes[0] !== 0x52 ||
    bytes[1] !== 0x49 ||
    bytes[2] !== 0x46 ||
    bytes[3] !== 0x46 ||
    bytes[8] !== 0x57 ||
    bytes[9] !== 0x45 ||
    bytes[10] !== 0x42 ||
    bytes[11] !== 0x50
  )
    return undefined;
  const chunk = String.fromCharCode(
    bytes[12]!,
    bytes[13]!,
    bytes[14]!,
    bytes[15]!,
  );
  if (chunk === "VP8X")
    return {
      width: 1 + readUInt24LE(bytes, 24),
      height: 1 + readUInt24LE(bytes, 27),
    };
  if (chunk === "VP8 " && bytes[23] === 0x9d && bytes[24] === 0x01) {
    if (bytes[25] !== 0x2a) return undefined;
    return {
      width: readUInt16LE(bytes, 26) & 0x3fff,
      height: readUInt16LE(bytes, 28) & 0x3fff,
    };
  }
  if (chunk === "VP8L" && bytes[20] === 0x2f) {
    const header = readUInt32LE(bytes, 21);
    return {
      width: (header & 0x3fff) + 1,
      height: ((header >> 14) & 0x3fff) + 1,
    };
  }
  return undefined;
}

function readUInt16BE(bytes: Uint8Array, offset: number): number {
  return (bytes[offset]! << 8) | bytes[offset + 1]!;
}

function readUInt32BE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! * 0x1000000 +
    ((bytes[offset + 1]! << 16) |
      (bytes[offset + 2]! << 8) |
      bytes[offset + 3]!)
  );
}

function readUInt16LE(bytes: Uint8Array, offset: number): number {
  return bytes[offset]! | (bytes[offset + 1]! << 8);
}

function readUInt24LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! | (bytes[offset + 1]! << 8) | (bytes[offset + 2]! << 16)
  );
}

function readUInt32LE(bytes: Uint8Array, offset: number): number {
  return (
    bytes[offset]! +
    bytes[offset + 1]! * 0x100 +
    bytes[offset + 2]! * 0x10000 +
    bytes[offset + 3]! * 0x1000000
  );
}

function mediaTypeForBytes(
  bytes: Uint8Array,
  filename: string,
): LocalAttachment["mediaType"] | undefined {
  const header = [...bytes.slice(0, 8)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
  if (header === "89504e470d0a1a0a") return "image/png";
  if (bytes[0] === 0xff && bytes[1] === 0xd8 && bytes[2] === 0xff)
    return "image/jpeg";
  if (
    bytes[0] === 0x52 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x46 &&
    bytes[8] === 0x57 &&
    bytes[9] === 0x45 &&
    bytes[10] === 0x42 &&
    bytes[11] === 0x50
  )
    return "image/webp";
  if (
    bytes[0] === 0x47 &&
    bytes[1] === 0x49 &&
    bytes[2] === 0x46 &&
    bytes[3] === 0x38 &&
    (bytes[4] === 0x37 || bytes[4] === 0x39) &&
    bytes[5] === 0x61
  )
    return "image/gif";
  if (
    bytes[4] === 0x66 &&
    bytes[5] === 0x74 &&
    bytes[6] === 0x79 &&
    bytes[7] === 0x70
  )
    return "video/mp4";
  if (
    bytes[0] === 0x1a &&
    bytes[1] === 0x45 &&
    bytes[2] === 0xdf &&
    bytes[3] === 0xa3
  )
    return "video/webm";
  try {
    if (
      !/\.(txt|md|markdown|json|csv|log|yaml|yml|ts|tsx|js|jsx|py|go|rs|java|css|html|xml)$/iu.test(
        filename,
      )
    )
      return undefined;
    const text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
    if (text.includes("\0")) return undefined;
    const trimmed = text.trimStart();
    if (trimmed.startsWith("{") || trimmed.startsWith("["))
      return "application/json";
    return "text/plain";
  } catch {
    // Non-UTF-8 binary is intentionally unsupported.
  }
  return undefined;
}
