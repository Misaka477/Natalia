import { expect, test } from "bun:test";
import {
  HOST_ONLY_SETTING_LABELS,
  hostFromSegments,
  rowsForHost,
  settingAppliesToHost,
} from "../src/settings-host-rows";

const WINDOWS_ONLY = HOST_ONLY_SETTING_LABELS[0]!;
const ALWAYS = "Terminal Window Mode";

test("a host-only row shows on the host that needs it", () => {
  expect(settingAppliesToHost(WINDOWS_ONLY, "win32")).toBe(true);
});

test("a host-only row is hidden on every other host — POSIX needs no setting", () => {
  // The user's rule: Linux and macOS's shell IS bash, so a row that offers
  // to configure it is noise. Hidden, not disabled: a disabled row still
  // reads as "you could set this if you tried".
  for (const host of ["linux", "darwin", "freebsd", "aix"] as const)
    expect(settingAppliesToHost(WINDOWS_ONLY, host)).toBe(false);
});

test("an unknown host is not Windows", () => {
  // A runtime that never published a host (an old journal, a host that
  // does not emit the segment) must not get the row on a guess.
  expect(settingAppliesToHost(WINDOWS_ONLY, undefined)).toBe(false);
  expect(hostFromSegments(undefined)).toBeUndefined();
  expect(hostFromSegments([])).toBeUndefined();
  expect(hostFromSegments(["host:"])).toBeUndefined();
});

test("the host comes out of the runtime's own status segments", () => {
  // The panel cannot use navigator: that describes the browser, and a Linux
  // laptop can drive a Windows host. The segment is the honest source.
  expect(
    hostFromSegments(["mode:runtime", "model:gpt", "host:win32", "bg:0"]),
  ).toBe("win32");
  expect(hostFromSegments(["mode:runtime", "host:linux"])).toBe("linux");
});

test("an ordinary row renders on every host", () => {
  for (const host of ["win32", "linux", "darwin", undefined] as const)
    expect(settingAppliesToHost(ALWAYS, host)).toBe(true);
});

test("the category's rows are filtered, not reordered", () => {
  const items = [
    { label: ALWAYS },
    { label: WINDOWS_ONLY },
    { label: "子 Agent 并发数" },
  ];
  expect(rowsForHost(items, "win32").map((item) => item.label)).toEqual([
    ALWAYS,
    WINDOWS_ONLY,
    "子 Agent 并发数",
  ]);
  expect(rowsForHost(items, "linux").map((item) => item.label)).toEqual([
    ALWAYS,
    "子 Agent 并发数",
  ]);
  // An unknown host keeps the ordinary rows and drops the host-only one.
  expect(rowsForHost(items, undefined).map((item) => item.label)).toEqual([
    ALWAYS,
    "子 Agent 并发数",
  ]);
});
