export type MarkdownCommit = {
  committed: string;
  tail: string;
};

export function splitMarkdownAtSafeBoundary(input: string): MarkdownCommit {
  const boundary = safeBoundaryIndex(input);
  if (boundary <= 0) return { committed: "", tail: input };
  return {
    committed: input.slice(0, boundary),
    tail: input.slice(boundary),
  };
}

export function flushMarkdown(input: string): MarkdownCommit {
  return { committed: input, tail: "" };
}

export function appendWithRetrySkip(
  chunk: string,
  retrySkip: string,
): { text: string; retrySkip: string } {
  if (!retrySkip) return { text: chunk, retrySkip };
  if (retrySkip.startsWith(chunk)) {
    return { text: "", retrySkip: retrySkip.slice(chunk.length) };
  }
  if (chunk.startsWith(retrySkip)) {
    return { text: chunk.slice(retrySkip.length), retrySkip: "" };
  }

  const overlap = longestOverlap(retrySkip, chunk);
  if (overlap > 0) return { text: chunk.slice(overlap), retrySkip: "" };
  return { text: chunk, retrySkip: "" };
}

function safeBoundaryIndex(input: string) {
  const lines = input.split(/(?<=\n)/u);
  let offset = 0;
  let boundary = 0;
  let fence: string | undefined;

  for (const line of lines) {
    const marker = line.match(/^\s*(```+|~~~+)/u)?.[1];
    if (marker) {
      if (!fence) {
        fence = marker.slice(0, 3);
      } else if (marker.startsWith(fence)) {
        fence = undefined;
        offset += line.length;
        boundary = offset;
        continue;
      }
    }

    offset += line.length;
    if (fence) continue;
    if (line.trim() === "") boundary = offset;
    if (isCompleteListLine(line)) boundary = offset;
    if (isHeadingBoundary(line)) boundary = offset;
  }

  return boundary;
}

function isCompleteListLine(line: string) {
  if (!line.endsWith("\n")) return false;
  return /^\s*(?:[-*+] |\d+[.)] |[-*+] \[[ xX]\] ).+\n$/u.test(line);
}

function isHeadingBoundary(line: string) {
  if (!line.endsWith("\n")) return false;
  return /^#{1,6}\s+\S.+\n$/u.test(line);
}

function longestOverlap(left: string, right: string) {
  const max = Math.min(left.length, right.length);
  for (let size = max; size > 0; size--) {
    if (left.endsWith(right.slice(0, size))) return size;
  }
  return 0;
}
