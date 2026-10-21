/**
 * The read family renders by MIME (audit item 12-⑤).
 *
 * The ruling pinned: a read image IS a read — it gets the same
 * thumbnail-and-lightbox component the message attachments already use (one
 * renderer, not a second one); a video gets a player; anything else says
 * "binary file" instead of decoding bytes into text, which is what used to
 * push a PNG into the file tab as mojibake. Text keeps the ordinary card path.
 *
 * Source-level because exercising it needs a rendered transcript with real
 * attachment bytes; the invariant — the three branches, the shared component,
 * and the binary guard — is all in one file.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const source = readFileSync(
  join(import.meta.dir, "..", "src", "transcript.tsx"),
  "utf8",
);

describe("a media read picks its surface by MIME", () => {
  test("the image branch reuses the attachment renderer, not a second one", () => {
    expect(source).toContain('mediaType.startsWith("image/")');
    expect(source).toContain("<AttachmentImage");
    // Shared: the same component also renders message attachments — count its
    // uses in this file; a dedicated tool-only renderer would add a branch
    // instead of joining the two call sites.
    const uses = (source.match(/<AttachmentImage/gu) ?? []).length;
    expect(uses).toBeGreaterThanOrEqual(2);
  });

  test("a video gets a player", () => {
    expect(source).toContain('mediaType.startsWith("video/")');
    expect(source).toMatch(/<video[^>]*controls/u);
  });

  test("an unknown binary never reaches the text view", () => {
    // The fallback text is the guard's own sentence: bytes are not text.
    expect(source).toContain("二进制文件（");
    expect(source).toContain("不按文本渲染");
  });

  test("the branch is driven by the card's own mediaType", () => {
    // The read card carries `mediaType`; nothing sniffs the bytes at render
    // time, so a mislabelled type is a tool-side question, not a renderer one.
    expect(source).toContain("mediaType: read?.mediaType");
  });

  test("a card that names the file only in the attachmentID slot is read as a path", () => {
    // Measured: the session journal's image_read cards (persisted before the
    // read-image fix) carry the media file's absolute PATH in `attachmentID`
    // and NO `path` field — `attachImage` stores no attachment id. Mapped
    // verbatim, the loader asked the runtime for an attachment named
    // `E:\…\x.png` with an empty path, was refused, and answered 400 on
    // every restart. The file's location is whichever field spells it.
    expect(source).toContain("path: read?.path ?? read?.attachmentID");
    // An id survives only alongside a real `path`: a path-only card must
    // never be sent as a store reference.
    expect(source).toContain("id: hasPath ? read?.attachmentID : undefined");
  });
});
