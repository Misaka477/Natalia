/**
 * The provider-negotiation seam reports to the log and carries the turn
 * (audit 缺口 3/4).
 *
 * When an agent's model cannot be resolved — no model named, or the model's
 * provider not configured — the turn keeps serving the previous provider. That
 * decision used to be visible only as a session-scoped diagnostic with no
 * subject, and never in the operations log: a turn quietly running on a
 * different provider than the one asked for, invisible to anyone reading the
 * log.
 *
 * The pin reads the source: two branches in `provider-selection.ts`, each of
 * which must write the warning record and put the turn on the diagnostic. A
 * live harness would need a config whose agent names an unconfigured model,
 * which is much larger than the invariant; the record itself is proved by the
 * operation-records surface in `drain-for-update.test.ts` (same call shape).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, test } from "bun:test";

const source = readFileSync(
  join(import.meta.dir, "..", "src", "runtime", "provider-selection.ts"),
  "utf8",
);

describe("an unavailable model override reports where it stopped", () => {
  test("the file still has the two negotiation branches", () => {
    expect((source.match(/model override is unavailable/gu) ?? []).length).toBe(
      2,
    );
  });

  test("both write the operation-log record", () => {
    expect(
      (source.match(/logOf\(ctx\.state\.serviceDirectory\)\.warn\(/gu) ?? [])
        .length,
    ).toBe(2);
  });

  test("both put the turn on the diagnostic AND on the record", () => {
    // Four carriers: two diagnostics, two log records. A spine that exists for
    // one branch — or for the event stream but not the log — is half a spine.
    expect(
      (
        source.match(
          /\.\.\.\(exec\?\.activeTurnID \? \{ turnID: exec\.activeTurnID \} : \{\}\)/gu,
        ) ?? []
      ).length,
    ).toBe(4);
  });
});
