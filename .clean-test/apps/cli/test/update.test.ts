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

/**
 * D3a claims drill for `natalia update`: the usage gate rejects
 * positionals (flag VALUES are not positionals — the `runs` lesson),
 * a source is explicit until D5's channel, and the real CLI performs
 * the full switch against a fixture home.
 */

let scratch = "";
afterAll(() => {
  if (scratch) rmSync(scratch, { recursive: true, force: true });
});

function run(args: string[]) {
  return Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "..", "src", "main.ts"), ...args],
    { stdout: "pipe", stderr: "pipe" },
  );
}
const out = (proc: { stdout: Uint8Array }) =>
  new TextDecoder().decode(proc.stdout);
const err = (proc: { stderr: Uint8Array }) =>
  new TextDecoder().decode(proc.stderr);
const sha = (bytes: Uint8Array | string) =>
  createHash("sha256").update(bytes).digest("hex");

test("update refuses positionals with usage (flag values are not positionals)", () => {
  const bad = run(["update", "export"]);
  expect(bad.exitCode).toBe(1);
  expect(err(bad)).toContain("usage: natalia update");
  const trailing = run(["update", "--from", "/tmp", "--home", "/tmp", "extra"]);
  expect(trailing.exitCode).toBe(1);
  expect(err(trailing)).toContain("usage: natalia update");
});

test("a bare update resolves its channel — unreachable fails bounded, naming both overrides", () => {
  // loopback-refused = instant and deterministic; the DEFAULT contracted
  // URL's live reachability is infrastructure's half, not asserted here.
  const none = Bun.spawnSync(
    [process.execPath, join(import.meta.dir, "..", "src", "main.ts"), "update"],
    {
      stdout: "pipe",
      stderr: "pipe",
      env: Object.fromEntries(
        Object.entries({
          ...process.env,
          NATALIA_UPDATE_CHANNEL: "http://127.0.0.1:1/channel.json",
        }).filter(([, value]) => value !== undefined),
      ) as Record<string, string>,
    },
  );
  expect(none.exitCode).toBe(1);
  // Either honest form: "channel unreachable …" (a refused connect) or
  // "channel HTTP <status>" (this sandbox's proxy answers loopbacks) —
  // the contract is: bounded, exited, and BOTH overrides named.
  expect(err(none)).toMatch(/channel unreachable|channel HTTP \d+/u);
  expect(err(none)).toContain("NATALIA_UPDATE_CHANNEL");
  expect(err(none)).toContain("--from");
});

test("the real CLI switches a fixture install (and its receipt lands)", () => {
  scratch = mkdtempSync(join(tmpdir(), "natalia-update-cli-"));
  const home = join(scratch, "home");
  const rel = join(scratch, "release");
  // install.sh layout: relative link under bin/
  mkdirSync(join(home, "versions", "1.0.0"), { recursive: true });
  mkdirSync(join(home, "bin"), { recursive: true });
  const oldBin = join(home, "versions", "1.0.0", "natalia");
  writeFileSync(oldBin, "#!/bin/sh\nprintf '%s\\n' \"1.0.0\"\n");
  chmodSync(oldBin, 0o755);
  symlinkSync("../versions/1.0.0/natalia", join(home, "bin", "natalia"));
  // release:build layout: VERSION + the binary + sums
  mkdirSync(rel, { recursive: true });
  const newBin = join(rel, "natalia");
  writeFileSync(newBin, "#!/bin/sh\nprintf '%s\\n' \"2.0.0\"\n");
  chmodSync(newBin, 0o755);
  writeFileSync(join(rel, "VERSION"), "2.0.0\n");
  const lines = ["natalia", "VERSION"].map((name) => {
    const hex = sha(new Uint8Array(readFileSync(join(rel, name))));
    return `${hex}  ${name}`;
  });
  writeFileSync(join(rel, "SHA256SUMS"), `${lines.join("\n")}\n`);

  const ok = run(["update", "--from", rel, "--home", home]);
  expect(ok.exitCode).toBe(0);
  expect(out(ok)).toContain("update: switched");
  expect(readlinkSync(join(home, "bin", "natalia"))).toBe(
    "../versions/2.0.0/natalia",
  );
  expect(out(ok)).toContain("receipt:");
  const receipts = readdirSync(join(home, "receipts"));
  expect(receipts.some((name) => name.startsWith("update-"))).toBe(true);
});

test("a LOCAL channel drives a bare update end to end (D5's mechanism)", () => {
  scratch = mkdtempSync(join(tmpdir(), "natalia-update-channel-"));
  const home = join(scratch, "home");
  const rel = join(scratch, "0.2.0");
  // installed 0.1.0 — the channel's latest must be an UPGRADE
  // (0.2.0 > 0.1.0; the downgrade guard refuses the other direction)
  mkdirSync(join(home, "versions", "0.1.0"), { recursive: true });
  mkdirSync(join(home, "bin"), { recursive: true });
  const oldBin = join(home, "versions", "0.1.0", "natalia");
  writeFileSync(oldBin, "#!/bin/sh\nprintf '%s\\n' \"0.1.0\"\n");
  chmodSync(oldBin, 0o755);
  symlinkSync("../versions/0.1.0/natalia", join(home, "bin", "natalia"));
  // the release the channel points at
  mkdirSync(rel, { recursive: true });
  const newBin = join(rel, "natalia");
  writeFileSync(newBin, "#!/bin/sh\nprintf '%s\\n' \"0.2.0\"\n");
  chmodSync(newBin, 0o755);
  writeFileSync(join(rel, "VERSION"), "0.2.0\n");
  const sums = ["natalia", "VERSION"]
    .map(
      (name) =>
        `${sha(new Uint8Array(readFileSync(join(rel, name))))}  ${name}`,
    )
    .join("\n");
  writeFileSync(join(rel, "SHA256SUMS"), `${sums}\n`);
  // the channel descriptor — the ONLY thing the command needs
  const channel = join(scratch, "channel.json");
  writeFileSync(
    channel,
    JSON.stringify({
      schema: "natalia.update-channel/1",
      latest: "0.2.0",
      source: "0.2.0/",
    }),
  );
  const bare = run(["update", "--home", home, "--channel", channel]);
  expect(bare.exitCode).toBe(0);
  expect(out(bare)).toContain("update: switched");
  expect(readlinkSync(join(home, "bin", "natalia"))).toBe(
    "../versions/0.2.0/natalia",
  );
});
