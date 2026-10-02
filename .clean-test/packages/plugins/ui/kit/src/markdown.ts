import { marked } from "marked";

const markdownCache = new Map<string, string>();
const MARKDOWN_CACHE_LIMIT = 512;

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;");
}

// Raw HTML in a local markdown file must not execute in the host page.
const renderer = new marked.Renderer();
renderer.html = ({ text }) => escapeHtml(text);

function tableDelimiter(line: string | undefined) {
  return (
    typeof line === "string" &&
    line.includes("|") &&
    /^\s*\|?[\s:|-]+\|?\s*$/u.test(line) &&
    line.includes("-")
  );
}

function tableHeader(line: string | undefined) {
  return typeof line === "string" && line.includes("|");
}

/**
 * GFM tables must start a fresh block. README files often put the table
 * immediately after the preceding sentence, which marked otherwise treats as
 * ordinary paragraph text. Insert the required blank line before the header.
 */
function normalizeGfmTables(text: string) {
  const lines = text.split(/\r?\n/u);
  const normalized: string[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    const next = lines[index + 1];
    if (
      tableHeader(line) &&
      tableDelimiter(next) &&
      normalized.length > 0 &&
      normalized.at(-1)!.trim() !== ""
    )
      normalized.push("");
    normalized.push(line);
  }
  return normalized.join("\n");
}

/**
 * Renders GitHub-flavoured markdown to HTML with a small revision cache. Shared
 * by the transcript and the file editor so both render tables and code alike.
 */
export function renderMarkdownHtml(text: string): string {
  const cached = markdownCache.get(text);
  if (cached !== undefined) return cached;
  const html = marked.parse(normalizeGfmTables(text), {
    gfm: true,
    breaks: true,
    renderer,
  }) as string;
  if (markdownCache.size >= MARKDOWN_CACHE_LIMIT) {
    const oldest = markdownCache.keys().next().value;
    if (oldest !== undefined) markdownCache.delete(oldest);
  }
  markdownCache.set(text, html);
  return html;
}
