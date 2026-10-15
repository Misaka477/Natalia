/**
 * The resolver the packaged runtime loads its Worker threads through.
 *
 * Measured: `bun build --compile` does not treat the argument of
 * `new Worker(new URL("./thing.worker.ts", import.meta.url))` as an entry
 * point, so the worker module was never inside the binary. At runtime the URL
 * resolved to `B:\~BUN\root\thing.worker.ts` — Bun's EMBEDDED filesystem — and
 * the worker's bootstrap died with `BuildMessage: ModuleNotFound`. The failure
 * arrives as an asynchronous `error` event rather than a constructor throw, so
 * nothing looked broken: every pool task simply waited out its deadline. On a
 * real install `model.catalog` took 15002ms (its deadline) where it now takes
 * 7ms from the staged file.
 *
 * These cases pin the resolver's search order and, just as importantly, the
 * failure MESSAGE: the defect was silent, so the one thing the replacement has
 * to do when it cannot find the bundle is say where it looked.
 */
import { expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import {
  locateRuntimeWorker,
  RUNTIME_WORKERS_DIR_ENV,
} from "../src/runtime-worker";

async function scratch(): Promise<string> {
  return await mkdtemp(join(tmpdir(), "natalia-runtime-worker-"));
}

test("a staged bundle wins over the source module the caller names", async () => {
  const dir = await scratch();
  try {
    // The staged copy the release ships; the .ts the caller names is absent,
    // which is exactly the shape a compiled binary has.
    await writeFile(join(dir, "session-project.worker.js"), "// staged\n");
    process.env[RUNTIME_WORKERS_DIR_ENV] = dir;
    const found = locateRuntimeWorker(
      pathToFileURL(join(dir, "session-project.worker.ts")),
    );
    expect(found.origin).toBe("staged");
    expect(found.path).toBe(join(dir, "session-project.worker.js"));
    // A real file on disk, not a URL into Bun's embedded filesystem.
    expect(found.url.protocol).toBe("file:");
  } finally {
    delete process.env[RUNTIME_WORKERS_DIR_ENV];
    await rm(dir, { recursive: true, force: true });
  }
});

test("with no staged bundle a real source module is used unchanged", async () => {
  delete process.env[RUNTIME_WORKERS_DIR_ENV];
  const dir = await scratch();
  try {
    // A checkout: the TypeScript module is on disk and is what every test run
    // and every dev launch must keep loading.
    await writeFile(join(dir, "secondary.worker.ts"), "// source\n");
    const source = pathToFileURL(join(dir, "secondary.worker.ts"));
    const found = locateRuntimeWorker(source);
    expect(found.origin).toBe("source");
    expect(found.path).toBe(join(dir, "secondary.worker.ts"));
    expect(found.url.href).toBe(source.href);
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});

test("a worker that is nowhere names every path it tried", async () => {
  delete process.env[RUNTIME_WORKERS_DIR_ENV];
  const dir = await scratch();
  try {
    const source = pathToFileURL(join(dir, "gone.worker.ts"));
    expect(() => locateRuntimeWorker(source)).toThrow(/gone\.worker\.js/u);
    let message = "";
    try {
      locateRuntimeWorker(source);
    } catch (error) {
      message = (error as Error).message;
    }
    // The release directory a build must carry, named.
    expect(message).toContain("workers/");
    // Every candidate, including the source module that was not there.
    expect(message).toContain(join(dir, "gone.worker.ts"));
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
});
