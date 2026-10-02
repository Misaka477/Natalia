import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  readlinkSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RuntimeEvent, SessionID } from "@anthelia/contracts";
import {
  createRuntimeDaemonStore,
  daemonToken,
  registerRuntimeDaemon,
} from "@natalia/transport/host";
import { createRealRuntimeClient } from "@natalia/client";
import { createHttpTransportHost } from "../src/transport-host";

/**
 * D3b/B2's keystone, entirely real: a running runtime (gated turn
 * mid-flight) behind its HTTP host, registered in the daemon store;
 * the REAL CLI spawned against it — it must DETECT the store, DRAIN
 * (not flip while the turn is active), then flip and restart via a
 * PATH-injected systemctl that records what it was asked to do.
 */

let scratch = "";
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");

test("the CLI detects a live daemon, drains its active turn, flips, and restarts the unit", async () => {
  scratch = mkdtempSync(join(tmpdir(), "update-orch-e2e-"));
  const home = join(scratch, "home");
  const rel = join(scratch, "release");
  const stateHome = join(scratch, "state");
  const fakeBin = join(scratch, "bin");
  const systemctlLog = join(scratch, "systemctl.log");
  mkdirSync(fakeBin, { recursive: true });
  writeFileSync(
    join(fakeBin, "systemctl"),
    `#!/bin/sh\necho "$@" >> "${systemctlLog}"\n`,
  );
  chmodSync(join(fakeBin, "systemctl"), 0o755);
  // install.sh layout
  mkdirSync(join(home, "versions", "1.0.0"), { recursive: true });
  mkdirSync(join(home, "bin"), { recursive: true });
  const oldBin = join(home, "versions", "1.0.0", "natalia");
  writeFileSync(oldBin, "#!/bin/sh\nprintf '%s\\n' \"1.0.0\"\n");
  chmodSync(oldBin, 0o755);
  symlinkSync("../versions/1.0.0/natalia", join(home, "bin", "natalia"));
  // release:build layout
  mkdirSync(rel, { recursive: true });
  const newBin = join(rel, "natalia");
  writeFileSync(newBin, "#!/bin/sh\nprintf '%s\\n' \"2.0.0\"\n");
  chmodSync(newBin, 0o755);
  writeFileSync(join(rel, "VERSION"), "2.0.0\n");
  const sums = ["natalia", "VERSION"]
    .map(
      (name) =>
        `${sha(new Uint8Array(readFileSync(join(rel, name))))}  ${name}`,
    )
    .join("\n");
  writeFileSync(join(rel, "SHA256SUMS"), `${sums}\n`);

  // the daemon: store + token + a REAL host, and a gated turn in flight
  // The daemon's state directory follows the live state-directory name. A
  // test that computes this path independently agrees with the CLI's own
  // resolution — or the version flip reads the wrong binary, which is
  // exactly what this test caught when the two disagreed.
  const store = createRuntimeDaemonStore({
    dir: join(stateHome, "natalia", "daemon"),
  });
  const token = await daemonToken(store);
  let release!: () => void;
  const gate = new Promise<void>((resolve) => {
    release = resolve;
  });
  const events: RuntimeEvent[] = [];
  const client = createRealRuntimeClient({
    workspaceRoot: scratch,
    sessionID: "ses_orch" as SessionID,
    permissionMode: "auto",
    provider: {
      provider: "test",
      model: "test",
      async *stream() {
        await gate;
        yield { type: "content" as const, text: "done" };
        yield { type: "done" as const };
      },
    } as never,
  });
  client.start((event) => events.push(event));
  await client.sessionAttach!("ses_orch" as SessionID);
  const host = createHttpTransportHost({
    client,
    port: 0,
    events: false,
    token,
  });
  await registerRuntimeDaemon(store, {
    url: host.server.url.toString(),
    pid: process.pid,
    transport: "http",
  });
  const turn = client.submitAndWait!("gated turn");
  for (
    let i = 0;
    i < 400 && !events.some((e) => e.type === "turn.started");
    i += 1
  )
    await new Promise((resolve) => setTimeout(resolve, 25));

  // spawn the REAL CLI (async: the assertion needs it stuck in drain)
  const child = Bun.spawn(
    [
      process.execPath,
      join(import.meta.dir, "..", "src", "main.ts"),
      "update",
      "--from",
      rel,
      "--home",
      home,
      "--restart-unit",
      "natalia-daemon.service",
    ],
    {
      stdout: "pipe",
      stderr: "pipe",
      // bun's spawn env wants plain strings — process.env's entries
      // are `string | undefined`, and one undefined value makes the
      // whole spawn throw ERR_INVALID_ARG_TYPE.
      env: Object.fromEntries(
        Object.entries({
          ...process.env,
          XDG_STATE_HOME: stateHome,
          PATH: `${fakeBin}:${process.env.PATH ?? ""}`,
        }).filter(([, value]) => value !== undefined),
      ) as Record<string, string>,
    },
  );
  // while the turn is gated the update must be DRAINING, not flipped
  await new Promise((resolve) => setTimeout(resolve, 600));
  expect(existsSafe(join(home, "versions", "2.0.0"))).toBe(false);
  expect(readlinkSync(join(home, "bin", "natalia"))).toBe(
    "../versions/1.0.0/natalia",
  );

  release();
  await gate;
  await turn;
  const exitCode = await child.exited;
  const stdout = await new Response(child.stdout).text();
  expect(exitCode).toBe(0);
  expect(stdout).toContain("update: switched");
  expect(readlinkSync(join(home, "bin", "natalia"))).toBe(
    "../versions/2.0.0/natalia",
  );
  // the PATH-injected systemctl was asked exactly what the flag said
  expect(String(readFileSync(systemctlLog)).trim()).toBe(
    "restart natalia-daemon.service",
  );
  // the receipt narrates the whole chain including the waited drain
  const receiptName = readdirSync(join(home, "receipts")).find((n) =>
    n.startsWith("update-"),
  )!;
  const receipt = JSON.parse(
    readFileSync(join(home, "receipts", receiptName), "utf8"),
  ) as { steps: Array<{ name: string; detail?: string }> };
  expect(receipt.steps.map((s) => s.name)).toEqual([
    "locate",
    "detect",
    "verify",
    "version",
    "drain",
    "stage",
    "swap",
    "probe",
    "restart",
  ]);
  const drain = receipt.steps.find((s) => s.name === "drain")!;
  expect(drain.detail).toMatch(/^waited \d+ms$/u);
  expect(Number(drain.detail!.replace(/\D+/gu, ""))).toBeGreaterThanOrEqual(
    400,
  );

  await host.close();
  await client.dispose?.();
});

function existsSafe(path: string): boolean {
  try {
    readFileSync(path);
    return true;
  } catch {
    return false;
  }
}
