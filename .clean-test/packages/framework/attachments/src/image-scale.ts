/**
 * Deterministic image downscaling for attachments.
 *
 * Why scale at admission instead of at dispatch: a dispatch-time decision has
 * to read the request's remaining byte budget, and every input to that
 * arithmetic (inline fallback, quantum size, compaction, route switch) moves
 * between requests. An image that was inlined on one request and dropped on the
 * next rewrites history, so the provider's prefix cache misses on every turn.
 * Scaling once here, against a fixed target, and persisting the result removes
 * the per-request decision entirely: the stored bytes are the attachment's
 * representation for life, and the prefix cannot move because of them.
 *
 * The target is the provider's own threshold rather than a number we invented.
 * Anthropic resamples any image whose long edge exceeds 1568px and rejects
 * anything above roughly 1.15 MP, so an image over that edge is going to be
 * resampled anyway — scaling it here costs us deterministic bytes we control
 * instead of full-size bytes the provider then reduces lossily.
 */

import { perfLog } from "@anthelia/runtime-services";

/**
 * Pinned knobs. Nothing here may read runtime state: the same input bytes with
 * the same limits must produce the same output bytes, or two admissions of one
 * file could disagree and a resumed session would see a different prefix.
 */
const RESIZE_METHOD = "lanczos3" as const;
const FIT_METHOD = "contain" as const;

/** Longest edge allowed before an image is scaled down. Anthropic's own threshold. */
export const DEFAULT_MAX_IMAGE_LONG_EDGE = 1568;

/** Media types this module can decode, resize and re-encode. */
const SCALABLE_MEDIA_TYPES = new Set(["image/png", "image/jpeg", "image/webp"]);

export interface ImageScaleResult {
  /** Replacement bytes; the caller stores these instead of the originals. */
  readonly bytes: Uint8Array;
  /** Dimensions of the replacement, read back from the codec. */
  readonly width: number;
  readonly height: number;
  /** Media type of the replacement. Never changes: see {@link scaleImage}. */
  readonly mediaType: string;
}

/**
 * Scale an image down so its longest edge is at most `maxLongEdge`, preserving
 * aspect ratio. Returns `undefined` when nothing is worth doing: the media type
 * is not scalable here (animated GIF included — per-frame work is a different
 * problem), the image already fits, or the codec failed.
 *
 * A codec failure returns `undefined` rather than throwing, so a WASM problem
 * can never fail an attachment the user legitimately attached. The original
 * bytes are themselves a stable representation, so falling back to them costs
 * size, not correctness.
 *
 * The media type never changes. Re-encoding a PNG as JPEG would shrink it far
 * more, but it would also make the stored representation a policy decision
 * rather than a property of the file; keeping the format means one less thing
 * that has to be pinned to stay deterministic.
 */
export async function scaleImage(input: {
  bytes: Uint8Array;
  mediaType: string;
  maxLongEdge: number;
}): Promise<ImageScaleResult | undefined> {
  if (!SCALABLE_MEDIA_TYPES.has(input.mediaType)) return undefined;
  const longEdge = Math.max(1, Math.floor(input.maxLongEdge));

  try {
    const codec = await loadCodec(input.mediaType);
    // jsquash's codecs take an ArrayBuffer, so hand over a view over exactly
    // these bytes rather than a detached copy.
    const source = await codec.decode(
      input.bytes.buffer.slice(
        input.bytes.byteOffset,
        input.bytes.byteOffset + input.bytes.byteLength,
      ) as ArrayBuffer,
    );
    const longest = Math.max(source.width, source.height);
    if (longest <= longEdge) return undefined;

    // One scale factor applied to both axes keeps the aspect ratio exact. The
    // rounding is spelled out rather than left to `Math.round` drift so the
    // geometry is reproducible from the inputs alone.
    const factor = longEdge / longest;
    const targetWidth = Math.max(1, Math.floor(source.width * factor));
    const targetHeight = Math.max(1, Math.floor(source.height * factor));

    const resize = (await import("@jsquash/resize")).default;
    const resized = await resize(source, {
      width: targetWidth,
      height: targetHeight,
      method: RESIZE_METHOD,
      fitMethod: FIT_METHOD,
      premultiply: true,
      linearRGB: true,
    });
    const encoded = await codec.encode(resized);
    const bytes = new Uint8Array(encoded);

    return {
      bytes,
      width: resized.width,
      height: resized.height,
      mediaType: input.mediaType,
    };
  } catch (error) {
    // Keep the failure visible without failing the attachment.
    perfLog("[attachments] image scaling failed; storing the original bytes", {
      mediaType: input.mediaType,
      error: error instanceof Error ? error.message : String(error),
    });
    return undefined;
  }
}

/** The slice of a jsquash codec this module uses. */
interface ImageCodec {
  decode(buffer: ArrayBuffer): Promise<ImageData>;
  encode(image: ImageData): Promise<ArrayBuffer>;
}

async function loadCodec(mediaType: string): Promise<ImageCodec> {
  if (mediaType === "image/png")
    return (await import("@jsquash/png")) as ImageCodec;
  if (mediaType === "image/jpeg")
    return (await import("@jsquash/jpeg")) as ImageCodec;
  return (await import("@jsquash/webp")) as ImageCodec;
}
