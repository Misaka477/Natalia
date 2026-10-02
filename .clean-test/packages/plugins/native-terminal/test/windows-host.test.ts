import { expect, test } from "bun:test";
import { win32 } from "node:path";
import {
  monospaceFontFallback,
  nativeTerminalPaneCommand,
  resolveNataliaWezTermForkExecutable,
} from "../src/index";

test("pane command keeps the exact POSIX shell invocation", () => {
  expect(nativeTerminalPaneCommand("interactive-agent", "linux")).toEqual([
    "/bin/sh",
    "-lc",
    "interactive-agent",
  ]);
});

test("pane command uses a bash-compatible shell on Windows", () => {
  const bash = win32.join("C:\\tools", "bash.exe");
  const previous = process.env.NATALIA_BASH_EXECUTABLE;
  process.env.NATALIA_BASH_EXECUTABLE = bash;
  try {
    expect(nativeTerminalPaneCommand("interactive-agent", "win32")).toEqual([
      bash,
      "-lc",
      "interactive-agent",
    ]);
  } finally {
    if (previous === undefined) delete process.env.NATALIA_BASH_EXECUTABLE;
    else process.env.NATALIA_BASH_EXECUTABLE = previous;
  }
});

test("fork executable resolution applies the Windows suffix", () => {
  // An absent build directory proves the probed name rather than a real binary.
  expect(
    resolveNataliaWezTermForkExecutable({
      os: "win32",
      buildDir: "/definitely/missing",
    }),
  ).toBeUndefined();
  expect(
    resolveNataliaWezTermForkExecutable({
      os: "linux",
      buildDir: "/definitely/missing",
    }),
  ).toBeUndefined();
});

test("font fallback keeps the POSIX CJK chain unchanged", () => {
  expect(monospaceFontFallback("linux")).toEqual([
    "JetBrains Mono",
    "Noto Sans Mono CJK SC",
    "Noto Sans CJK SC",
    "Noto Color Emoji",
  ]);
});

test("font fallback offers Windows CJK families", () => {
  const fonts = monospaceFontFallback("win32");
  expect(fonts).toContain("Consolas");
  expect(fonts.some((font) => font.includes("YaHei"))).toBe(true);
  expect(fonts).not.toContain("Noto Sans Mono CJK SC");
});
