import { join } from "node:path";
import type { NativeTableHit } from "./native-index";

/**
 * The daemon client (the object-store study's Phase B: "TS ObjectStore
 * 优先连 daemon，失败回退本地 FS"). The daemon is an INDEX server — it
 * answers WHERE an object lives (pack + offsets); the bytes always come
 * from the local pack file, which is why a daemon-less runtime is a
 * slower store, never a wrong one.
 *
 * The preference's shape: the store asks the daemon first, and ANY
 * failure — the spawn, the protocol, a closed pipe — falls through to
 * the store's own index load without a trace. A MISS is not a failure:
 * the daemon answers `not_found` as a value, and the store treats it as
 * a miss (its own load may still find the object — the daemon's
 * freshness is the writer's reload to declare, and a read must not miss
 * a freshly written object because the daemon's table is old).
 *
 * The spawn: the CURRENT runtime (`process.execPath`) runs the daemon
 * module beside this file — no PATH lookup, no second installation, and
 * the daemon inherits the same zero-dependency story.
 */

export type PackDaemonOptions = {
  /** The packs directory the daemon indexes. */
  packsDir: string;
  /** How long to wait for one answer before the client gives up (ms). */
  timeoutMs?: number;
};

export type PackDaemon = {
  /** The index lookup, or undefined for a miss AND for any failure —
   * the caller cannot tell, and must not need to (the fallback covers
   * both identically). */
  find(id: string): Promise<NativeTableHit | undefined>;
  count(): Promise<number>;
  close(): void;
};

const DEFAULT_TIMEOUT_MS = 2_000;

/** One answer's read: a line, or a timeout's undefined. */
async function readLine(
  reader: ReadableStreamDefaultReader<Uint8Array>,
  decoder: TextDecoder,
  timeoutMs: number,
  pending: { text: string },
): Promise<Record<string, unknown> | undefined> {
  for (;;) {
    const newline = pending.text.indexOf("\n");
    if (newline !== -1) {
      const line = pending.text.slice(0, newline).trim();
      pending.text = pending.text.slice(newline + 1);
      if (line) {
        try {
          return JSON.parse(line) as Record<string, unknown>;
        } catch {
          return undefined;
        }
      }
    }
    const timeout = new Promise<"timeout">((resolve) =>
      setTimeout(() => resolve("timeout"), timeoutMs),
    );
    const next = await Promise.race([
      reader.read().then((value) => value),
      timeout,
    ]);
    if (next === "timeout") return undefined;
    if (next.done) return undefined;
    pending.text += decoder.decode(next.value, { stream: true });
  }
}

export async function openPackDaemon(
  options: PackDaemonOptions,
): Promise<PackDaemon | undefined> {
  const timeoutMs = options.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  let child: ReturnType<typeof Bun.spawn>;
  try {
    const spawned = Bun.spawn(
      [
        process.execPath,
        join(import.meta.dir, "daemon.ts"),
        "--dir",
        options.packsDir,
      ],
      { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
    );
    child = spawned;
  } catch {
    return undefined; // the spawn itself failed: the local path stands
  }
  // The spawn's pipes narrow to the streams (Bun types them as a union
  // with the fd numbers); a numeric pipe means the stream is absent and
  // the client answers like any other failure — absent.
  const stdout = child.stdout;
  const stdin = child.stdin;
  if (!stdout || typeof stdout === "number") return undefined;
  if (!stdin || typeof stdin === "number") return undefined;
  const reader = stdout.getReader();
  const decoder = new TextDecoder();
  const pending = { text: "" };

  const call = async (
    request: unknown,
  ): Promise<Record<string, unknown> | undefined> => {
    try {
      stdin.write(`${JSON.stringify(request)}\n`);
      stdin.flush();
      return await readLine(reader, decoder, timeoutMs, pending);
    } catch {
      return undefined; // a broken pipe is the fallback's business
    }
  };

  // The liveness probe: a daemon that cannot answer `count` (no .so, a
  // crash, a timeout) is treated as absent — the caller never sees the
  // difference between "no daemon" and "unhealthy daemon".
  const probe = await call({ op: "count" });
  if (!probe || probe.ok !== true) {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
    return undefined;
  }
  // The lifecycle: the store has no close protocol to hook, so the
  // daemon's lifetime is the PROCESS's — an exit hook drops the child at
  // process end (an orphaned daemon holding mappings would outlive its
  // reason to exist). Tests close explicitly.
  process.once("exit", () => {
    try {
      child.kill();
    } catch {
      /* already gone */
    }
  });
  return {
    async find(id) {
      const answer = await call({ op: "find", id });
      if (!answer || answer.ok !== true) return undefined;
      const pack = answer.pack;
      if (typeof pack !== "number") return undefined;
      return {
        pack,
        offset: Number(answer.offset),
        dataOffset: Number(answer.dataOffset),
        origLen: Number(answer.origLen),
        compLen: Number(answer.compLen),
        kind: Number(answer.kind),
        deltaLen: Number(answer.deltaLen),
      };
    },
    count: async () => {
      const answer = await call({ op: "count" });
      return answer && answer.ok === true ? Number(answer.count) : 0;
    },
    close() {
      try {
        child.kill();
      } catch {
        /* already gone */
      }
    },
  };
}
