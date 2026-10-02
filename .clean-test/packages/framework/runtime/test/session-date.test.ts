import { expect, test } from "bun:test";
import {
  appendDateRollover,
  calendarDate,
  dateRolledOver,
  dateRolloverContent,
  dateRolloverEntryID,
  today,
} from "../src/session-date";

test("a date renders as YYYY-MM-DD with zero padding", () => {
  // Without padding the string sorts wrong and reads oddly next to other dates.
  expect(calendarDate(new Date(2026, 0, 5))).toBe("2026-01-05");
  expect(calendarDate(new Date(2026, 11, 31))).toBe("2026-12-31");
});

test("the date is local, because that is what today means to the user", () => {
  // 2026-09-20 07:00 in UTC+8 is still 2026-09-19 in UTC, and a user at that
  // hour means the 20th.
  const at = new Date(2026, 8, 20, 7, 0, 0);
  expect(calendarDate(at)).toBe("2026-09-20");
});

test("today reads the injectable clock", () => {
  expect(today(() => new Date(2026, 8, 19))).toBe("2026-09-19");
});

test("no rollover while the recorded date is today's", () => {
  expect(dateRolledOver("2026-09-19", "2026-09-19")).toBe(false);
});

test("a rollover needs a recorded date to move away from", () => {
  // A session whose date was never recorded has nothing to contradict, so
  // appending a notice would claim a change that was never observed.
  expect(dateRolledOver(undefined, "2026-09-20")).toBe(false);
});

test("a rollover is detected when the recorded date is behind", () => {
  expect(dateRolledOver("2026-09-19", "2026-09-20")).toBe(true);
});

test("the rollover notice names both dates", () => {
  // "The date changed" alone leaves the model to guess the direction.
  const content = dateRolloverContent("2026-09-19", "2026-09-20");
  expect(content).toContain("from 2026-09-19 to 2026-09-20");
  expect(content).toContain('source="date_rollover"');
  expect(content).toContain('trust="runtime"');
});

test("the entry id is stable per session and date, so it cannot duplicate", () => {
  expect(dateRolloverEntryID("s1", "2026-09-20")).toBe("date:s1:2026-09-20");
  expect(dateRolloverEntryID("s1", "2026-09-20")).toBe(
    dateRolloverEntryID("s1", "2026-09-20"),
  );
  expect(dateRolloverEntryID("s1", "2026-09-21")).not.toBe(
    dateRolloverEntryID("s1", "2026-09-20"),
  );
});

/** A ledger surface for the rollover tests. */
function fakeLedger() {
  const entries: Array<{
    id: string;
    role: string;
    content: string;
  }> = [];
  return {
    entries,
    snapshot: () => ({
      entries: entries as ReadonlyArray<{ id: string }>,
    }),
    add: (entry: { id: string; role: string; content: string }) => {
      entries.push(entry);
    },
  };
}

test("no notice while the recorded date is today's", () => {
  const ledger = fakeLedger();
  expect(
    appendDateRollover({
      ledger,
      sessionID: "s1",
      recorded: "2026-09-20",
      todayDate: "2026-09-20",
    }),
  ).toBe("unchanged");
  expect(ledger.entries).toHaveLength(0);
});

test("a rollover appends exactly one notice, and nothing is rewritten", () => {
  const ledger = fakeLedger();
  ledger.add({ id: "u1", role: "user", content: "earlier work" });

  const outcome = appendDateRollover({
    ledger,
    sessionID: "s1",
    recorded: "2026-09-19",
    todayDate: "2026-09-20",
  });

  expect(outcome).toBe("appended");
  // The earlier entry is untouched: a rollover appends, it never rewrites.
  expect(ledger.entries[0]).toEqual({
    id: "u1",
    role: "user",
    content: "earlier work",
  });
  const notice = ledger.entries[1]!;
  expect(notice.role).toBe("dynamic");
  expect(notice.id).toBe("date:s1:2026-09-20");
  expect(notice.content).toContain("from 2026-09-19 to 2026-09-20");
});

test("the notice is not appended twice for the same date", () => {
  // The entry id is stable per date, so a session that crosses midnight and then
  // takes another turn does not gain a second notice.
  const ledger = fakeLedger();
  for (let turn = 0; turn < 3; turn += 1)
    appendDateRollover({
      ledger,
      sessionID: "s1",
      recorded: "2026-09-19",
      todayDate: "2026-09-20",
    });

  expect(ledger.entries).toHaveLength(1);
});

test("each date crossing appends its own notice", () => {
  const ledger = fakeLedger();
  const input = (recorded: string, todayDate: string) => ({
    ledger,
    sessionID: "s1",
    recorded,
    todayDate,
  });

  expect(appendDateRollover(input("2026-09-19", "2026-09-20"))).toBe(
    "appended",
  );
  expect(appendDateRollover(input("2026-09-20", "2026-09-21"))).toBe(
    "appended",
  );

  expect(ledger.entries.map((e) => e.id)).toEqual([
    "date:s1:2026-09-20",
    "date:s1:2026-09-21",
  ]);
});

test("a session with no recorded date gains no notice", () => {
  // There is nothing to contradict, so claiming a change never observed would be
  // inventing context.
  const ledger = fakeLedger();
  expect(
    appendDateRollover({
      ledger,
      sessionID: "s1",
      recorded: undefined,
      todayDate: "2026-09-20",
    }),
  ).toBe("unchanged");
  expect(ledger.entries).toHaveLength(0);
});
