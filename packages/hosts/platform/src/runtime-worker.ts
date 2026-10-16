/**
 * Where the runtime's Worker threads come from.
 *
 * Every server-side pool in this repository creates its worker with
 * `new Worker(new URL("./thing.worker.ts", import.meta.url))`. That works in a
 * checkout and does NOT work in a packaged runtime, and it fails in the worst
 * possible way: `bun build --compile` does not treat the `new URL(...)`
 * argument as an entry point, so the worker module is never embedded. At
 * runtime `import.meta.url` is `file:///B:/~BUN/root/<binary>` — Bun's
 * EMBEDDED filesystem — the URL resolves to `B:\~BUN\root\thing.worker.ts`, and
 * the worker's own bootstrap dies with
 *
 *   BuildMessage: ModuleNotFound resolving "B:\~BUN\root\thing.worker.ts"
 *
 * delivered as an asynchronous `error` EVENT rather than a constructor throw.
 * Measured on bun 1.4.0 with the source run as the control: the source run
 * answered its first message, the compiled run answered nothing at all, and
 * every task then waited out its pool's deadline. That is what a fresh
 * install's startup was: several pools, each call paying the full deadline for
 * an answer that could never arrive.
 *
 * The answer is the one the release already uses for its tree-sitter WASM
 * files (`packages/core/tools/src/wasm-paths.ts`): the module must be a REAL
 * FILE beside the executable. `scripts/ts-build.ts` stages the worker bundles
 * into `workers/`, the release builder copies that directory into the release
 * root beside `natalia.exe`, and this resolver prefers the staged copy over the
 * source module — so a packaged runtime loads a real file while a checkout
 * keeps loading the TypeScript it always did.
 *
 * There is no platform branch here on purpose: the layout is the same on every
 * host, and a Windows-only fix would leave the Linux release depending on the
 * embedded path that does not exist there either.
 */
import { existsSync } from "node:fs";
import { basename, dirname, join } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";

/**
 * The directory beside the executable that a release stages Worker bundles in.
 *
 * One flat directory for all of them: the names are already unique (they end in
 * `.worker`), and a nested layout would have to be mirrored by the build, the
 * checksum walk, the installers and this resolver for no gain.
 */
export const RUNTIME_WORKERS_DIR = "workers";

/**
 * Overrides the staged directory. For a test or a debugging run that has built
 * the worker bundles somewhere else; never needed by a normal launch, which
 * finds the release's own copy.
 */
export const RUNTIME_WORKERS_DIR_ENV = "NATALIA_RUNTIME_WORKERS_DIR";

export type RuntimeWorkerLocation = {
  /** Hand this to `new Worker(...)`. */
  url: URL;
  /** The absolute path that was found, so a log line can name the real file. */
  path: string;
  /**
   * `staged` — the bundle the build produced, beside the executable or beside
   * the bundle being run; `source` — the TypeScript module itself, which is
   * what a checkout has and what every test run uses.
   */
  origin: "staged" | "source";
};

function safeFilePath(url: URL): string | undefined {
  try {
    return fileURLToPath(url);
  } catch {
    // Some launch modes hand out a URL that is not convertible; the basename
    // then comes from the URL's own path, and the existence check below simply
    // reports "not here".
    return undefined;
  }
}

/** `session-project.worker` from `…/session-project.worker.ts`. */
function workerBaseName(sourceUrl: URL): string {
  const file = safeFilePath(sourceUrl) ?? sourceUrl.pathname;
  return basename(file).replace(/\.[cm]?[jt]sx?$/u, "");
}

/**
 * The directories a staged bundle can be in, most specific first.
 *
 * `process.argv[0]` and `process.execPath` are both tried for the reason
 * `wasm-paths.ts` tries both: under some launch modes one of them is the real
 * executable and the other is Bun's embedded path, and which is which is not a
 * documented contract.
 */
function stagedWorkerDirs(sourceUrl: URL): string[] {
  const dirs: string[] = [];
  const override = process.env[RUNTIME_WORKERS_DIR_ENV]?.trim();
  if (override) dirs.push(override);
  for (const executable of [process.argv[0], process.execPath]) {
    if (!executable) continue;
    const dir = dirname(executable);
    // A bare command name ("bun") has the current directory as its dirname,
    // and searching the working directory would find an unrelated tree.
    if (!dir || dir === ".") continue;
    dirs.push(join(dir, RUNTIME_WORKERS_DIR));
  }
  // The directory of the module being run, which is where `dist/ts/workers/`
  // lands: `bun dist/ts/natalia-ts.js` is a launch mode the tests and the
  // distribution both use, and there the worker sits beside the bundle rather
  // than beside a binary.
  const sourcePath = safeFilePath(sourceUrl);
  if (sourcePath) dirs.push(join(dirname(sourcePath), RUNTIME_WORKERS_DIR));
  return dirs;
}

/**
 * Locate the worker module for a source URL of the form
 * `new URL("./thing.worker.ts", import.meta.url)`.
 *
 * The name is derived from the URL rather than passed separately so the two can
 * never disagree, and the staged file keeps the source's own name with a `.js`
 * extension — what `scripts/ts-build.ts` emits.
 *
 * Throws with every path it tried, because the failure this replaces was a
 * silent one: the constructor did not throw, nothing was logged, and the only
 * symptom was a deadline. A thrown error here reaches the pool, which records
 * it and fails its callers fast instead of letting each of them wait.
 */
export function locateRuntimeWorker(sourceUrl: URL): RuntimeWorkerLocation {
  const stagedName = `${workerBaseName(sourceUrl)}.js`;
  const searched: string[] = [];
  for (const dir of stagedWorkerDirs(sourceUrl)) {
    const path = join(dir, stagedName);
    searched.push(path);
    try {
      if (existsSync(path))
        return { url: pathToFileURL(path), path, origin: "staged" };
    } catch {
      // Not inspectable is the same answer as absent.
    }
  }
  // The source module itself — what a checkout has, what every test run and
  // every dev launch loads. Checked whenever the URL converted to a real path:
  // the previous guard (`sourcePath !== sourceUrl.pathname`) asked Windows a
  // question its answer is always yes to (fileURLToPath gives `C:\…`, the URL
  // keeps `/C:…`) and POSIX an answer that is always no (both are `/tmp/…`) —
  // so on Linux the source candidate was never even tried, a missing bundle
  // threw instead of falling back, and CI failed the tests that pin exactly
  // this. A non-convertible URL still returns undefined above, and a packaged
  // run's embedded path (`B:\~BUN\root\…`) simply does not exist on disk, so
  // `existsSync` is the only test that matters. There is no platform branch
  // here on purpose — see the header.
  const sourcePath = safeFilePath(sourceUrl);
  if (sourcePath) {
    searched.push(sourcePath);
    try {
      if (existsSync(sourcePath))
        return { url: sourceUrl, path: sourcePath, origin: "source" };
    } catch {
      // As above.
    }
  }
  throw new Error(
    `the ${stagedName} worker module was not found. Looked for it at: ` +
      `${searched.join(", ")}. A packaged runtime must carry its Workers in ` +
      `${RUNTIME_WORKERS_DIR}/ beside the executable — if that directory is ` +
      `missing, the build did not stage it, and every task posted to this pool ` +
      `would wait out its deadline without an answer.`,
  );
}
