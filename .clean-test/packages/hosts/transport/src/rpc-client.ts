/**
 * Caller side of the runtime RPC protocol. An external consumer needs only this
 * file: it speaks to a runtime over HTTP and never hosts one. The dispatcher
 * that answers these calls lives in `rpc.ts` behind the `./host` entry point,
 * so importing the protocol does not pull in a server.
 */
import { RuntimeRPCError } from "@anthelia/contracts";
import type { RuntimeFailureData } from "@anthelia/contracts";

export type RPCRequest = {
  id?: string | number | null;
  method?: string;
  params?: Record<string, unknown>;
};

export type RPCResponse = {
  jsonrpc: "2.0";
  id: string | number | null;
  result?: unknown;
  /**
   * `code` and `data` are the part a program acts on; `message` is for humans and
   * is redacted for internal failures. See `failures.ts` in `@anthelia/contracts`.
   */
  error?: { code: number; message: string; data?: RuntimeFailureData };
};

export async function callRuntimeRPC<T>(input: {
  url: string;
  token?: string;
  method: string;
  params?: Record<string, unknown>;
  fetch?: typeof globalThis.fetch;
  signal?: AbortSignal;
}): Promise<T> {
  const response = await (input.fetch ?? globalThis.fetch)(
    new URL("/rpc", input.url),
    {
      method: "POST",
      headers: {
        "content-type": "application/json",
        ...(input.token ? { authorization: `Bearer ${input.token}` } : {}),
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: input.method,
        params: input.params,
      }),
      signal: input.signal,
    },
  );
  const body = (await response.json()) as RPCResponse;
  // The failure is rethrown with its code and data intact. Throwing a plain
  // Error here would put the caller straight back to matching message text,
  // which is the thing the server side stopped doing.
  if (body.error)
    throw new RuntimeRPCError({
      code: body.error.code,
      message: body.error.message,
      method: input.method,
      data: body.error.data,
    });
  if (!response.ok)
    throw new Error(`runtime RPC failed with HTTP ${response.status}`);
  return body.result as T;
}
