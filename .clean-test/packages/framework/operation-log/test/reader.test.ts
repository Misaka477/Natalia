import { afterAll, beforeAll, expect, test } from "bun:test";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOperationLog, readOperationRecords } from "../src/index";

let base = "";

beforeAll(() => {
  base = mkdtempSync(join(tmpdir(), "operation-reader-"));
});

afterAll(() => {
  rmSync(base, { recursive: true, force: true });
});

test("the read side filters like the unified query and reads rotated files", async () => {
  const dir = join(base, "logs");
  // maxBytes small enough to force rotations: rotated generations must
  // still be readable — the recents view spans the whole retained history.
  const log = createOperationLog({
    dir,
    maxBytes: 400,
    keep: 3,
    level: "trace",
  });
  for (let index = 0; index < 30; index += 1) {
    const component = index % 2 === 0 ? "collab" : "shutdown";
    const level = index % 5 === 0 ? "error" : index % 3 === 0 ? "warn" : "info";
    log.component(component)[level](`message ${index}`, { seq: index });
  }
  await log.flush();
  const all = readOperationRecords(dir);
  // keep is a BOUND: 30 written, only the retained tail is readable — the
  // reader spans active + rotated, and retention actually bites.
  expect(log.stats().rotated).toBeGreaterThan(0);
  expect(all.length).toBeGreaterThan(0);
  expect(all.length).toBeLessThan(30);
  expect(all.map((record) => record.message)).toContain("message 29");
  // Rotated generations contribute: the active file alone holds fewer.
  const activeOnly = readFileSync(join(dir, "operations.jsonl"), "utf8")
    .split("\n")
    .filter(Boolean);
  expect(all.length).toBeGreaterThan(activeOnly.length);

  // Severity gate: warn means warn+error (the recents default).
  const severe = readOperationRecords(dir, { level: "warn" });
  expect(
    severe.every(
      (record) => record.level === "warn" || record.level === "error",
    ),
  ).toBe(true);
  expect(severe.length).toBeLessThan(30);

  // Component exactness.
  const collab = readOperationRecords(dir, { component: "collab" });
  expect(collab.every((record) => record.component === "collab")).toBe(true);

  // Free text over the serialized record (fields included).
  const seq27 = readOperationRecords(dir, { contains: '"seq":27' });
  expect(seq27).toHaveLength(1);

  // The tail cap keeps the NEWEST records.
  const tail = readOperationRecords(dir, { limit: 5 });
  expect(tail).toHaveLength(5);
  expect(tail.at(-1)).toMatchObject({ message: "message 29" });

  // since: bounds on the recorded timestamp.
  const future = readOperationRecords(dir, {
    since: "2999-01-01T00:00:00.000Z",
  });
  expect(future).toHaveLength(0);
  await log.close();
});
