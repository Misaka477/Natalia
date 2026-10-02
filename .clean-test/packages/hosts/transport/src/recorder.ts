import { mkdir, readFile, rename, writeFile } from "node:fs/promises";
import { dirname, resolve } from "node:path";

export type HttpCassette = {
  version: 1;
  interactions: Array<{
    request: {
      method: string;
      url: string;
      headers: Record<string, string>;
      body?: string;
    };
    response: { status: number; headers: Record<string, string>; body: string };
  }>;
};

export type RecordedFetchMode = "record" | "replay";

export function createRecordedFetch(input: {
  cassettePath: string;
  mode: RecordedFetchMode;
  fetch?: (url: URL | RequestInfo, init?: RequestInit) => Promise<Response>;
}) {
  let replayIndex = 0;
  return async (url: URL | RequestInfo, init?: RequestInit) => {
    const request = await snapshotRequest(url, init);
    if (input.mode === "replay") {
      const cassette = await readCassette(input.cassettePath);
      const interaction = cassette.interactions[replayIndex++];
      if (!interaction)
        throw new Error(
          `cassette exhausted for ${request.method} ${request.url}`,
        );
      if (
        interaction.request.method !== request.method ||
        interaction.request.url !== request.url
      )
        throw new Error(
          `cassette mismatch: expected ${interaction.request.method} ${interaction.request.url}, received ${request.method} ${request.url}`,
        );
      return new Response(interaction.response.body, {
        status: interaction.response.status,
        headers: interaction.response.headers,
      });
    }
    const response = await (input.fetch ?? fetch)(url, init);
    const responseBody = await response.clone().text();
    const cassette = await readCassette(input.cassettePath);
    cassette.interactions.push({
      request,
      response: {
        status: response.status,
        headers: redactHeaders(response.headers),
        body: redactSecrets(responseBody),
      },
    });
    await writeCassette(input.cassettePath, cassette);
    return response;
  };
}

export async function readCassette(path: string): Promise<HttpCassette> {
  try {
    return JSON.parse(await readFile(path, "utf8")) as HttpCassette;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT")
      return { version: 1, interactions: [] };
    throw error;
  }
}

async function snapshotRequest(url: URL | RequestInfo, init?: RequestInit) {
  const headers = redactHeaders(new Headers(init?.headers));
  return {
    method: init?.method ?? "GET",
    url: String(url),
    headers,
    body: init?.body ? redactSecrets(String(init.body)) : undefined,
  };
}

async function writeCassette(path: string, cassette: HttpCassette) {
  const target = resolve(path);
  await mkdir(dirname(target), { recursive: true, mode: 0o700 });
  const temporary = `${target}.${Date.now().toString(36)}.tmp`;
  await writeFile(temporary, `${JSON.stringify(cassette, null, 2)}\n`, {
    mode: 0o600,
  });
  await rename(temporary, target);
}

function redactHeaders(headers: Headers) {
  return Object.fromEntries(
    [...headers.entries()].map(([key, value]) => [
      key,
      /authorization|api[-_]?key|token|secret/iu.test(key)
        ? "[redacted]"
        : redactSecrets(value),
    ]),
  );
}

function redactSecrets(value: string) {
  return value
    .replace(/Bearer\s+[A-Za-z0-9._-]+/giu, "Bearer [redacted]")
    .replace(/(?:sk|AIza)[A-Za-z0-9_-]{12,}/gu, "[redacted]");
}
