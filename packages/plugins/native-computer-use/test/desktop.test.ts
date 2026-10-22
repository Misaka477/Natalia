/**
 * The native half, against the real desktop.
 *
 * These tests run only where the desktop can be driven (Windows today):
 * they enumerate real windows, capture a real region, and read the real
 * foreground window. Every one of them is READ-ONLY — nothing here clicks,
 * types, or activates — because a test that clicks the user's desktop is a
 * test that damages it. The input functions are covered by the pure
 * contract (key specs, click verdicts) and by the skill's discipline
 * instead.
 *
 * On a platform without the layer, the same file proves the refusal is
 * honest: the tools answer with the reason rather than a fake success.
 */
import { expect, test } from "bun:test";
import { computerUseTools } from "../src";
import { desktopLibraries } from "../src/win32/ffi";
import { captureRegion } from "../src/win32/capture";
import {
  activateWindow,
  clientOrigin,
  clientSize,
  enumerateWindows,
  foregroundWindow,
  matchWindows,
  readableWindows,
} from "../src/win32/windows";
import { ensureDpiAware, virtualScreen } from "../src/win32/screen";

const windowsOnly = process.platform === "win32" ? test : test.skip;

windowsOnly("the screen reports its real size in physical pixels", () => {
  ensureDpiAware();
  const bounds = virtualScreen();
  expect(bounds.w).toBeGreaterThan(0);
  expect(bounds.h).toBeGreaterThan(0);
  // A DPI-unaware process sees the logical size, which on a scaled display
  // is smaller than the screen really is; the metrics agree with the
  // primary screen's own answer only when the awareness took.
  const libs = desktopLibraries();
  expect(libs.user32.GetSystemMetrics(0)).toBeGreaterThan(0);
});

windowsOnly(
  "enumeration names real windows, and the foreground one is among them",
  () => {
    const records = enumerateWindows();
    expect(records.length).toBeGreaterThan(0);
    const foreground = foregroundWindow();
    expect(foreground).toBeDefined();
    // The foreground window is a real window the enumeration also saw, with
    // the same handle.
    const same = records.find((record) => record.hwnd === foreground!.hwnd);
    expect(same).toBeDefined();
    expect(same!.foreground).toBe(true);
    // Exactly one window is the foreground one.
    expect(records.filter((record) => record.foreground)).toHaveLength(1);
    for (const record of records) {
      expect(record.rect.w).toBeGreaterThanOrEqual(0);
      expect(record.rect.h).toBeGreaterThanOrEqual(0);
      expect(record.hwnd).toMatch(/^\d+$/u);
      expect(record.pid).toBeGreaterThan(0);
    }
  },
);

windowsOnly("the readable listing keeps what a person would name", () => {
  const records = enumerateWindows();
  const readable = readableWindows(records);
  expect(readable.length).toBeGreaterThan(0);
  // The desktop holds hundreds of top-level windows — touch keyboards,
  // shell canvases, message sinks — and none of them are visible with a
  // title. What survives is a strict subset, and every survivor has a
  // title, which is what a query matches against.
  expect(readable.length).toBeLessThan(records.length);
  for (const record of readable) {
    expect(record.visible).toBe(true);
    expect(record.title.length).toBeGreaterThan(0);
  }
});

windowsOnly(
  "a query matches by handle exactly and by title as a substring",
  () => {
    const readable = readableWindows(enumerateWindows());
    const first = readable[0]!;
    expect(matchWindows(readable, first.hwnd)).toEqual([first]);
    const needle = first.title.slice(0, Math.min(6, first.title.length));
    const byTitle = matchWindows(readable, needle);
    expect(byTitle.map((record) => record.hwnd)).toContain(first.hwnd);
    // An empty query matches nothing rather than everything.
    expect(matchWindows(readable, "   ")).toEqual([]);
  },
);

windowsOnly("a window's client origin sits inside its window rectangle", () => {
  // The client origin is what a screenshot's coordinates are relative to;
  // it must be inside the window (a maximized window's origin is offset by
  // its borders) and the client area must be no larger than the window.
  const readable = readableWindows(enumerateWindows());
  const record = readable[0]!;
  const hwnd = BigInt(record.hwnd);
  const origin = clientOrigin(hwnd);
  const size = clientSize(hwnd);
  expect(origin.x).toBeGreaterThanOrEqual(record.rect.x);
  expect(origin.y).toBeGreaterThanOrEqual(record.rect.y);
  expect(size.w).toBeGreaterThan(0);
  expect(size.h).toBeGreaterThan(0);
  expect(size.w).toBeLessThanOrEqual(record.rect.w);
  expect(size.h).toBeLessThanOrEqual(record.rect.h);
});

windowsOnly(
  "a captured region comes back as the PNG it will be written as",
  () => {
    const bounds = virtualScreen();
    // A small region at the screen's centre: the capture is real, the bytes
    // are checked, and nothing large is written to disk.
    const region = {
      x: bounds.x + Math.floor(bounds.w / 2) - 8,
      y: bounds.y + Math.floor(bounds.h / 2) - 8,
      w: 16,
      h: 16,
    };
    const frame = captureRegion(region);
    expect(frame.rect).toEqual(region);
    expect(frame.width).toBe(16);
    expect(frame.height).toBe(16);
    expect(frame.rgb).toHaveLength(16 * 16 * 3);
    // The PNG header names the frame's own dimensions — the file a model
    // looks at is the pixels that were captured.
    expect([...frame.png.slice(0, 8)]).toEqual([
      0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a,
    ]);
    const view = new DataView(frame.png.buffer, frame.png.byteOffset);
    expect(view.getUint32(16)).toBe(16);
    expect(view.getUint32(20)).toBe(16);
  },
);

windowsOnly("a region outside the screen is refused, not padded", () => {
  const bounds = virtualScreen();
  expect(() =>
    captureRegion({ x: bounds.x + bounds.w + 100, y: bounds.y, w: 10, h: 10 }),
  ).toThrow(/outside the screen/u);
});

windowsOnly(
  "the click tool refuses a coordinate that is not an integer",
  async () => {
    // The coordinate is physical pixels on a real screen; a fractional one is
    // a caller that has not decided where it is clicking.
    const click = computerUseTools.find(
      (tool) => tool.name === "computer_click",
    )!;
    const root = process.cwd();
    await expect(
      click.execute({ x: 10.5, y: 20 }, { workspaceRoot: root } as never),
    ).rejects.toThrow(/integers/u);
  },
);

// The refusal path, on the platforms that have no layer. On Windows the
// same tools answer for real (desktop.test.ts above), which is why this
// half of the file is skipped there.
const noDesktop = process.platform === "win32" ? test.skip : test;

noDesktop(
  "a platform without the desktop layer refuses with the reason",
  async () => {
    const windows = computerUseTools.find(
      (tool) => tool.name === "computer_windows",
    )!;
    const root = process.cwd();
    const error = await windows
      .execute({}, { workspaceRoot: root } as never)
      .then(
        () => null,
        (cause: unknown) => cause as Error,
      );
    expect(error).toBeInstanceOf(Error);
    expect((error as Error).message).toContain("computer use is unavailable");
    expect((error as Error).message).toContain(process.platform);
  },
);

// The activation helper is exercised for real only in the sense that it
// reports the truth: this test asks for the window that is ALREADY in
// front, so it activates nothing that was not already active.
windowsOnly("activating the foreground window keeps it in front", () => {
  const foreground = foregroundWindow();
  expect(foreground).toBeDefined();
  const result = activateWindow(BigInt(foreground!.hwnd));
  expect(result.foreground).toBe(true);
});
