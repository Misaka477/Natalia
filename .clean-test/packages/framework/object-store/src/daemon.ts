import { NativePackIndexSet } from "./native-index";

/**
 * The ObjectStore daemon (the object-store study's Phase B:
 * "常驻 daemon … Unix socket 或 stdin/stdout RPC … 启动/退出生命周期
 * 管理"). The study offers the transport as a choice; STDIN/STDOUT is
 * taken first: no socket path to own, no install surface, a protocol a
 * human can drive by hand (`echo '{"op":"find",...}' | daemon`), and
 * subprocess-spawn tests that need no privileged ports.
 *
 * The protocol is line-delimited JSON, one request per line, one
 * response per line — the same shape the operation log chose for its
 * records, for the same reason (a crash mid-line loses one message, and
 * the next `\n` re-syncs the stream):
 *
 *   → {"op":"find","id":"<object id>"}
 *   ← {"ok":true,"pack":0,"offset":10,"dataOffset":1024,...}
 *     {"ok":false,"reason":"not_found"}          (an absent id)
 *     {"ok":false,"reason":"unavailable"}        (no native library)
 *   → {"op":"count"}
 *   ← {"ok":true,"count":3}
 *   → {"op":"reload"}                            (after a new pack lands)
 *   ← {"ok":true,"count":3}
 *   → {"op":"shutdown"} | EOF on stdin
 *   ← (the process exits 0: every mapping dropped)
 *
 * Freshness: a pack written after the daemon opened its table is
 * invisible until `reload` — the table is the daemon's state, and the
 * writer (the TS ObjectStore) says when it changed. That is deliberate:
 * a daemon that re-stats on every request pays a syscall per lookup to
 * guess at a freshness the WRITER already knows.
 *
 * The lifecycle's honesty: an unopenable directory exits non-zero with a
 * reason on stderr (a daemon that starts deaf is worse than no daemon),
 * and every response is one line — a protocol that buffers is a protocol
 * that hangs its client.
 */

type Request =
  | { op: "find"; id: string }
  | { op: "count" }
  | { op: "reload" }
  | { op: "shutdown" };

function argValue(flag: string): string | undefined {
  const index = process.argv.indexOf(flag);
  return index === -1 ? undefined : process.argv[index + 1];
}

const dir = argValue("--dir");
if (!dir) {
  console.error("usage: daemon.ts --dir <packs-directory>");
  process.exit(2);
}

// The INHERITED stdin fd — read through the stream Node/Bun already gave
// this process, never `Bun.file("/dev/stdin")`: opening /dev/stdin as a
// path re-opens the fd and dies ENXIO when the pipe's write end is closed
// first (a spawn-time race the daemon must not have).
const decoder = new TextDecoder();
let table = openTable();
const writer = Bun.stdout.writer();

/**
 * The table is the daemon's whole state: opening it maps every index;
 * a failed open is the daemon's honest refusal (the reason lands on
 * stderr, the exit is non-zero).
 */
function openTable(): NativePackIndexSet {
  try {
    return new NativePackIndexSet(dir!);
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    console.error(`daemon: table will not open (${dir}): ${message}`);
    process.exit(3);
  }
}

function reply(value: unknown): void {
  // One line per response, written immediately: a client waits per line.
  writer.write(`${JSON.stringify(value)}\n`);
  writer.flush();
}

async function serve(): Promise<void> {
  let pending = "";
  for await (const chunk of process.stdin) {
    pending += decoder.decode(chunk as Uint8Array, { stream: true });
    let newline = pending.indexOf("\n");
    while (newline !== -1) {
      const line = pending.slice(0, newline).trim();
      pending = pending.slice(newline + 1);
      newline = pending.indexOf("\n");
      if (!line) continue;
      let request: Request;
      try {
        request = JSON.parse(line) as Request;
      } catch {
        reply({ ok: false, reason: "bad_request" });
        continue;
      }
      switch (request.op) {
        case "find": {
          const hit = table.find(request.id);
          reply(
            hit ? { ok: true, ...hit } : { ok: false, reason: "not_found" },
          );
          break;
        }
        case "count":
          reply({ ok: true, count: table.count() });
          break;
        case "reload": {
          // Free the old table (unmap everything), open the new one: a
          // daemon never holds a half-fresh view.
          table.free();
          table = openTable();
          reply({ ok: true, count: table.count() });
          break;
        }
        case "shutdown":
          reply({ ok: true, count: table.count() });
          table.free();
          process.exit(0);
        default:
          reply({ ok: false, reason: "unknown_op" });
      }
    }
  }
  table.free();
}

await serve();
