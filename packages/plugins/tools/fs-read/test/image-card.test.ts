/**
 * What a read-image card hands the client.
 *
 * Measured defect: `image_read`'s result sentence is
 * `image attached: <absolute path>`, and the card put that string in
 * `attachmentID` — on the theory (recorded in its own comment) that the runtime
 * answered with an attachment id. `attachImage` never stores one: it hands the
 * bytes to the next provider step and returns void. So the client asked the
 * runtime for an attachment named `E:\…\x.png`, was refused with "attachment is
 * not referenced by session", and every read-image card showed 加载失败
 * (measured: 20+ `rpc attachment.dataUrl failed` diagnostics in one session).
 *
 * The card carries the PATH the reader's thumbnail is loaded from, and it never
 * claims that path is an id.
 */
import { expect, test } from "bun:test";
import { imageReadTool } from "../src/fs-read-tools";

type PresenterOutput = {
  presentResult(
    args: unknown,
    value: string,
    meta?: Record<string, unknown>,
  ): Record<string, unknown>;
};

function present(imagePath: string): Record<string, unknown> {
  const output = imageReadTool().output as PresenterOutput;
  return output.presentResult(
    { path: imagePath },
    `image attached: ${imagePath}`,
  );
}

test("the card names the file, and its media type picks the renderer", () => {
  const card = present("E:\\w\\pic.png");
  expect(card.kind).toBe("read");
  expect(card.path).toBe("E:\\w\\pic.png");
  expect(card.mediaType).toBe("image/png");
  // The other renderer choices are by media type, so a video names itself too.
  expect(present("E:\\w\\clip.mp4").mediaType).toBe("video/mp4");
});

test("the path is never presented as an attachment id", () => {
  // The defect in one assertion: an id-shaped field carrying a path is what made
  // the client ask the runtime for a non-existent attachment.
  expect(present("E:\\w\\pic.png").attachmentID).toBeUndefined();
});

test("a result sentence that is not the expected shape falls back to the argument", () => {
  // The sentence is the runtime's; if its shape changes, the card still points at
  // the file the model named rather than inventing a path.
  const output = imageReadTool().output as PresenterOutput;
  const card = output.presentResult(
    { path: "E:\\w\\a.png" },
    "attached (unknown shape)",
  );
  expect(card.path).toBe("E:\\w\\a.png");
  expect(card.attachmentID).toBeUndefined();
});
