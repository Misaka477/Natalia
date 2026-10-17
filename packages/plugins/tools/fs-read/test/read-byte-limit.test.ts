/**
 * The read's byte ceiling.
 *
 * Measured defect this pins: `fourier_contour.html` has 313 lines and 1.6 MB —
 * a minified page, so a line is enormous. `read_file`'s only window was 2000
 * LINES, which that file fits inside completely, so one call returned 1,513,973
 * characters (~378k tokens) as a single tool result. The next provider request
 * (486k tokens) was refused with "The input you provided is invalid" and the
 * turn died, in a session whose context budget believed the window was 1M.
 *
 * A line count bounds nothing for a minified file. The reference harnesses cap
 * the RESULT: ZCode's file read is bounded by a hard 256 KB and reports
 * `truncated` with `totalBytes`; every tool's final output is uniformly cut to
 * head+tail 32 KB with a locator for on-demand retrieval. This is the read-side
 * gate, with the same number as the reference's.
 */
import { expect, test } from "bun:test";
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { READ_BYTE_LIMIT, READ_LINE_LIMIT } from "../src/fs-read-tools";

test("the byte ceiling is a named constant beside the line ceiling", () => {
  // The reference's number, so the two implementations are comparable rather
  // than tuned independently.
  expect(READ_BYTE_LIMIT).toBe(256 * 1024);
  expect(READ_LINE_LIMIT).toBe(2000);
});

test("a minified file's read is bounded by BYTES, not by lines", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-read-bytes-"));
  // The measured shape: few lines, each enormous. 40 lines x 40 KB = 1.6 MB,
  // which is 40 lines — far inside the 2000-line window.
  const line = "x".repeat(40 * 1024);
  await writeFile(join(root, "min.html"), `${line}\n`.repeat(40), "utf8");

  const { readFileTools } = await import("../src/fs-read-tools");
  const tool = readFileTools.find((candidate) => candidate.name === "read_file")!;
  const result = JSON.parse(
    await tool.execute({ path: "min.html" }, { workspaceRoot: root } as never),
  ) as { content: string; totalLines: number; truncated: boolean };

  expect(result.totalLines).toBe(40);
  expect(result.truncated).toBe(true);
  // Bounded: the page is a fraction of the file, and the cap is what bounded it
  // (40 lines would all have fit inside the line window).
  expect(Buffer.byteLength(result.content, "utf8")).toBeLessThan(
    READ_BYTE_LIMIT + 4096,
  );
  // And it says where to resume, the way the line window does — a page a model
  // cannot continue is a page it must guess at.
  expect(result.content).toContain("Use offset=");
  expect(result.content).toContain("of 40.");
});

test("a small file is untouched by the byte ceiling", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-read-small-"));
  await writeFile(join(root, "small.txt"), "a\nb\nc\n", "utf8");
  const { readFileTools } = await import("../src/fs-read-tools");
  const tool = readFileTools.find((candidate) => candidate.name === "read_file")!;
  const result = JSON.parse(
    await tool.execute({ path: "small.txt" }, { workspaceRoot: root } as never),
  ) as { content: string; truncated: boolean };
  expect(result.truncated).toBe(false);
  expect(result.content).toContain("End of file - total 3 lines");
});
