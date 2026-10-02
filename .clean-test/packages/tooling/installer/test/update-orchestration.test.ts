import { afterAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UPDATE_RECEIPT_KEEP, updateProgram } from "../src/update";

/**
 * D3b/B2: detect → drain → (D3a's original path) → restart — with the
 * order itself as the assertion, the drain NEVER letting a flip happen
 * when the runtime refuses, and a failed restart becoming a WARNING
 * (the flip is verified-good) rather than a lie of success or failure.
 */

const homes: string[] = [];
const servers: Array<{ stop: (force?: boolean) => void }> = [];
afterAll(() => {
  for (const home of homes) rmSync(home, { recursive: true, force: true });
  for (const server of servers) server.stop(true);
});

const sha = (bytes: Uint8Array) =>
  createHash("sha256").update(bytes).digest("hex");
function shell(path: string, body: string) {
  mkdirSync(join(path, ".."), { recursive: true });
  writeFileSync(path, body);
  chmodSync(path, 0o755);
}
function makeHome() {
  const home = mkdtempSync(join(tmpdir(), "orch-home-"));
  homes.push(home);
  mkdirSync(join(home, "versions", "1.0.0"), { recursive: true });
  mkdirSync(join(home, "bin"), { recursive: true });
  shell(
    join(home, "versions", "1.0.0", "natalia"),
    `#!/bin/sh\nprintf '%s\\n' "1.0.0"\n`,
  );
  symlinkSync("../versions/1.0.0/natalia", join(home, "bin", "natalia"));
  return home;
}
function makeRelease(version = "2.0.0") {
  const dir = mkdtempSync(join(tmpdir(), "orch-rel-"));
  homes.push(dir);
  shell(join(dir, "natalia"), `#!/bin/sh\nprintf '%s\\n' "${version}"\n`);
  writeFileSync(join(dir, "VERSION"), `${version}\n`);
  const lines = ["natalia", "VERSION"].map(
    (name) => `${sha(new Uint8Array(readFileSync(join(dir, name))))}  ${name}`,
  );
  writeFileSync(join(dir, "SHA256SUMS"), `${lines.join("\n")}\n`);
  return dir;
}
type Seen = { bodies: unknown[]; auths: string[] };
function fakeRuntime(mode: "ok" | "refuse") {
  const seen: Seen = { bodies: [], auths: [] };
  const server = Bun.serve({
    port: 0,
    async fetch(request) {
      seen.auths.push(request.headers.get("authorization") ?? "");
      const body = (await request.json()) as { id: number };
      seen.bodies.push(body);
      const payload =
        mode === "ok"
          ? { jsonrpc: "2.0", id: body.id, result: { waitedMs: 42 } }
          : {
              jsonrpc: "2.0",
              id: body.id,
              error: {
                code: -32000,
                message: "2 turn(s) still active after 120000ms",
              },
            };
      return Response.json(payload);
    },
  });
  servers.push(server);
  return { url: `http://127.0.0.1:${server.port}`, seen };
}
const stepNames = (steps: Array<{ name: string }>) => steps.map((s) => s.name);

test("the ordered orchestration: detect and drain bracket D3a's path, restart runs LAST", async () => {
  const home = makeHome();
  const rel = makeRelease();
  const runtime = fakeRuntime("ok");
  const calls: string[][] = [];
  const result = await updateProgram({
    home,
    from: rel,
    runtime: { url: runtime.url, token: "tok", drainTimeoutMs: 500 },
    restartUnit: "natalia-daemon.service",
    exec: (argv) => {
      calls.push(argv);
      return { code: 0, output: "ok" };
    },
  });
  expect(result.outcome).toBe("switched");
  expect(result.warning).toBeUndefined();
  expect(stepNames(result.steps)).toEqual([
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
  const drainStep = result.steps.find((s) => s.name === "drain")!;
  expect(drainStep.detail).toBe("waited 42ms");
  // the wire spoke B1's route with the bearer and the bounded timeout
  const bodies = runtime.seen.bodies as Array<{
    method?: string;
    params?: { timeoutMs?: number };
  }>;
  expect(bodies[0]?.method).toBe("daemon.drain");
  expect(bodies[0]?.params).toEqual({ timeoutMs: 500 });
  expect(runtime.seen.auths[0]).toBe("Bearer tok");
  expect(calls).toEqual([["systemctl", "restart", "natalia-daemon.service"]]);
  // the receipt carries the same order (it IS the proof)
  const receipt = JSON.parse(readFileSync(result.receiptPath!, "utf8")) as {
    steps: Array<{ name: string }>;
  };
  expect(stepNames(receipt.steps)).toEqual(stepNames(result.steps));
});

test("a refused drain aborts BEFORE anything is touched", async () => {
  const home = makeHome();
  const rel = makeRelease();
  const runtime = fakeRuntime("refuse");
  const result = await updateProgram({
    home,
    from: rel,
    runtime: { url: runtime.url, drainTimeoutMs: 300 },
    restartUnit: "should-not-run.service",
    exec: () => {
      throw new Error("restart must never be reached");
    },
  });
  expect(result.outcome).toBe("refused");
  expect(result.exitCode).toBe(1);
  expect(result.reason).toContain("2 turn(s) still active");
  expect(existsSync(join(home, "versions", "2.0.0"))).toBe(false);
  expect(
    JSON.parse(readFileSync(result.receiptPath!, "utf8")).steps.find(
      (s: { name: string }) => s.name === "drain",
    ).ok,
  ).toBe(false);
});

test("a failed restart is a WARNING: the verified flip stands, the receipt says why", async () => {
  const home = makeHome();
  const result = await updateProgram({
    home,
    from: makeRelease(),
    restartUnit: "broken.service",
    exec: () => ({ code: 1, output: "unit not found" }),
  });
  expect(result.outcome).toBe("switched");
  expect(result.exitCode).toBe(0);
  expect(result.warning).toContain("unit not found");
  expect(result.warning).toContain("systemctl restart broken.service");
  expect(result.steps.at(-1)).toMatchObject({ name: "restart", ok: false });
  const receipt = JSON.parse(readFileSync(result.receiptPath!, "utf8"));
  expect(receipt.warning).toContain("unit not found");
});

test("no runtime = no drain step (the interactive path is unchanged)", async () => {
  const home = makeHome();
  const result = await updateProgram({ home, from: makeRelease() });
  expect(result.outcome).toBe("switched");
  expect(stepNames(result.steps)).toEqual([
    "locate",
    "detect",
    "verify",
    "version",
    "stage",
    "swap",
    "probe",
  ]);
  expect(result.steps.find((s) => s.name === "detect")!.detail).toContain(
    "none",
  );
});

test("channelLatest: equal = up-to-date with nothing staged; older = a refused downgrade; newer proceeds", async () => {
  // equal: the channel's latest IS the installed version
  const equalHome = makeHome(); // installed 1.0.0
  const equal = await updateProgram({
    home: equalHome,
    from: makeRelease("2.0.0"),
    channelLatest: "1.0.0",
  });
  expect(equal.outcome).toBe("up-to-date");
  expect(equal.exitCode).toBe(0);
  expect(equal.steps.map((s) => s.name)).toEqual(["locate", "detect"]);
  expect(existsSync(join(equalHome, "versions", "2.0.0"))).toBe(false);

  // older: the channel would ROLL US BACK — a channel is upgrade-only,
  // an explicit --from is the deliberate exact install
  const olderHome = makeHome(); // installed 1.0.0... downgrade needs an
  // installed version NEWER than the channel: make the install 2.0.0
  rmSync(join(olderHome, "versions", "1.0.0"), {
    recursive: true,
    force: true,
  });
  const two = join(olderHome, "versions", "2.0.0");
  mkdirSync(two, { recursive: true });
  const bin = join(two, "natalia");
  writeFileSync(bin, "#!/bin/sh\nprintf '%s\\n' \"2.0.0\"\n");
  chmodSync(bin, 0o755);
  rmSync(join(olderHome, "bin", "natalia"));
  symlinkSync("../versions/2.0.0/natalia", join(olderHome, "bin", "natalia"));
  const down = await updateProgram({
    home: olderHome,
    from: makeRelease("1.0.0"),
    channelLatest: "1.0.0",
  });
  expect(down.outcome).toBe("refused");
  expect(down.reason).toContain("OLDER than the installed 2.0.0");
  expect(down.reason).toContain("--from");
  expect(existsSync(join(olderHome, "versions", "1.0.0"))).toBe(false);

  // newer: the upgrade proceeds through the whole path
  const newer = await updateProgram({
    home: makeHome(),
    from: makeRelease("3.0.0"),
    channelLatest: "3.0.0",
  });
  expect(newer.outcome).toBe("switched");
  expect(newer.steps.map((s) => s.name)).toEqual([
    "locate",
    "detect",
    "verify",
    "version",
    "stage",
    "swap",
    "probe",
  ]);
});
