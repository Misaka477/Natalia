import { afterAll, expect, test } from "bun:test";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createRinaMemory, type RinaMemoryService } from "../src/memory";

/**
 * RINA Memory's four rules as contracts (Phase 7): admission is
 * evidence-backed (no source, no memory), the lifecycle is a machine with
 * recorded transitions (nothing resurrects), the recall serves the ACTIVE
 * set in scope, and one redaction seam runs on write.
 */

let base = "";
const services: RinaMemoryService[] = [];
function memory(redact?: (content: string) => string): RinaMemoryService {
  const dir = mkdtempSync(join(base || tmpdir(), "rina-memory-"));
  const service = createRinaMemory({ dir, ...(redact ? { redact } : {}) });
  services.push(service);
  return service;
}
afterAll(() => {
  for (const service of services) service.close();
  if (base) rmSync(base, { recursive: true, force: true });
});

test("admission requires evidence; the pre-live statuses only", () => {
  const m = memory();
  expect(() =>
    m.remember({ scope: "global", content: "x", evidenceID: "  " }),
  ).toThrow(/requires a source evidence/);
  expect(() =>
    m.remember({
      scope: "global",
      content: "x",
      evidenceID: "ev:1",
      status: "superseded",
    }),
  ).toThrow(/refuses superseded/);
  const id = m.remember({
    scope: "global",
    content: "the parser cfg lives in src/parser",
    evidenceID: "ev:1",
    status: "active",
  });
  expect(m.get(id)?.status).toBe("active");
  // Two admissions in the same millisecond are two rows: the id is unique
  // per admission (a timestamp-only id collided, and INSERT OR REPLACE
  // silently ate the earlier memory).
  const second = m.remember({
    scope: "global",
    content: "a second fact",
    evidenceID: "ev:2",
    status: "active",
  });
  expect(second).not.toBe(id);
  expect(m.get(id)?.content).toContain("parser cfg");
  expect(m.get(second)?.content).toContain("second fact");
});

test("the lifecycle machine: legal transitions recorded, illegal refused, nothing resurrects", () => {
  const m = memory();
  const id = m.remember({
    scope: "global",
    content: "fact worth keeping",
    evidenceID: "ev:1",
  });
  expect(m.transition(id, "active")).toEqual({ ok: true, status: "active" });
  // A supersede must name a real memory (the chain).
  expect(m.transition(id, "superseded")).toEqual({
    ok: false,
    reason: "superseded requires supersededBy",
  });
  const successor = m.remember({
    scope: "global",
    content: "the newer fact",
    evidenceID: "ev:2",
    status: "active",
  });
  expect(m.transition(id, "superseded", { supersededBy: successor })).toEqual({
    ok: true,
    status: "superseded",
  });
  // A retired entry never comes back.
  expect(m.transition(id, "active")).toEqual({
    ok: false,
    reason: "superseded -> active is not a legal transition",
  });
  expect(m.transition(id, "stale")).toEqual({
    ok: false,
    reason: "superseded -> stale is not a legal transition",
  });
  expect(m.transition("nope", "active")).toEqual({
    ok: false,
    reason: "unknown memory id",
  });
  // The chain is recorded on the row, the transitions in the history.
  expect(m.get(id)?.supersededBy).toBe(successor);
  const actions = m.history(id).map((entry) => entry.action);
  expect(actions).toEqual([
    "remember:draft",
    "draft -> active",
    "active -> superseded",
  ]);
});

test("the recall serves the active set in scope; drafts and retired stay out", () => {
  const m = memory();
  const active = m.remember({
    scope: "workspace:w1",
    content: "active knowledge",
    evidenceID: "ev:1",
    status: "active",
  });
  m.remember({
    scope: "workspace:w1",
    content: "still a draft",
    evidenceID: "ev:2",
  });
  const retired = m.remember({
    scope: "workspace:w1",
    content: "retired knowledge",
    evidenceID: "ev:3",
    status: "active",
  });
  m.transition(retired, "stale");
  const scoped = m.recall({ scope: "workspace:w1" });
  expect(scoped.map((entry) => entry.id)).toEqual([active]);
  // Another workspace's active knowledge does not leak into this scope.
  m.remember({
    scope: "workspace:w2",
    content: "other workspace",
    evidenceID: "ev:4",
    status: "active",
  });
  expect(m.recall({ scope: "workspace:w1" })).toHaveLength(1);
  // includeInactive asks for everything, newest first.
  expect(
    m.recall({ scope: "workspace:w1", includeInactive: true }),
  ).toHaveLength(3);
  // The stats are the store's own observability — WHOLE store, not the
  // scope: w2's active memory counts too.
  expect(m.stats()).toEqual({ draft: 1, active: 2, stale: 1, superseded: 0 });
});

test("one redaction seam runs on write (the study's non-sensitive rule)", () => {
  const m = memory((content) =>
    content.replace(/sk-[a-z0-9]+/giu, "[redacted]"),
  );
  const id = m.remember({
    scope: "global",
    content: "the deploy key is sk-abc123",
    evidenceID: "ev:1",
    status: "active",
  });
  expect(m.get(id)?.content).toBe("the deploy key is [redacted]");
});
