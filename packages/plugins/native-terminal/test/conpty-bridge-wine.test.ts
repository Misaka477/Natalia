import { expect, test } from "bun:test";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

/**
 * The ConPTY bridge, compiled and driven for real.
 *
 * This is the closest thing to running Windows that a Linux host can do: cross
 * compile with mingw, execute under wine. It exists because the bridge had only
 * ever been checked by reading it, and reading it missed that a child exiting on
 * its own — `cmd /c echo`, any short-lived command — produced NO exit frame: the
 * control loop blocked on stdin forever and the pane stayed "running".
 *
 * The A/B that found it: the pre-fix binary, same spec, same wine, times out. The
 * post-fix binary answers pid, output and exit.
 *
 * It skips where the toolchain is absent rather than failing, because a machine
 * without mingw or wine is not a broken machine.
 */

const repoRoot = join(import.meta.dir, "..", "..", "..", "..");
const bridgeSource = join(
  repoRoot,
  "packages",
  "plugins",
  "native-terminal",
  "src",
  "win",
  "natalia-conpty-bridge.cc",
);

const compiler = ["x86_64-w64-mingw32-g++", "i686-w64-mingw32-g++"].find(
  (candidate) => Bun.which(candidate) !== null,
);
const wine = Bun.which("wine") ?? Bun.which("wine64");

const canRun =
  compiler !== undefined && wine !== undefined && existsSync(bridgeSource);

test.skipIf(!canRun)(
  "the bridge answers a spec with a pid handshake, an output frame and an exit frame",
  async () => {
    const work = await mkdtemp(join(tmpdir(), "conpty-bridge-"));
    const prefix = join(work, "wine");
    try {
      await mkdir(prefix, { recursive: true });
      // There is no console to attach to, and the probe's value is the byte
      // stream, so a fresh prefix is created and torn down around it.
      const object = join(work, "bridge.o");
      const exe = join(work, "bridge.exe");
      const compiled = Bun.spawnSync(["true"], {
        stdout: "ignore",
        stderr: "ignore",
      });
      void compiled;
      const build = Bun.spawnSync(
        [compiler!, "-c", bridgeSource, "-o", object],
        {
          env: { ...process.env, CCACHE_DISABLE: "1" },
          stderr: "pipe",
        },
      );
      if (build.exitCode !== 0)
        throw new Error(
          `the ConPTY bridge no longer compiles:\n${build.stderr.toString()}`,
        );
      const link = Bun.spawnSync([compiler!, object, "-o", exe, "-static"], {
        env: { ...process.env, CCACHE_DISABLE: "1" },
        stderr: "pipe",
      });
      if (link.exitCode !== 0)
        throw new Error(
          `the ConPTY bridge no longer links:\n${link.stderr.toString()}`,
        );

      // The spec must be COMPACT JSON: the bridge's parser looks for
      // `"key":"value"` and a space after the colon makes it miss the field.
      // json.dumps with default separators produces the spaced form, which is
      // how this test first failed with "spec has no file".
      // A FRESH prefix is not ready to launch anything: wine spends its first
      // seconds populating it, and a child started during that window never runs
      // (the isolated case passed only because an earlier manual run had already
      // built a prefix). Bring it up explicitly and wait, so the bridge starts a
      // real shell rather than racing initialisation.
      const boot = Bun.spawnSync([wine!, "wineboot", "--init"], {
        cwd: work,
        env: { ...process.env, WINEPREFIX: prefix, WINEDEBUG: "-all" },
        stdout: "ignore",
        stderr: "ignore",
      });
      if (boot.exitCode === 0) {
        const init = Bun.spawnSync([wine!, "cmd", "/c", "exit 0"], {
          cwd: work,
          env: { ...process.env, WINEPREFIX: prefix, WINEDEBUG: "-all" },
          stdout: "ignore",
          stderr: "ignore",
        });
        void init;
      }

      const spec = {
        file: "cmd.exe",
        args: ["/c", "echo CONPTY_E2E_OK"],
        cwd: work,
        cols: 80,
        rows: 25,
        env: {},
      };
      const bridge = Bun.spawn([wine!, exe], {
        cwd: work,
        stdin: "pipe",
        stdout: "pipe",
        stderr: "pipe",
        env: { ...process.env, WINEPREFIX: prefix, WINEDEBUG: "-all" },
      });
      bridge.stdin.write(`${JSON.stringify(spec)}\n`);
      await bridge.stdin.flush();

      const frames: string[] = [];
      const deadline = Date.now() + 90_000;
      let exitFrame = "";
      // ONE reader for the whole loop: getReader() locks the stream, so calling
      // it per iteration throws ERR_INVALID_STATE after the first read.
      const reader = bridge.stdout.getReader();
      const decoder = new TextDecoder();
      while (Date.now() < deadline) {
        const { value, done } = await Promise.race([
          reader.read(),
          new Promise<{ value?: Uint8Array; done: boolean }>((resolve) =>
            setTimeout(() => resolve({ done: false }), 5_000),
          ),
        ]);
        if (done) break;
        if (!value) {
          if (bridge.exitCode !== null) break;
          continue;
        }
        const line = decoder.decode(value);
        frames.push(line);
        const trimmed = line.trim();
        if (trimmed.startsWith("x ")) {
          exitFrame = trimmed;
          break;
        }
      }
      reader.releaseLock();

      const stream = frames.join("");
      // The handshake, then real screen bytes from the child, then the exit.
      expect(stream).toContain('"pid"');
      expect(stream).toContain("CONPTY_E2E_OK");
      // THE one that matters: a self-exiting child must produce an exit frame.
      // Before the reader thread this hung until the caller gave up, and the
      // pane it served reported "running" forever.
      expect(
        exitFrame,
        "the child exited, so an exit frame must follow",
      ).not.toBe("");
      expect(exitFrame).toMatch(/^x \d+$/u);

      bridge.kill();
    } finally {
      await rm(work, { recursive: true, force: true });
    }
  },
  120_000,
);

test("the control loop is woken by the child exiting, not only by stdin", () => {
  // The structural half, which runs everywhere: the loop must wait on BOTH
  // handles. A loop that only ever blocks on stdin is the bug, and it is not
  // visible in a source read that does not look for the second handle.
  const source = readFileSyncOrEmpty(bridgeSource);
  expect(source).toContain("WaitForMultipleObjects");
  // Both handles in ONE wait: the line-arrived event and the child. They are
  // named in an array beside the call, which is the shape to assert — matching
  // them inside the call's argument list fails on the actual code.
  expect(source).toContain(
    "const HANDLE waitFor[] = {g_lineArrived, g_childProcess};",
  );
  expect(source).toContain(
    "WaitForMultipleObjects(2, waitFor, FALSE, INFINITE)",
  );
  // And the reader that owns the blocking read.
  expect(source).toContain("pumpControlInput");
  expect(source).toContain("popControlLine");
});

function readFileSyncOrEmpty(path: string): string {
  return existsSync(path) ? require("node:fs").readFileSync(path, "utf8") : "";
}
