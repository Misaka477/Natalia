import { afterAll, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createHash } from "node:crypto";
import { rustCas } from "../src";
import {
  NativePackIndexSet,
  nativePackIndexAvailable,
} from "../src/native-index";

/**
 * The daemon's lifecycle over its real protocol (Phase B block 4): a
 * spawned process, the line-delimited JSON, the table's freshness, and
 * the two honest exits. The packs are written by the REAL frame writer.
 */

const dirs: string[] = [];
afterAll(() => {
  for (const dir of dirs) rm(dir, { recursive: true, force: true });
});

const sha256 = (bytes: Buffer) =>
  createHash("sha256").update(bytes).digest("hex");

/** One daemon child with piped stdin/stdout, and its line reader. */
async function spawnDaemon(dir: string) {
  const child = Bun.spawn(
    ["bun", join(import.meta.dir, "..", "src", "daemon.ts"), "--dir", dir],
    {
      stdin: "pipe",
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  const reader = child.stdout.getReader();
  const decoder = new TextDecoder();
  let pending = "";
  async function send(request: unknown): Promise<Record<string, unknown>> {
    child.stdin.write(`${JSON.stringify(request)}\n`);
    child.stdin.flush();
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) return JSON.parse(line) as Record<string, unknown>;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error("daemon closed its stdout");
      pending += decoder.decode(value, { stream: true });
    }
  }
  async function receive(): Promise<Record<string, unknown>> {
    for (;;) {
      const newline = pending.indexOf("\n");
      if (newline !== -1) {
        const line = pending.slice(0, newline).trim();
        pending = pending.slice(newline + 1);
        if (line) return JSON.parse(line) as Record<string, unknown>;
      }
      const { done, value } = await reader.read();
      if (done) throw new Error("daemon closed its stdout");
      pending += decoder.decode(value, { stream: true });
    }
  }
  return { send, receive, child };
}

test("the daemon serves find/count/reload over stdin/stdout, and shuts down cleanly", async () => {
  if (!nativePackIndexAvailable()) return; // the .so is a build artifact
  const root = await mkdtemp(join(tmpdir(), "daemon-"));
  dirs.push(root);
  const packDir = join(root, "packs");
  await mkdir(packDir, { recursive: true });
  const alpha = Buffer.from("alpha payload");
  const bravo = Buffer.from("bravo payload");
  const frame = rustCas.compactFrame([
    { id: sha256(alpha), data: alpha },
    { id: sha256(bravo), data: bravo },
  ]);
  await writeFile(join(packDir, "pack-a.idx"), frame.idx);

  const daemon = await spawnDaemon(packDir);
  expect(await daemon.send({ op: "count" })).toMatchObject({
    ok: true,
    count: 1,
  });
  const hit = await daemon.send({ op: "find", id: sha256(alpha) });
  expect(hit).toMatchObject({ ok: true, pack: 0 });
  // An absent id is a value, not an error.
  expect(
    await daemon.send({ op: "find", id: sha256(Buffer.from("absent")) }),
  ).toEqual({
    ok: false,
    reason: "not_found",
  });
  // A malformed line answers bad_request and the stream re-syncs (the
  // answer is read in order — the protocol never buffers past a line).
  daemon.child.stdin.write("not json\n");
  daemon.child.stdin.flush();
  expect(await daemon.receive()).toEqual({ ok: false, reason: "bad_request" });
  expect(await daemon.send({ op: "find", id: sha256(bravo) })).toMatchObject({
    ok: true,
  });

  // Freshness: a pack written after the open is invisible until reload —
  // the writer says when it changed, the daemon never guesses.
  const charlie = Buffer.from("charlie payload");
  const second = rustCas.compactFrame([{ id: sha256(charlie), data: charlie }]);
  await writeFile(join(packDir, "pack-b.idx"), second.idx);
  expect(await daemon.send({ op: "find", id: sha256(charlie) })).toEqual({
    ok: false,
    reason: "not_found",
  });
  expect(await daemon.send({ op: "reload" })).toMatchObject({
    ok: true,
    count: 2,
  });
  expect(await daemon.send({ op: "find", id: sha256(charlie) })).toMatchObject({
    ok: true,
  });

  // The clean exit: every mapping dropped, status 0.
  expect(await daemon.send({ op: "shutdown" })).toMatchObject({ ok: true });
  expect(await daemon.child.exited).toBe(0);
}, 30_000);

test("an unopenable directory exits non-zero with a reason", async () => {
  const child = Bun.spawn(
    [
      "bun",
      join(import.meta.dir, "..", "src", "daemon.ts"),
      "--dir",
      join(tmpdir(), "daemon-missing-dir"),
    ],
    { stdin: "pipe", stdout: "pipe", stderr: "pipe" },
  );
  const status = await child.exited;
  expect(status).toBe(3);
  const stderr = await new Response(child.stderr).text();
  expect(stderr).toContain("table will not open");
});
