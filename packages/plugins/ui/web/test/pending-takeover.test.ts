import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * R4(a)(c) + T4-3/T4-4: the pending request's home is the composer, and the
 * side tab is gone.
 *
 * A pending approval/question/interactive is the runtime asking the human
 * something while the agent blocks on the answer, so it belongs where the
 * human types. The card replaces the composer while a request waits (the
 * decision cannot be missed; the input is naturally unavailable), it is
 * non-modal (no backdrop, no focus trap — the transcript stays usable), and
 * dismissing it MINIMIZES to a persistent count rather than vanishing.
 *
 * There is no DOM harness in this repo (no jsdom/happy-dom dependency, and
 * adding one is not this change's business), so the guard is the wiring
 * itself — the same source-level pattern the full-events audit uses — plus
 * the two invariants that cannot be seen in a render: the card never
 * mutates the projection's pending lists, and exactly one plugin owns the
 * presenters.
 */
const root = join(import.meta.dir, "..", "..", "..", "..", "..");

function source(relative: string): string {
  return readFileSync(join(root, relative), "utf8");
}

test("the composer slot is taken by the pending takeover while a request waits", () => {
  const app = source("packages/plugins/ui/web/src/app-neu.tsx");
  // The card is rendered …
  expect(app).toContain("<PendingTakeover");
  // … gated on the pending count, and the composer yields the slot to it …
  expect(app).toMatch(
    /pendingTakeoverCount\(\) > 0 && !pendingTakeoverMinimized\(\)/u,
  );
  // … and comes back when the card is minimized (the strip stays).
  expect(app).toMatch(
    /pendingTakeoverCount\(\) === 0 \|\| pendingTakeoverMinimized\(\)/u,
  );
});

test("the transcript's 处理 button lands on the takeover, not a deleted tab", () => {
  const app = source("packages/plugins/ui/web/src/app-neu.tsx");
  // The button used to open the side tab, which no longer exists.
  expect(app).not.toContain('setRightTab("pending")');
  // It focuses the request and un-minimizes, so it always lands on the card.
  expect(app).toContain("setPendingTakeoverFocus(pendingRequestID)");
  expect(app).toContain("setPendingTakeoverMinimized(false)");
});

test("the takeover card is non-modal and its dismiss only minimizes", () => {
  const card = source(
    "packages/plugins/ui/web/src/components/PendingTakeover.tsx",
  );
  // No modal vocabulary anywhere: no dialog role, no backdrop, no focus trap.
  expect(card).not.toContain('role="dialog"');
  expect(card).not.toContain("aria-modal");
  expect(card).not.toContain("natalia-pending-takeover-backdrop");
  // Dismissing sets the local minimize flag — it never touches the pending
  // lists, so a minimized request is still counted and still answerable.
  expect(card).toContain("onDismiss={() => setMinimized(true)}");
  expect(card).not.toMatch(/pendingApprovals\s*=/u);
  expect(card).not.toMatch(/pendingQuestions\s*=/u);
  expect(card).not.toMatch(/pendingInteractives\s*=/u);
  // And the minimized strip carries the live count, not a stale copy.
  expect(card).toContain("{count()} 个待处理");
});

test("exactly one plugin owns the pending presenters after the tab's removal", () => {
  // Two owners throw in the host ("already owned by another plugin"), so the
  // move has to be total: the web plugin registers, the delisted plugin
  // registers nothing.
  const web = source("packages/plugins/ui/web/src/plugin-neu.tsx");
  expect(web).toContain("ctx.pending.registerPresenter(approvalPresenter)");
  expect(web).toContain("ctx.pending.registerPresenter(questionPresenter)");

  const pending = source("packages/plugins/ui/pending/src/ui/plugin.tsx");
  expect(pending).not.toContain("registerPresenter");
  // … and it contributes no panel either.
  expect(pending).toContain("panels: []");
});

test("the pending inbox is delisted from the official catalog", () => {
  const official = source("packages/tooling/installer/src/official.ts");
  expect(official).not.toContain("natalia-pending-inbox");
});
