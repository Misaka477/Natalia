import { afterAll, beforeAll, expect, test } from "bun:test";
import { createHash } from "node:crypto";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { captureDebugBundle } from "../src/debug-bundle";

/**
 * `natalia debug-bundle` (decisions §5 一键捕获 / DoD #4): the bundle is a
 * log artifact — journal + operational log + redacted configs + doctor +
 * a queried summary, inventoried — and the redaction rule is tested,
 * because a bundle that leaks a key turns diagnosis into an incident.
 */

let base = "";
let home = "";
let workspace = "";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "debug-bundle-"));
  home = join(base, "natalia-home");
  workspace = join(base, "workspace");
  // The home: config with secrets + an operational log with severe records.
  mkdirSync(join(home, "logs"), { recursive: true });
  writeFileSync(
    join(home, "config.json"),
    JSON.stringify({
      version: 3,
      providers: {
        p: {
          name: "P",
          driver: "openai-compatible",
          connection: { apiKey: "sk-LEAK-ME" },
        },
      },
      note: "keep-this",
    }),
  );
  writeFileSync(
    join(home, "logs", "operations.jsonl"),
    [
      JSON.stringify({
        at: "2026-01-01T00:00:00.000Z",
        level: "info",
        component: "collab",
        message: "quiet",
      }),
      JSON.stringify({
        at: "2026-01-01T00:00:01.000Z",
        level: "error",
        component: "shutdown",
        message: "disposal stuck",
      }),
      "",
    ].join("\n"),
  );
  // The workspace: config, a journal slice, and a checkpoint that must
  // NOT travel (the bundle is logs, not data).
  mkdirSync(join(workspace, ".natalia", "sessions", "ses_one"), {
    recursive: true,
  });
  writeFileSync(
    join(workspace, ".natalia", "config.json"),
    JSON.stringify({ version: 3, runtime: { checkpoint: { maxFiles: 9 } } }),
  );
  writeFileSync(
    join(workspace, ".natalia", "sessions", "ses_one", "events.jsonl"),
    '{"type":"session.created"}\n',
  );
  mkdirSync(join(workspace, ".natalia", "checkpoints", "ses_one"), {
    recursive: true,
  });
  writeFileSync(
    join(workspace, ".natalia", "checkpoints", "ses_one", "big.bin"),
    "CHECKPOINT-BYTES",
  );
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

test("the bundle captures every source, redacts secrets, and inventories", async () => {
  const dest = join(base, "bundle");
  const report = await captureDebugBundle({
    workspaceRoot: workspace,
    dest,
    nataliaHome: home,
  });
  expect(report.captured).toMatchObject({
    journal: true,
    workspaceConfig: true,
    globalConfig: true,
    doctor: true,
  });
  expect(report.captured.operationalRecords).toBeGreaterThan(0);

  // The journal slice travels; the CHECKPOINTS do not (logs, not data).
  expect(existsSync(join(dest, "journal"))).toBe(true);
  expect(existsSync(join(dest, "checkpoints"))).toBe(false);
  const raw = JSON.stringify([
    ...["config/global.json", "config/workspace.json"].map((file) => {
      try {
        return readFileSync(join(dest, file), "utf8");
      } catch {
        return "";
      }
    }),
  ]);
  expect(raw).toContain("[REDACTED]");
  expect(raw).not.toContain("sk-LEAK-ME");
  expect(raw).toContain("keep-this"); // non-secrets keep their values

  // The queried recents: the operational half of the unified query.
  const recents = JSON.parse(
    readFileSync(join(dest, "recent-diagnostics.json"), "utf8"),
  ) as {
    operational: Array<{ level: string }>;
  };
  expect(
    recents.operational.every((record) =>
      ["warn", "error"].includes(record.level),
    ),
  ).toBe(true);
  expect(recents.operational.some((record) => record.level === "error")).toBe(
    true,
  );

  // The inventory verifies (D1/D2 discipline).
  const sums = readFileSync(join(dest, "SHA256SUMS"), "utf8")
    .trim()
    .split("\n");
  expect(sums.length).toBeGreaterThanOrEqual(report.files - 1);
  const [firstHash, firstFile] = sums[0]!.split(/\s+/u);
  expect(
    createHash("sha256")
      .update(readFileSync(join(dest, firstFile!)))
      .digest("hex"),
  ).toBe(firstHash);
});

test("an existing destination is refused — bundles never merge incidents", async () => {
  const dest = join(base, "bundle2");
  await captureDebugBundle({
    workspaceRoot: workspace,
    dest,
    nataliaHome: home,
  });
  await expect(
    captureDebugBundle({ workspaceRoot: workspace, dest, nataliaHome: home }),
  ).rejects.toThrow(/destination exists/u);
});

test("the CLI command wires end to end (NATALIA_HOME honored)", () => {
  const dest = join(base, "cli-bundle");
  const child = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "..", "src", "main.ts"),
      "debug-bundle",
      dest,
      "--workspace",
      workspace,
    ],
    {
      env: { ...process.env, NATALIA_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode).toBe(0);
  const out = new TextDecoder().decode(child.stdout);
  expect(out).toContain("debug bundle at");
  expect(existsSync(join(dest, "SHA256SUMS"))).toBe(true);
  expect(existsSync(join(dest, "journal"))).toBe(true);
});

test("without a destination the command refuses with usage", () => {
  const child = Bun.spawnSync(
    [
      process.execPath,
      join(import.meta.dir, "..", "src", "main.ts"),
      "debug-bundle",
    ],
    {
      env: { ...process.env, NATALIA_HOME: home },
      stdout: "pipe",
      stderr: "pipe",
    },
  );
  expect(child.exitCode).not.toBe(0);
  expect(new TextDecoder().decode(child.stderr)).toContain(
    "usage: natalia debug-bundle",
  );
});
