import { randomUUID } from "node:crypto";
import { mkdir, readdir, rm, stat, writeFile } from "node:fs/promises";
import { join, relative } from "node:path";

export const MAX_TOOL_OUTPUT_BYTES = 50 * 1024;
export const MAX_TOOL_OUTPUT_LINES = 2_000;
export const TOOL_OUTPUT_RETENTION_MS = 7 * 24 * 60 * 60 * 1_000;

/** Leave room in each page for the pagination marker. */
const PAGE_CONTENT_BYTES = MAX_TOOL_OUTPUT_BYTES - 1_024;
const PAGE_CONTENT_LINES = MAX_TOOL_OUTPUT_LINES - 3;

export type BoundedToolOutput = {
  text: string;
  outputPath?: string;
  /** Present when a managed file contains the complete output. */
  truncated?: boolean;
  page?: number;
  totalPages?: number;
  nextPagePath?: string;
  totalBytes?: number;
};

export async function boundToolOutput(
  workspaceRoot: string,
  output: string,
): Promise<BoundedToolOutput> {
  if (
    new TextEncoder().encode(output).byteLength <= MAX_TOOL_OUTPUT_BYTES &&
    output.split("\n").length <= MAX_TOOL_OUTPUT_LINES
  )
    return { text: output };

  const directory = join(workspaceRoot, ".natalia", "tool-output");
  await mkdir(directory, { recursive: true, mode: 0o700 });
  const id = randomUUID();
  const outputPath = join(directory, `tool-${id}.log`);
  await writeFile(outputPath, output, {
    encoding: "utf8",
    mode: 0o600,
    flag: "wx",
  });

  const pages = paginate(output, PAGE_CONTENT_BYTES, PAGE_CONTENT_LINES);
  const totalPages = pages.length;
  const pagePaths = [outputPath];
  for (let index = 1; index < totalPages; index += 1)
    pagePaths.push(
      join(
        directory,
        `tool-${id}.page-${String(index + 1).padStart(4, "0")}.log`,
      ),
    );

  for (let index = 1; index < totalPages; index += 1)
    await writeFile(
      pagePaths[index]!,
      pageWithMarker(
        pages[index]!,
        index,
        totalPages,
        pagePaths,
        outputPath,
        workspaceRoot,
      ),
      {
        encoding: "utf8",
        mode: 0o600,
        flag: "wx",
      },
    );

  return {
    text: pageWithMarker(
      pages[0]!,
      0,
      totalPages,
      pagePaths,
      outputPath,
      workspaceRoot,
    ),
    outputPath,
    truncated: true,
    page: 1,
    totalPages,
    ...(pagePaths[1] ? { nextPagePath: pagePaths[1] } : {}),
    totalBytes: new TextEncoder().encode(output).byteLength,
  };
}

function pageWithMarker(
  page: string,
  index: number,
  totalPages: number,
  pagePaths: string[],
  outputPath: string,
  workspaceRoot: string,
): string {
  const pageNumber = index + 1;
  const nextPagePath = pagePaths[index + 1];
  const fullPath = relative(workspaceRoot, outputPath);
  const marker = nextPagePath
    ? `... output truncated: page ${pageNumber}/${totalPages}; continue with read_file(${JSON.stringify({ path: relative(workspaceRoot, nextPagePath) })}) or read the full output at ${fullPath} ...`
    : `... output truncated: page ${pageNumber}/${totalPages}; end of full output (${fullPath}) ...`;
  return `${page}\n\n${marker}`;
}

export async function cleanupToolOutput(
  workspaceRoot: string,
  now = Date.now(),
) {
  const directory = join(workspaceRoot, ".natalia", "tool-output");
  let entries: string[];
  try {
    entries = await readdir(directory);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return 0;
    throw error;
  }
  let removed = 0;
  for (const entry of entries) {
    if (!/^tool-[0-9a-f-]+(?:\.page-\d+)?\.log$/u.test(entry)) continue;
    const path = join(directory, entry);
    const info = await stat(path);
    if (now - info.mtimeMs < TOOL_OUTPUT_RETENTION_MS) continue;
    await rm(path);
    removed++;
  }
  return removed;
}

function paginate(
  output: string,
  maxBytes: number,
  maxLines: number,
): string[] {
  const pages: string[] = [];
  let page = "";
  let bytes = 0;
  let lines = 1;
  for (const char of output) {
    const size = new TextEncoder().encode(char).byteLength;
    if (bytes + size > maxBytes || (char === "\n" && lines >= maxLines)) {
      pages.push(page);
      page = "";
      bytes = 0;
      lines = 1;
    }
    page += char;
    bytes += size;
    if (char === "\n") lines += 1;
  }
  if (page) pages.push(page);
  return pages;
}
