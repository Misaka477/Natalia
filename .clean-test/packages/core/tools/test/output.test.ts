import { mkdtemp, readFile, utimes, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { expect, test } from "bun:test";
import {
  boundToolOutput,
  cleanupToolOutput,
  MAX_TOOL_OUTPUT_BYTES,
  MAX_TOOL_OUTPUT_LINES,
  TOOL_OUTPUT_RETENTION_MS,
} from "../src";

test("tool output retention preserves complete output and paginates the preview", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-output-"));
  const output = `HEAD\n${"x".repeat(MAX_TOOL_OUTPUT_BYTES)}\nTAIL`;
  const bounded = await boundToolOutput(root, output);

  expect(bounded.outputPath).toBeDefined();
  expect(bounded.truncated).toBe(true);
  expect(bounded.page).toBe(1);
  expect(bounded.totalPages).toBeGreaterThan(1);
  expect(bounded.text).toContain("output truncated: page 1/");
  expect(new TextEncoder().encode(bounded.text).byteLength).toBeLessThanOrEqual(
    MAX_TOOL_OUTPUT_BYTES,
  );
  expect(await readFile(bounded.outputPath!, "utf8")).toBe(output);

  expect(bounded.nextPagePath).toBeDefined();
  const nextPage = await readFile(bounded.nextPagePath!, "utf8");
  expect(nextPage).not.toBe("");
  expect(await boundToolOutput(root, nextPage)).toEqual({ text: nextPage });
});

test("page files form a complete read_file chain without re-truncation", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-output-chain-"));
  const output = Array.from(
    { length: 12_000 },
    (_, index) => `line ${index} ${"x".repeat(12)}`,
  ).join("\n");
  const bounded = await boundToolOutput(root, output);

  expect(bounded.truncated).toBe(true);
  expect(bounded.totalPages).toBeGreaterThan(3);

  let text = bounded.text;
  for (let pageNumber = 1; pageNumber <= bounded.totalPages!; pageNumber++) {
    expect(text).toContain(
      `output truncated: page ${pageNumber}/${bounded.totalPages}`,
    );
    expect(new TextEncoder().encode(text).byteLength).toBeLessThanOrEqual(
      MAX_TOOL_OUTPUT_BYTES,
    );
    expect(text.split("\n").length).toBeLessThanOrEqual(MAX_TOOL_OUTPUT_LINES);
    // A page read through read_file must stay under the same limits, otherwise
    // the generic outer bound would paginate the page again.
    expect(await boundToolOutput(root, text)).toEqual({ text });

    if (pageNumber === bounded.totalPages) {
      expect(text).not.toContain("read_file(");
      break;
    }
    const match = text.match(/read_file\((\{.*?\})\)/su);
    expect(match).toBeDefined();
    const next = JSON.parse(match![1]!) as { path: string };
    const nextPage = join(root, next.path);
    if (pageNumber === 1) expect(bounded.nextPagePath).toBe(nextPage);
    text = await readFile(nextPage, "utf8");
  }
});

test("long line-count output stays pageable across multiple pages", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-output-lines-"));
  const output = Array.from(
    { length: 5_000 },
    (_, index) => `line ${index}`,
  ).join("\n");
  const bounded = await boundToolOutput(root, output);

  expect(bounded.truncated).toBe(true);
  expect(bounded.totalPages).toBeGreaterThan(1);
  expect(bounded.text).toContain("output truncated: page 1/");
  expect(bounded.nextPagePath).toBeDefined();
  const nextPage = await readFile(bounded.nextPagePath!, "utf8");
  expect(nextPage).toContain("output truncated: page 2/");
  expect(nextPage.split("\n").length).toBeLessThanOrEqual(2_000);
  if ((bounded.totalPages ?? 0) > 2)
    expect(nextPage).toContain(".page-0003.log");
});

test("small tool output remains inline without a managed file", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-output-small-"));
  expect(await boundToolOutput(root, "complete result")).toEqual({
    text: "complete result",
  });
});

test("tool output cleanup removes only expired managed output files", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-tool-output-cleanup-"));
  const directory = join(root, ".natalia", "tool-output");
  const old = join(directory, "tool-00000000-0000-0000-0000-000000000000.log");
  const recent = join(
    directory,
    "tool-11111111-1111-1111-1111-111111111111.log",
  );
  const unrelated = join(directory, "keep.txt");
  await boundToolOutput(root, "x".repeat(MAX_TOOL_OUTPUT_BYTES + 1));
  await writeFile(old, "old");
  await writeFile(recent, "recent");
  await writeFile(unrelated, "keep");
  const expired = new Date(Date.now() - TOOL_OUTPUT_RETENTION_MS - 1);
  await utimes(old, expired, expired);

  expect(await cleanupToolOutput(root)).toBe(1);
  await expect(readFile(old, "utf8")).rejects.toThrow();
  expect(await readFile(recent, "utf8")).toBe("recent");
  expect(await readFile(unrelated, "utf8")).toBe("keep");
});
