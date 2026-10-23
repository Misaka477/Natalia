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
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
import {
  findElements,
  focusedElement,
  releaseElement,
  walkWindowTree,
} from "../src/win32/uia";

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

// The accessibility layer, against the real desktop. Read-only: nothing
// here focuses, invokes or writes.
// A real UIA walk is cross-process: against a busy application it takes
// seconds, not milliseconds. The timeout is the walk's, not a hope.
windowsOnly(
  "the raw accessibility walk sees rendered content",
  () => {
    // The control view sees a window's chrome; the raw view sees what is
    // rendered inside it. Which window is richest varies with what the user
    // has open, so the assertion is over the desktop rather than one window:
    // at least one visible window exposes content a caller could address.
    const readable = readableWindows(enumerateWindows());
    let walked = 0;
    let addressable = 0;
    for (const record of readable.slice(0, 6)) {
      const tree = walkWindowTree(Number(record.hwnd), {
        maxNodes: 400,
        maxDepth: 12,
      });
      walked += tree.length;
      for (const node of tree) {
        expect(typeof node.name).toBe("string");
        expect(node.controlTypeName.length).toBeGreaterThan(0);
        if (node.rect) {
          expect(node.rect.w).toBeGreaterThanOrEqual(0);
          expect(node.rect.h).toBeGreaterThanOrEqual(0);
        }
        if (node.name.length > 0 && (node.rect?.w ?? 0) > 0) addressable += 1;
      }
      if (addressable > 0) break;
    }
    expect(walked).toBeGreaterThan(0);
    // A name and a rectangle together are what make a node addressable.
    expect(addressable).toBeGreaterThan(0);
  },
  60_000,
);

windowsOnly(
  "a rendered input box is findable by name and readable",
  () => {
    // The measurement that decided this design: a webview's input box is an
    // Edit with a NAME, a RECT and a ValuePattern. Find the VS Code window's
    // editor or sidebar edit by name and check the three facts together.
    const readable = readableWindows(enumerateWindows());
    const code = readable.find(
      (record) =>
        record.title.includes("Visual Studio Code") ||
        record.title.includes("Code"),
    );
    if (!code) return; // No editor open: nothing to assert against.
    const tree = walkWindowTree(Number(code.hwnd), {
      maxNodes: 1500,
      maxDepth: 30,
    });
    const edits = tree.filter((node) => node.controlTypeName === "edit");
    for (const edit of edits) {
      expect(edit.name.length).toBeGreaterThan(0);
      // A value pattern means the field's text can be read back — which is
      // what makes `landed` a real answer rather than always null.
      expect(edit.value).toBeDefined();
      expect(edit.valueReadOnly).toBe(false);
      expect(edit.rect).toBeDefined();
      expect(edit.rect!.w).toBeGreaterThan(0);
    }
  },
  60_000,
);

windowsOnly(
  "the focus element answers with a live node",
  () => {
    const focus = focusedElement();
    // Focus may sit on the desktop with nothing meaningful named; what must
    // hold is that the call answers at all, with a typed node.
    if (focus) {
      expect(focus.controlTypeName.length).toBeGreaterThan(0);
      expect(typeof focus.name).toBe("string");
    }
  },
  30_000,
);

windowsOnly(
  "a search keeps its matches and gives the rest back",
  () => {
    // findElements keeps each match's interface for a caller that writes
    // through it. The contract worth pinning: the matches are readable, and
    // releasing them afterwards does not disturb the layer (a second search
    // still works — a use-after-free would crash here rather than there).
    const readable = readableWindows(enumerateWindows());
    const target = readable[0]!;
    const first = findElements(Number(target.hwnd), target.title.slice(0, 8), {
      maxNodes: 400,
      maxDepth: 12,
    });
    for (const match of first) {
      expect(match.name.length).toBeGreaterThan(0);
      expect(match.pointer).toBeGreaterThan(0);
    }
    for (const match of first) releaseElement(match);
    // A second search after the releases: the layer is still alive.
    const second = findElements(Number(target.hwnd), target.title.slice(0, 8), {
      maxNodes: 400,
      maxDepth: 12,
    });
    expect(second.length).toBe(first.length);
    for (const match of second) releaseElement(match);
  },
  60_000,
);

windowsOnly(
  "the accessibility layer opens lazily, never at import",
  async () => {
    // A module-level dlopen is a load-time crash on every platform without
    // these libraries. Measured: the Linux artifacts job died bundling this
    // file on `Failed to open library "ole32.dll"`, which took the whole
    // distribution build — and the runtime's tool set — with it. The module
    // must import cleanly and answer at call time instead.
    const mod = await import("../src/win32/uia");
    expect(mod.uiaAvailable()).toBe(true);
    // And a real walk still works through the lazy open: the refactor must
    // not have cost the capability.
    const readable = readableWindows(enumerateWindows());
    const target = readable[0]!;
    const tree = mod.walkWindowTree(Number(target.hwnd), {
      maxNodes: 64,
      maxDepth: 8,
    });
    expect(Array.isArray(tree)).toBe(true);
  },
  60_000,
);

windowsOnly(
  "a screenshot with no path lands in the OS temporary directory",
  async () => {
    // The default used to be "write into the workspace", which litters the
    // project a model was asked to look at. A capture is evidence: it lands
    // in temp unless a path names somewhere the image should stay.
    const screenshot = computerUseTools.find(
      (tool) => tool.name === "computer_screenshot",
    )!;
    const result = await screenshot.execute({}, {
      workspaceRoot: process.cwd(),
    } as never);
    const answer = JSON.parse(String(result)) as {
      path: string;
      location?: string;
      width: number;
      height: number;
    };
    expect(answer.location).toBe("os-temp");
    expect(answer.path.startsWith(tmpdir())).toBe(true);
    expect(existsSync(answer.path)).toBe(true);
    expect(answer.width).toBeGreaterThan(0);
    expect(answer.height).toBeGreaterThan(0);
    // The PNG on disk is the frame that was captured, not a promise.
    const bytes = await readFile(answer.path);
    expect([...bytes.slice(0, 4)]).toEqual([0x89, 0x50, 0x4e, 0x47]);
    await rm(answer.path, { force: true });
  },
);

windowsOnly(
  "a screenshot with a path still lands in the workspace",
  async () => {
    const screenshot = computerUseTools.find(
      (tool) => tool.name === "computer_screenshot",
    )!;
    const root = await mkdtemp(join(tmpdir(), "natalia-shot-path-"));
    try {
      const result = await screenshot.execute({ path: "shots/probe.png" }, {
        workspaceRoot: root,
      } as never);
      const answer = JSON.parse(String(result)) as {
        path: string;
        workspacePath?: string;
      };
      // node:path relative is platform-spelled: forward on POSIX, backslash on\n  // Windows. The assertion is about WHERE it landed, not about the separator.\n  expect(answer.workspacePath?.replaceAll("\\\\", "/")).toBe("shots/probe.png");
      expect(existsSync(join(root, "shots", "probe.png"))).toBe(true);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  },
);

windowsOnly(
  "a fill that cannot locate its target stops at phase one",
  async () => {
    // The contract that matters most: a failure names the phase and what it
    // saw, so "no such field" is never confused with "the field would not
    // take the text" or "the target was busy". And it stops — no phases run
    // after the one that failed.
    const fill = computerUseTools.find(
      (tool) => tool.name === "computer_fill",
    )!;
    const result = await fill.execute(
      {
        target: "一个绝对不存在的控件名 12345",
        value: "hello",
        submit: "none",
      },
      { workspaceRoot: process.cwd() } as never,
    );
    const answer = JSON.parse(String(result)) as {
      ok: boolean;
      abortedAt: number;
      phases: Array<{ phase: string; ok: boolean }>;
    };
    expect(answer.ok).toBe(false);
    expect(answer.abortedAt).toBe(1);
    expect(answer.phases).toHaveLength(1);
    expect(answer.phases[0]).toMatchObject({ phase: "locate", ok: false });
  },
);

windowsOnly(
  "an atomic gesture reports each step and stops at the first failure",
  async () => {
    // Fail-fast is the whole point of the sequence: a batch that continues
    // after a failed step is faster at causing damage, not more convenient.
    const action = computerUseTools.find(
      (tool) => tool.name === "computer_action",
    )!;
    const ok = await action.execute(
      {
        steps: [
          { op: "move", x: 10, y: 10 },
          { op: "wait", ms: 10 },
        ],
      },
      { workspaceRoot: process.cwd() } as never,
    );
    expect(JSON.parse(String(ok))).toMatchObject({ ok: true });

    // An unknown op is a failure, and the sequence stops there.
    const stopped = await action.execute(
      {
        steps: [
          { op: "move", x: 10, y: 10 },
          { op: "nonsense" },
          { op: "move", x: 20, y: 20 },
        ],
      },
      { workspaceRoot: process.cwd() } as never,
    );
    const answer = JSON.parse(String(stopped)) as {
      ok: boolean;
      abortedAt: number;
      steps: Array<{ op: string; ok: boolean }>;
    };
    expect(answer.ok).toBe(false);
    expect(answer.abortedAt).toBe(2);
    expect(answer.steps).toHaveLength(2);
    expect(answer.steps[1]).toMatchObject({ op: "nonsense", ok: false });
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
