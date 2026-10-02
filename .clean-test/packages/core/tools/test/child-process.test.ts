import { expect, test } from "bun:test";
import { parseProcStatStartTicks } from "../src";

// /proc/<pid>/stat: pid (comm) state ppid pgrp session tty_nr tpgid flags
// minflt cminflt majflt cmajflt utime stime cutime cstime priority nice
// num_threads itrealvalue starttime vsize rss rsslim ...
// starttime is field 22 (index 19 after the closing paren of comm).
const STAT_TAIL =
  " 1 1234 1234 0 -1 4194304 64 0 0 0 100 50 0 0 20 0 1 0 987654 500000 300 0 2 0 0";

test("parseProcStatStartTicks reads field 22 for a plain comm", () => {
  expect(parseProcStatStartTicks(`1234 (bash) S${STAT_TAIL}`)).toBe("987654");
});

test("parseProcStatStartTicks is correct when comm contains a space", () => {
  // A space in comm shifts every whitespace-split field; the parser must still
  // return starttime, not itrealvalue (which a whole-line split would read).
  expect(parseProcStatStartTicks(`1234 (my app) S${STAT_TAIL}`)).toBe("987654");
});

test("parseProcStatStartTicks uses the last closing paren of comm", () => {
  expect(parseProcStatStartTicks(`1234 (a(b)c) S${STAT_TAIL}`)).toBe("987654");
  expect(parseProcStatStartTicks(`1234 (x) (y) S${STAT_TAIL}`)).toBe("987654");
});
