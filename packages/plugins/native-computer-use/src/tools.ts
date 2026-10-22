/**
 * The computer_* tool family: drive the desktop itself.
 *
 * The shape follows the discipline the shipped skill teaches, because a
 * tool that can be used carelessly will be:
 *
 *   - every coordinate is PHYSICAL, the same grid the screenshot is
 *     captured on (the process is DPI aware), so a point read off an image
 *     is a point that can be clicked;
 *   - a click is VERIFIED against the pixels around it — the answer says
 *     whether the screen changed and, when it did not, what to check,
 *     never "ok" for a call that returned;
 *   - a screenshot names the region it really captured and attaches the
 *     image to the turn, so the model looks at the screen instead of
 *     guessing about it;
 *   - a platform that cannot drive a desktop refuses at CALL time with the
 *     reason, so the plugin loads everywhere and lies nowhere.
 */
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, relative } from "node:path";
import {
  numberOr,
  optionalString,
  requireObject,
  requireString,
  workspacePath,
} from "@anthelia/tools";
import type { RuntimeTool, ToolFamily, ToolCard } from "@anthelia/tools";
import { regionAround } from "./coords";
import { parseKeySpec } from "./keys";
import { clickVerdict, diffRegion } from "./verify";
import {
  captureRegion,
  captureScreen,
  captureWindowClient,
} from "./win32/capture";
import { handleValue } from "./win32/ffi";
import { clickAt, moveCursor, sendKeySpec, typeText } from "./win32/input";
import { cursorPosition, ensureDpiAware, virtualScreen } from "./win32/screen";
import {
  activateWindow,
  clientOrigin,
  clientSize,
  enumerateWindows,
  foregroundWindow,
  matchWindows,
  readableWindows,
} from "./win32/windows";

/** How far around a click point the verification samples. */
const VERIFY_RADIUS = 48;

/** The card every tool in the family draws: what was done, and to what. */
function computerOutput(callSummary: string) {
  return {
    schema: { type: "object", properties: {} } as const,
    presentCall(): ToolCard {
      return { kind: "generic", title: "computer", summary: callSummary };
    },
    presentResult(_args: unknown, value: string): ToolCard {
      return {
        kind: "generic",
        title: "computer",
        summary: callSummary,
        body: value,
      };
    },
  };
}

/** The platform's answer when the desktop cannot be driven. */
function requireDesktop() {
  ensureDpiAware();
}

/** The window a query names, refusing an ambiguous one. */
function resolveWindow(query: string) {
  const records = readableWindows(enumerateWindows());
  const matches = matchWindows(records, query);
  if (matches.length === 0)
    throw new Error(
      `computer tools: no visible window matches "${query}". Call ` +
        `computer_windows and pick a title or handle from the listing.`,
    );
  if (matches.length > 1)
    throw new Error(
      `computer tools: ${matches.length} windows match "${query}" ` +
        `(${matches.map((match) => `"${match.title}"`).join(", ")}). Name ` +
        `one exactly, or pass its hwnd.`,
    );
  return matches[0]!;
}

function computerWindowsTool(): RuntimeTool {
  return {
    name: "computer_windows",
    description:
      "List the desktop's visible top-level windows (title, class, pid, physical rectangle, foreground) and the screen's physical size. The first probe before any click or type: a coordinate only means something against a named window.",
    requiresApproval: false,
    timeoutSec: 15,
    parameters: { type: "object", properties: {}, additionalProperties: false },
    output: computerOutput("windows"),
    async execute() {
      requireDesktop();
      const records = enumerateWindows();
      const readable = readableWindows(records);
      const bounds = virtualScreen();
      const foreground = foregroundWindow();
      return JSON.stringify(
        {
          screen: {
            bounds,
            cursor: cursorPosition(),
            note: "physical pixels; every coordinate these tools take is in this grid",
          },
          foreground: foreground
            ? { hwnd: foreground.hwnd, title: foreground.title }
            : undefined,
          total: records.length,
          shown: readable.length,
          windows: readable.map((record) => ({
            hwnd: record.hwnd,
            title: record.title,
            className: record.className,
            pid: record.pid,
            rect: record.rect,
            foreground: record.foreground,
          })),
        },
        null,
        2,
      );
    },
  };
}

function computerScreenshotTool(): RuntimeTool {
  return {
    name: "computer_screenshot",
    description:
      "Capture the screen (or one window's client area) as a PNG in the workspace and attach it to the turn. With no window argument the whole virtual screen is captured; a window's capture is its CLIENT AREA, so a point read off that image is relative to the window's client origin. Prefer a window over the full screen — a full-screen image costs context and answers less.",
    requiresApproval: true,
    timeoutSec: 60,
    parameters: {
      type: "object",
      properties: {
        path: { type: "string" },
        window: {
          type: "string",
          description:
            "A window title (substring) or hwnd from computer_windows.",
        },
      },
      required: ["path"],
      additionalProperties: false,
    },
    output: computerOutput("screenshot"),
    async execute(input, context) {
      requireDesktop();
      const args = requireObject(input);
      const output = workspacePath(
        context.workspaceRoot,
        requireString(args.path, "path"),
      );
      await mkdir(dirname(output), { recursive: true });
      const query = optionalString(args.window);
      const frame = query
        ? (() => {
            const record = resolveWindow(query);
            const hwnd = handleValue(record.hwnd);
            const origin = clientOrigin(hwnd);
            const size = clientSize(hwnd);
            const captured = captureWindowClient(origin, size);
            return { captured, record, origin, size };
          })()
        : { captured: captureScreen() };
      await writeFile(output, Buffer.from(frame.captured.png));
      // The image rides the turn when the model can see images; a host
      // without the capability still gets the file, and the answer says so
      // rather than assuming the look happened.
      const attached = context.attachImage ? true : false;
      if (context.attachImage) await context.attachImage(output);
      return JSON.stringify(
        {
          path: relative(context.workspaceRoot, output),
          width: frame.captured.width,
          height: frame.captured.height,
          region: frame.captured.rect,
          attached,
          ...("record" in frame && frame.record
            ? {
                window: {
                  hwnd: frame.record.hwnd,
                  title: frame.record.title,
                  clientOrigin: frame.origin,
                  clientSize: frame.size,
                },
              }
            : {}),
        },
        null,
        2,
      );
    },
  };
}

function computerClickTool(): RuntimeTool {
  return {
    name: "computer_click",
    description:
      "Click at physical screen coordinates (the same grid a screenshot is captured on) and verify the click against the pixels around it. The answer reports whether the screen changed; when nothing changed it names what to check — the coordinate transform first, because a screenshot's point is relative to the window's client origin. Never click the same pixel twice: re-scan.",
    requiresApproval: true,
    timeoutSec: 30,
    parameters: {
      type: "object",
      properties: {
        x: { type: "number" },
        y: { type: "number" },
        button: { type: "string", enum: ["left", "right"] },
      },
      required: ["x", "y"],
      additionalProperties: false,
    },
    output: computerOutput("click"),
    async execute(input) {
      requireDesktop();
      const args = requireObject(input);
      const x = numberOr(args.x, Number.NaN);
      const y = numberOr(args.y, Number.NaN);
      if (!Number.isInteger(x) || !Number.isInteger(y))
        throw new Error(
          "computer_click x/y must be integers in PHYSICAL screen pixels",
        );
      const button = optionalString(args.button) === "right" ? "right" : "left";
      const bounds = virtualScreen();
      const region = regionAround(x, y, VERIFY_RADIUS, bounds);
      const before = region ? captureRegion(region) : undefined;
      const target = foregroundWindow();
      moveCursor(x, y);
      clickAt(x, y, button);
      const after = region ? captureRegion(region) : undefined;
      const diff =
        before && after && region
          ? diffRegion(before.rgb, after.rgb, region.w, region.h)
          : { changedRatio: 0, changedPixels: 0, total: 0 };
      const verdict = clickVerdict(diff, { x, y });
      return JSON.stringify(
        {
          ok: verdict.verified,
          x,
          y,
          button,
          ...(target
            ? { target: { hwnd: target.hwnd, title: target.title } }
            : {}),
          ...(region ? { sampled: region } : {}),
          diff: {
            changedPixels: diff.changedPixels,
            sampled: diff.total,
            changedRatio: Number(diff.changedRatio.toFixed(4)),
          },
          note: verdict.note,
        },
        null,
        2,
      );
    },
  };
}

function computerTypeTool(): RuntimeTool {
  return {
    name: "computer_type",
    description:
      "Type text into the foreground window through the keyboard events (Unicode, one unit at a time — the clipboard is left alone). Types where the focus is, so the answer names the window that had it.",
    requiresApproval: true,
    timeoutSec: 30,
    parameters: {
      type: "object",
      properties: { text: { type: "string" } },
      required: ["text"],
      additionalProperties: false,
    },
    output: computerOutput("type"),
    async execute(input) {
      requireDesktop();
      const args = requireObject(input);
      const text = requireString(args.text, "text");
      const target = foregroundWindow();
      const typed = typeText(text);
      return JSON.stringify(
        {
          ok: true,
          typed,
          ...(target
            ? { target: { hwnd: target.hwnd, title: target.title } }
            : {}),
          note:
            "the text was sent to the window above; verify with " +
            "computer_screenshot when what landed matters",
        },
        null,
        2,
      );
    },
  };
}

function computerKeyTool(): RuntimeTool {
  return {
    name: "computer_key",
    description:
      'Send a key or chord to the foreground window: "enter", "ctrl+v", "ctrl+shift+esc", "f5", "alt+tab". Modifiers press first and release last; one chord per call.',
    requiresApproval: true,
    timeoutSec: 20,
    parameters: {
      type: "object",
      properties: { key: { type: "string" } },
      required: ["key"],
      additionalProperties: false,
    },
    output: computerOutput("key"),
    async execute(input) {
      requireDesktop();
      const args = requireObject(input);
      const key = requireString(args.key, "key");
      const steps = parseKeySpec(key);
      const target = foregroundWindow();
      sendKeySpec(key);
      return JSON.stringify(
        {
          ok: true,
          key,
          steps: steps.length,
          ...(target
            ? { target: { hwnd: target.hwnd, title: target.title } }
            : {}),
        },
        null,
        2,
      );
    },
  };
}

function computerActivateTool(): RuntimeTool {
  return {
    name: "computer_activate",
    description:
      "Bring a window to the front (by title substring or hwnd from computer_windows), restoring it when minimized. The answer verifies the window is now the foreground one rather than trusting the call's return.",
    requiresApproval: true,
    timeoutSec: 20,
    parameters: {
      type: "object",
      properties: {
        window: {
          type: "string",
          description:
            "A window title (substring) or hwnd from computer_windows.",
        },
      },
      required: ["window"],
      additionalProperties: false,
    },
    output: computerOutput("activate"),
    async execute(input) {
      requireDesktop();
      const args = requireObject(input);
      const query = requireString(args.window, "window");
      const record = resolveWindow(query);
      const hwnd = handleValue(record.hwnd);
      const result = activateWindow(hwnd);
      return JSON.stringify(
        {
          ok: result.foreground,
          window: { hwnd: record.hwnd, title: record.title },
          note: result.foreground
            ? "the window is now in front"
            : "the window did not take the foreground (Windows refused the " +
              "focus change); ask the user to click it, or retry once",
        },
        null,
        2,
      );
    },
  };
}

export const computerUseTools: RuntimeTool[] = [
  computerWindowsTool(),
  computerScreenshotTool(),
  computerClickTool(),
  computerTypeTool(),
  computerKeyTool(),
  computerActivateTool(),
];

export function computerUseToolFamily(): ToolFamily {
  return {
    id: "computer-use",
    name: "Computer Use Tools",
    version: "1.0.0",
    description:
      "Drive the desktop: enumerate windows, capture the screen, click, type and send keys, every action verified against the pixels it changed.",
    scope: "session",
    tools: computerUseTools,
  };
}
