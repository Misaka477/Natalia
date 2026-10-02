import type {
  ProviderStreamRequest,
  ProviderStreamChunk,
  StreamingProvider,
} from "@anthelia/runtime";

const INPUT_LIMIT = 600;
const OUTPUT_LIMIT = 96;
const TITLE_TIMEOUT_MS = 8_000;

export function isInvalidGeneratedSessionTitle(value: string) {
  const candidate = value.trim();
  if (!candidate) return true;
  return /^(?:chatcmpl(?:[\s_-]+tool)?|cmpl|completion|request|response|req|resp|call|toolu?)[\s_-]+[A-Za-z0-9_-]{6,}$/iu.test(
    candidate,
  );
}

export function sanitizeSessionTitleInput(text: string) {
  return text
    .replace(
      /((?:api[_-]?key|token|password|secret)\s*[:=]\s*)[^\s,;]+/giu,
      "$1[redacted]",
    )
    .replace(
      /\b(?:sk|pk|rk)[_-][A-Za-z0-9_-]{12,}\b|\bAIza[A-Za-z0-9_-]{12,}\b|\b(?:ghp|github_pat|xox[baprs])_[A-Za-z0-9_-]{12,}\b/gu,
      "[redacted]",
    )
    .replace(
      /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\b/gu,
      "[redacted]",
    )
    .replace(/\/home\/[^/\s]+(?:\/[^\s]*)?/gu, "[home path]")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, INPUT_LIMIT);
}

export function normalizeSessionTitle(value: string) {
  if (isInvalidGeneratedSessionTitle(value)) return "";
  const normalized = value
    .replace(/[\r\n]+/gu, " ")
    .replace(/[`*_#>[\]{}()"']/gu, "")
    .replace(/[\p{P}\p{S}]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim()
    .slice(0, OUTPUT_LIMIT);
  return isInvalidGeneratedSessionTitle(normalized) ? "" : normalized;
}

export function fallbackSessionTitle(sanitizedText: string) {
  return normalizeSessionTitle(sanitizedText).slice(0, 64) || "Untitled";
}

export async function generateSessionTitle(
  provider: StreamingProvider,
  text: string,
  options: {
    signal?: AbortSignal;
    timeoutMs?: number;
    stream?: (
      request: ProviderStreamRequest,
    ) => AsyncIterable<ProviderStreamChunk>;
  } = {},
) {
  const sanitizedText = sanitizeSessionTitleInput(text);
  const controller = new AbortController();
  const abort = () =>
    controller.abort(options.signal?.reason ?? new Error("runtime disposed"));
  options.signal?.addEventListener("abort", abort, { once: true });
  if (options.signal?.aborted) abort();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let iterator: AsyncIterator<ProviderStreamChunk> | undefined;
  let rejectCancellation: ((reason?: unknown) => void) | undefined;
  const cancelled = new Promise<never>((_, reject) => {
    rejectCancellation = reject;
  });
  const cancelCollection = () =>
    rejectCancellation?.(
      controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new DOMException("session title generation cancelled", "AbortError"),
    );
  controller.signal.addEventListener("abort", cancelCollection, { once: true });
  const collect = async () => {
    let output = "";
    let emittedToolCall = false;
    const stream = (options.stream ?? provider.stream.bind(provider))({
      signal: controller.signal,
      messages: [
        {
          role: "system",
          content:
            "Create a concise session topic in the same language as the user text. Return only one plain title, no quotes, markdown, punctuation, explanation, tools, or reasoning.",
        },
        { role: "user", content: sanitizedText },
      ],
    });
    iterator = stream[Symbol.asyncIterator]();
    while (true) {
      const next = await iterator.next();
      if (next.done) break;
      const chunk = next.value;
      if (chunk.type === "content") output += chunk.text;
      if (chunk.type === "tool_call") emittedToolCall = true;
      if (output.length >= OUTPUT_LIMIT * 2) break;
    }
    if (controller.signal.aborted)
      throw controller.signal.reason instanceof Error
        ? controller.signal.reason
        : new DOMException("session title generation cancelled", "AbortError");
    return emittedToolCall ? "" : normalizeSessionTitle(output);
  };
  try {
    return await Promise.race([
      collect(),
      cancelled,
      new Promise<never>((_, reject) => {
        timer = setTimeout(() => {
          controller.abort(new Error("session title generation timed out"));
          reject(new Error("session title generation timed out"));
        }, options.timeoutMs ?? TITLE_TIMEOUT_MS);
      }),
    ]);
  } finally {
    if (timer) clearTimeout(timer);
    controller.abort();
    options.signal?.removeEventListener("abort", abort);
    controller.signal.removeEventListener("abort", cancelCollection);
    const cleanup = iterator?.return?.().catch(() => undefined);
    if (cleanup)
      await Promise.race([
        cleanup,
        new Promise<void>((resolve) => setTimeout(resolve, 250)),
      ]);
  }
}
