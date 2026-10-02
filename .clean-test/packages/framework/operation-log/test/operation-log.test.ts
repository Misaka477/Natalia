import { afterAll, beforeAll, expect, test } from "bun:test";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  createOperationLog,
  logOf,
  noopOperationLog,
  type OperationRecord,
} from "../src/index";

/**
 * The operation-log layer (decisions §5 + interface spec §4.5): records
 * whose correlation arrives on the record side, one redaction exit, and a
 * telemetry facility that degrades instead of ever throwing.
 */

let base = "";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "operation-log-"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

function dir(name: string): string {
  const path = join(base, name);
  mkdirSync(path, { recursive: true });
  return path;
}

async function records(path: string): Promise<OperationRecord[]> {
  const log = join(path, "operations.jsonl");
  if (!existsSync(log)) return [];
  return readFileSync(log, "utf8")
    .split("\n")
    .filter(Boolean)
    .map((line) => JSON.parse(line) as OperationRecord);
}

test("records are JSONL with level, component, message and fields", async () => {
  const path = dir("shape");
  const log = createOperationLog({ dir: path });
  log.component("wake").info("admitted", { sessionID: "ses_1", round: 2 });
  await log.flush();
  const [record] = await records(path);
  expect(record).toMatchObject({
    level: "info",
    component: "wake",
    message: "admitted",
    fields: { sessionID: "ses_1", round: 2 },
  });
  expect(typeof record!.at).toBe("string");
  await log.close();
});

test("the level gate is the primary retention", async () => {
  const path = dir("levels");
  const log = createOperationLog({ dir: path }); // default info
  log.component("x").debug("invisible");
  log.component("x").trace("also invisible");
  log.component("x").warn("kept");
  log.component("x").error("kept too");
  await log.flush();
  const lines = await records(path);
  expect(lines.map((line) => line.level)).toEqual(["warn", "error"]);
  await log.close();

  const verbose = createOperationLog({ dir: dir("levels2"), level: "trace" });
  verbose.component("x").debug("now visible");
  await verbose.flush();
  expect((await records(dir("levels2"))).map((line) => line.level)).toEqual([
    "debug",
  ]);
  await verbose.close();
});

test("correlation is injected on the record side and merges through nests", async () => {
  const path = dir("corr");
  const log = createOperationLog({ dir: path });
  const outside = log.component("outside");
  outside.info("no ids here"); // outside any scope: no corr at all

  log.runWithCorrelation({ sessionID: "ses_a" }, () => {
    log.component("turn").info("started");
    log.runWithCorrelation({ turnID: "turn_b" }, () => {
      // The record side accumulates — no call site passed either id.
      log.component("tool").info("running");
      // A bound override wins over the ambient bag.
      log
        .component("tool")
        .withCorrelation({ toolCallID: "call_1" })
        .info("with tool id");
    });
  });

  await log.flush();
  const byMessage = new Map(
    (await records(path)).map((record) => [record.message, record.corr]),
  );
  expect(byMessage.get("no ids here")).toBeUndefined();
  expect(byMessage.get("started")).toEqual({ sessionID: "ses_a" });
  expect(byMessage.get("running")).toEqual({
    sessionID: "ses_a",
    turnID: "turn_b",
  });
  expect(byMessage.get("with tool id")).toEqual({
    sessionID: "ses_a",
    turnID: "turn_b",
    toolCallID: "call_1",
  });
  await log.close();
});

test("rotation keeps a bounded tail", async () => {
  const path = dir("rotate");
  const log = createOperationLog({ dir: path, maxBytes: 400, keep: 2 });
  for (let index = 0; index < 40; index += 1)
    log.component("bulk").info(`record ${index}`);
  await log.flush();
  const files = readdirSync(path).sort();
  expect(files).toContain("operations.jsonl");
  expect(files).toContain("operations.jsonl.1");
  expect(files).toContain("operations.jsonl.2");
  expect(files).not.toContain("operations.jsonl.3"); // keep = 2
  expect(log.stats().rotated).toBeGreaterThan(0);
  await log.close();
});

test("an unwritable directory disables telemetry without throwing", async () => {
  const path = dir("readonly");
  chmodSync(path, 0o500);
  try {
    const log = createOperationLog({ dir: join(path, "nested") });
    log.component("x").error("must not throw");
    await log.flush();
    const stats = log.stats();
    expect(stats.written).toBe(0);
    expect(stats.disabledReason).toBeTruthy();
    await log.close();
  } finally {
    chmodSync(path, 0o700);
  }
});

test("redaction is the single exit — fields pass through it too", async () => {
  const path = dir("redact");
  const log = createOperationLog({
    dir: path,
    redact: (line) => line.replaceAll("hunter2", "[redacted]"),
  });
  log.component("config").warn("api key", { key: "hunter2" });
  await log.flush();
  const raw = readFileSync(join(path, "operations.jsonl"), "utf8");
  expect(raw).not.toContain("hunter2");
  expect(raw).toContain("[redacted]");
  await log.close();
});

test("records keep their order through the async chain", async () => {
  const path = dir("order");
  const log = createOperationLog({ dir: path });
  for (let index = 0; index < 50; index += 1)
    log.component("seq").info(`m${index}`);
  await log.flush();
  const messages = (await records(path)).map((record) => record.message);
  expect(messages).toHaveLength(50);
  expect(messages[0]).toBe("m0");
  expect(messages[49]).toBe("m49");
  await log.close();
});

test("logOf falls back to the no-op log — telemetry degrades, never crashes", () => {
  const log = logOf({ getOptional: () => undefined });
  expect(() => {
    log.component("bare").error("somewhere without a runtime");
    log.runWithCorrelation({ sessionID: "ses" }, () =>
      log.component("bare").info("still fine"),
    );
  }).not.toThrow();
  expect(logOf({ getOptional: () => noopOperationLog })).toBe(noopOperationLog);
  expect(noopOperationLog.stats().disabledReason).toBeTruthy();
});
