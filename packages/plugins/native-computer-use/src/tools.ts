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
import { dirname, join, relative } from "node:path";
import { tmpdir } from "node:os";
import {
  numberOr,
  optionalString,
  requireObject,
  requireString,
  workspacePath,
} from "@anthelia/tools";
import type { RuntimeTool, ToolFamily, ToolCard } from "@anthelia/tools";
import { centerOf, regionAround } from "./coords";
import { parseKeySpec } from "./keys";
import {
  buildState,
  type DesktopState,
  type StateOptions,
} from "./state-policy";
import { clickVerdict, diffRegion } from "./verify";
import {
  captureRegion,
  captureScreen,
  captureWindowClient,
} from "./win32/capture";
import { handleValue } from "./win32/ffi";
import {
  clickAt,
  mouseDown,
  mouseUp,
  moveCursor,
  sendKeySpec,
  typeText,
} from "./win32/input";
import { cursorPosition, ensureDpiAware, virtualScreen } from "./win32/screen";
import {
  findElements,
  focusedElement,
  releaseElement,
  setElementValue,
  uiaAvailable,
  walkWindowTree,
  type UiaElement,
  type UiaRect,
} from "./win32/uia";
import {
  activateWindow,
  clientOrigin,
  clientSize,
  enumerateWindows,
  foregroundWindow,
  matchWindows,
  readableWindows,
} from "./win32/windows";
import type { WindowRecord } from "./win32/windows";

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

/**
 * The platform's answer when the desktop cannot be driven.
 *
 * Every tool calls this first, so a platform without the Windows input and
 * capture layer refuses here — with the reason — instead of failing deeper
 * in, where the same condition reads as a crash in a specific tool.
 */
function requireDesktop() {
  ensureDpiAware();
}

/**
 * The accessibility layer's answer when it cannot be read.
 *
 * `computer_state`, `computer_find` and `computer_fill` read the tree;
 * `computer_screenshot` + coordinates remain for content the tree does not
 * cover, so the refusal names that path rather than only what is missing.
 */
function requireAccessibility() {
  if (!uiaAvailable())
    throw new Error(
      "the accessibility layer (UI Automation) is unavailable on this " +
        "platform, so computer_state / computer_find / computer_fill cannot " +
        "read the screen's controls. Use computer_windows for geometry and " +
        "computer_screenshot + computer_click for content the tree does not " +
        "cover.",
    );
}

/** The window a query names, refusing an ambiguous one. */
/**
 * The foreground window as a readable record, or a refusal naming why not.
 *
 * A session with no foreground window (a locked screen, a service context)
 * gets an answer that says so, rather than a crash or a silently empty
 * state object.
 */
function requireForegroundRecord(): WindowRecord {
  const record = foregroundWindow();
  if (!record)
    throw new Error(
      "no foreground window: the desktop has nothing in front (locked " +
        "screen, or a session without a desktop) — pass an explicit window",
    );
  return record;
}
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
      "Capture the screen (or one window's client area) as a PNG and attach it to the turn. With no window argument the whole virtual screen is captured; a window's capture is its CLIENT AREA, so a point read off that image is relative to the window's client origin. Prefer a window over the full screen — a full-screen image costs context and answers less. The file lands in the OS temporary directory unless `path` names somewhere else: a screenshot is evidence, not a workspace artifact, and a tool that litters the user's project to answer a question is a tool that gets disabled.",
    requiresApproval: true,
    timeoutSec: 60,
    parameters: {
      type: "object",
      properties: {
        path: {
          type: "string",
          description:
            "Optional. Where to write the PNG. Omitted (the default) puts it in the OS temporary directory; pass a workspace-relative path only when the image should stay with the project.",
        },
        window: {
          type: "string",
          description:
            "A window title (substring) or hwnd from computer_windows.",
        },
      },
      additionalProperties: false,
    },
    output: computerOutput("screenshot"),
    async execute(input, context) {
      requireDesktop();
      const args = requireObject(input);
      // The capture is evidence, not a project artifact: with no path it
      // lands in the OS temporary directory, and the answer says where it
      // went. A screenshot written into the user's workspace by default is
      // a tool that litters the repo it was asked to look at.
      const requested = optionalString(args.path);
      const output = requested
        ? workspacePath(context.workspaceRoot, requested)
        : join(
            tmpdir(),
            `natalia-computer-${Date.now().toString(36)}-${process.pid.toString(36)}.png`,
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
          path: output,
          ...(requested
            ? { workspacePath: relative(context.workspaceRoot, output) }
            : { location: "os-temp" }),
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

/**
 * The last state read per window, so `computer_state` can answer "what
 * changed" without the model holding two images side by side.
 *
 * Keyed by window handle. The map is per process, which is the lifetime of
 * a session; a window that closes simply stops being asked about.
 */
const stateHistory = new Map<string, DesktopState>();

/** Read one window's accessibility tree and fold it into a state object. */
function readState(
  record: WindowRecord,
  options: StateOptions & { maxNodes?: number; maxDepth?: number },
): DesktopState {
  requireAccessibility();
  const nodes = walkWindowTree(handleValue(record.hwnd), {
    maxNodes: options.maxNodes ?? 2000,
    maxDepth: options.maxDepth ?? 32,
  });
  const hwnd = handleValue(record.hwnd);
  const origin = clientOrigin(hwnd);
  const size = clientSize(hwnd);
  return buildState({
    window: {
      hwnd: record.hwnd,
      title: record.title,
      foreground: record.foreground,
      clientOrigin: origin,
      clientSize: size,
    },
    nodes,
    options,
  });
}

function computerStateTool(): RuntimeTool {
  return {
    name: "computer_state",
    description:
      "Read one window as a compact state object: its addressable controls (name, type, value, rect), where the focus is, its visible text (pageable), and WHAT CHANGED since the previous read. This is the main read interface — prefer it over computer_screenshot, because one call answers what is here, where the focus is, and whether the last action landed. Coordinates in `rect` are PHYSICAL screen pixels; a point read off a window's SCREENSHOT is relative to that window's clientOrigin, which the answer carries.",
    requiresApproval: false,
    timeoutSec: 30,
    parameters: {
      type: "object",
      properties: {
        window: {
          type: "string",
          description:
            "A window title (substring) or hwnd from computer_windows. Omitted reads the foreground window.",
        },
        maxControls: { type: "number" },
        maxText: { type: "number" },
        textOffset: { type: "number" },
      },
      additionalProperties: false,
    },
    output: computerOutput("state"),
    async execute(input) {
      requireDesktop();
      const args = requireObject(input);
      const query = optionalString(args.window);
      const record = query ? resolveWindow(query) : requireForegroundRecord();
      const options: StateOptions = {
        ...(numberOr(args.maxControls, 40) === 40
          ? {}
          : { maxControls: numberOr(args.maxControls, 40) }),
        ...(numberOr(args.maxText, 4000) === 4000
          ? {}
          : { maxText: numberOr(args.maxText, 4000) }),
        ...(numberOr(args.textOffset, 0) === 0
          ? {}
          : { textOffset: numberOr(args.textOffset, 0) }),
      };
      const previous = stateHistory.get(record.hwnd);
      const state = readState(record, { ...options, previous });
      stateHistory.set(record.hwnd, state);
      return JSON.stringify(state, null, 2);
    },
  };
}

function computerFindTool(): RuntimeTool {
  return {
    name: "computer_find",
    description:
      "Find controls by name inside a window, each match carrying its rect, value and whether it is writable — addressing and coordinates in one answer, with no separate locate step. `via` names the layer that answered (uia today), because the layers have different reach and a caller should know which one it is trusting.",
    requiresApproval: false,
    timeoutSec: 30,
    parameters: {
      type: "object",
      properties: {
        query: { type: "string" },
        window: {
          type: "string",
          description:
            "A window title (substring) or hwnd from computer_windows. Omitted searches the foreground window.",
        },
      },
      required: ["query"],
      additionalProperties: false,
    },
    output: computerOutput("find"),
    async execute(input) {
      requireDesktop();
      const args = requireObject(input);
      const query = requireString(args.query, "query");
      const windowQuery = optionalString(args.window);
      const record = windowQuery
        ? resolveWindow(windowQuery)
        : requireForegroundRecord();
      requireAccessibility();
      const matches = findElements(handleValue(record.hwnd), query, {
        maxNodes: 2000,
        maxDepth: 32,
      });
      return JSON.stringify(
        {
          via: "uia",
          window: { hwnd: record.hwnd, title: record.title },
          count: matches.length,
          ambiguous: matches.length > 1,
          matches: matches.map((match) => ({
            name: match.name,
            type: match.controlTypeName,
            ...(match.value === undefined ? {} : { value: match.value }),
            ...(match.valueReadOnly === undefined
              ? {}
              : { writable: !match.valueReadOnly }),
            enabled: match.enabled,
            ...(match.rect ? { rect: match.rect } : {}),
          })),
          note:
            matches.length > 1
              ? "several controls match; name one exactly (or pass its rect to computer_click) — the choice is yours, not the tool's"
              : undefined,
        },
        null,
        2,
      );
    },
  };
}

export const computerUseTools: RuntimeTool[] = [
  computerWindowsTool(),
  computerStateTool(),
  computerFindTool(),
  computerScreenshotTool(),
  computerClickTool(),
  computerFillTool(),
  computerTypeTool(),
  computerKeyTool(),
  computerActivateTool(),
  computerWaitTool(),
  computerActionTool(),
];

/**
 * One phase of a fill.
 *
 * The whole point of the shape: when a fill fails, the answer says WHICH
 * phase died and what it saw, because "typed into a field" and "the field
 * would not accept the text" and "the target was busy" are three different
 * problems, and one `ok: false` is the same as no report at all.
 */
type FillPhase =
  | { phase: "locate"; ok: boolean; via: string; name?: string; rect?: UiaRect }
  | { phase: "focus"; ok: boolean; focusAfter?: string }
  | { phase: "clear"; ok: boolean; valueBefore?: string }
  | {
      phase: "type";
      ok: boolean;
      dispatched: string;
      /** What the field actually holds afterwards. null when unreadable. */
      landed: string | null;
      matched: boolean;
    }
  | {
      phase: "submit";
      ok: boolean;
      attempts: string[];
      fieldCleared: boolean;
      reason?: string;
    }
  | { phase: "confirm"; ok: boolean; statusAfter?: string };

function computerFillTool(): RuntimeTool {
  return {
    name: "computer_fill",
    description:
      "Fill a field and submit it, as ONE verified operation: locate by name or coordinates, focus, clear, write (the value pattern's atomic write when the field is writable, keystrokes otherwise), read the value BACK and compare it to what was sent, then submit through the known ladder (Enter, then a send button by name) and confirm. Every phase reports itself, and a failure names the phase and what it saw — a field that did not accept the text and a target that was busy are different problems.",
    requiresApproval: true,
    timeoutSec: 60,
    parameters: {
      type: "object",
      properties: {
        target: {
          type: "string",
          description: "A control name (substring) or hwnd:rect coordinates.",
        },
        window: {
          type: "string",
          description:
            "A window title (substring) or hwnd from computer_windows. Omitted uses the foreground window.",
        },
        value: { type: "string" },
        clear: { type: "boolean" },
        submit: {
          type: "string",
          enum: ["auto", "enter", "none"],
          description:
            "auto: Enter first, then a send button by name (发送/send), each verified. none: leave the field filled.",
        },
      },
      required: ["target", "value"],
      additionalProperties: false,
    },
    output: computerOutput("fill"),
    async execute(input) {
      requireDesktop();
      requireAccessibility();
      const args = requireObject(input);
      const target = requireString(args.target, "target");
      const value = requireString(args.value, "value");
      const clear = args.clear !== false;
      const submit = optionalString(args.submit) ?? "auto";
      const windowQuery = optionalString(args.window);
      const record = windowQuery
        ? resolveWindow(windowQuery)
        : requireForegroundRecord();
      const hwnd = handleValue(record.hwnd);
      const phases: FillPhase[] = [];

      // Phase 1 — locate. A name goes through the tree; coordinates go
      // straight to the pointer.
      let element: UiaElement | undefined;
      let rect: UiaRect | undefined;
      const coordinates = parsePoint(target);
      if (coordinates) {
        rect = { x: coordinates.x, y: coordinates.y, w: 1, h: 1 };
        phases.push({ phase: "locate", ok: true, via: "coordinates", rect });
      } else {
        const matches = findElements(hwnd, target, {
          maxNodes: 2000,
          maxDepth: 32,
        });
        if (matches.length === 0) {
          phases.push({ phase: "locate", ok: false, via: "uia" });
          return JSON.stringify(
            { ok: false, phases, abortedAt: phases.length, target, value },
            null,
            2,
          );
        }
        element = matches[0]!;
        rect = element.rect;
        phases.push({
          phase: "locate",
          ok: true,
          via: "uia",
          name: element.name,
          ...(rect ? { rect } : {}),
        });
        // The search keeps its matches; give back the ones we did not take.
        for (const extra of matches.slice(1)) releaseElement(extra);
      }

      // Phase 2 — focus. A click at the rect is the honest way to focus a
      // rendered control; the accessibility SetFocus would also do.
      if (rect) {
        const center = centerOf(rect);
        moveCursor(center.x, center.y);
        clickAt(center.x, center.y);
        const focus = focusedElement();
        phases.push({
          phase: "focus",
          ok: true,
          ...(focus
            ? { focusAfter: `${focus.controlTypeName}:${focus.name}` }
            : {}),
        });
      }

      // Phase 3+4 — clear, then write. The value pattern's write is atomic
      // and cannot lose a character; keystrokes are the fallback for fields
      // the pattern cannot reach.
      const before = element?.value;
      if (clear) {
        phases.push({
          phase: "clear",
          ok: true,
          ...(before === undefined ? {} : { valueBefore: before }),
        });
        if (
          element &&
          element.value !== undefined &&
          element.valueReadOnly === false
        )
          setElementValue(element, "");
      }
      let landed: string | null = null;
      if (element && element.valueReadOnly === false) {
        setElementValue(element, value);
        landed = element.value ?? null;
      } else {
        // No writable pattern: type it, then read the field back.
        typeText(value);
        const after = element ? (element.value ?? null) : null;
        landed = after;
      }
      phases.push({
        phase: "type",
        ok: landed === value,
        dispatched: value,
        landed,
        matched: landed === value,
      });
      if (landed !== value) {
        if (element) releaseElement(element);
        return JSON.stringify(
          {
            ok: false,
            phases,
            abortedAt: phases.length,
            reason:
              landed === null
                ? "the field's value could not be read back, so the write is unverified"
                : "the field holds different text than was sent",
          },
          null,
          2,
        );
      }

      // Phase 5 — submit through the ladder, each step verified by whether
      // the field cleared (a submitted message leaves an empty box).
      const attempts: string[] = [];
      let fieldCleared = false;
      if (submit === "auto" || submit === "enter") {
        attempts.push("enter");
        sendKeySpec("enter");
        await Bun.sleep(400);
        const after = element?.value ?? null;
        fieldCleared = after === "";
        if (!fieldCleared && submit === "auto") {
          const sendNames = ["发送", "send", "Send", "提交"];
          for (const name of sendNames) {
            const button = findElements(hwnd, name, {
              maxNodes: 800,
              maxDepth: 16,
            })[0];
            if (!button?.rect) continue;
            attempts.push(`button:${name}`);
            const center = centerOf(button.rect);
            moveCursor(center.x, center.y);
            clickAt(center.x, center.y);
            await Bun.sleep(400);
            if ((element?.value ?? null) === "") {
              fieldCleared = true;
              break;
            }
          }
        }
      }
      phases.push({
        phase: "submit",
        ok: submit === "none" ? true : fieldCleared,
        attempts,
        fieldCleared,
        ...(submit !== "none" && !fieldCleared
          ? { reason: "target_busy" }
          : {}),
      });

      // Phase 6 — confirm: read the window once more and report what it says
      // now, so the caller sees the state it asked for.
      const confirmRecord = foregroundWindow();
      const confirmState = confirmRecord
        ? readState(confirmRecord, { maxControls: 12, maxText: 400 })
        : undefined;
      phases.push({
        phase: "confirm",
        ok: true,
        ...(confirmState?.text
          ? { statusAfter: confirmState.text.slice(0, 120) }
          : {}),
      });
      if (element) releaseElement(element);
      const aborted = phases.find((phase) => !phase.ok);
      return JSON.stringify(
        {
          ok: aborted === undefined,
          phases,
          ...(aborted ? { abortedAt: phases.indexOf(aborted) + 1 } : {}),
        },
        null,
        2,
      );
    },
  };
}

/** A "x,y" coordinate pair, when the target names one. */
function parsePoint(target: string): { x: number; y: number } | undefined {
  const match = /^\s*(-?\d+)\s*[,:]\s*(-?\d+)\s*$/u.exec(target);
  if (!match) return undefined;
  return { x: Number(match[1]), y: Number(match[2]) };
}

function computerWaitTool(): RuntimeTool {
  return {
    name: "computer_wait",
    description:
      "Wait until the desktop says so, instead of guessing a delay: any of several conditions (a control enabled or named, a window title, a pixel region stable for a while, a window in front), polled until the deadline. This is what turns act → screenshot → reason → act into act → wait → read.",
    requiresApproval: false,
    timeoutSec: 90,
    parameters: {
      type: "object",
      properties: {
        control: {
          type: "string",
          description: "A control name to wait for (in the given window).",
        },
        enabled: { type: "boolean" },
        windowTitle: { type: "string" },
        foreground: {
          type: "string",
          description: "An hwnd that must be the foreground window.",
        },
        pixelStableFor: {
          type: "number",
          description: "Milliseconds a screen region must stay unchanged.",
        },
        region: {
          type: "array",
          items: { type: "number" },
          description: "[x, y, w, h] to watch (defaults to the whole screen).",
        },
        timeout: { type: "number" },
        pollMs: { type: "number" },
      },
      additionalProperties: false,
    },
    output: computerOutput("wait"),
    async execute(input) {
      requireDesktop();
      const args = requireObject(input);
      const timeout = numberOr(args.timeout, 30000);
      const pollMs = Math.max(50, numberOr(args.pollMs, 250));
      const started = Date.now();
      const wantsControl = optionalString(args.control);
      const wantsEnabled = args.enabled === true;
      const wantsTitle = optionalString(args.windowTitle);
      const wantsForeground = optionalString(args.foreground);
      const stableFor = numberOr(args.pixelStableFor, 0);
      let lastSample: Uint8Array | undefined;
      let stableSince: number | undefined;
      let satisfied: Record<string, unknown> | undefined;
      while (Date.now() - started < timeout) {
        const facts: Record<string, unknown> = {};
        if (wantsTitle) {
          const found = readableWindows(enumerateWindows()).some((record) =>
            record.title.toLowerCase().includes(wantsTitle.toLowerCase()),
          );
          facts.windowTitle = found;
          if (found) satisfied = { ...facts, windowTitle: wantsTitle };
        }
        if (wantsForeground) {
          const front = foregroundWindow();
          facts.foreground = front?.hwnd === wantsForeground;
          if (facts.foreground)
            satisfied = { ...facts, foreground: wantsForeground };
        }
        if (wantsControl) {
          const record = foregroundWindow();
          if (record) {
            const matches = findElements(
              handleValue(record.hwnd),
              wantsControl,
              { maxNodes: 800, maxDepth: 16 },
            );
            const enabled = matches.some((match) => match.enabled);
            facts.control = wantsControl;
            facts.controlEnabled = enabled;
            if (matches.length > 0 && (!wantsEnabled || enabled)) {
              satisfied = { ...facts, control: wantsControl };
              for (const match of matches) releaseElement(match);
            } else {
              for (const match of matches) releaseElement(match);
            }
          }
        }
        if (stableFor > 0) {
          const bounds = virtualScreen();
          const region = Array.isArray(args.region)
            ? {
                x: Number(args.region[0] ?? 0),
                y: Number(args.region[1] ?? 0),
                w: Number(args.region[2] ?? bounds.w),
                h: Number(args.region[3] ?? bounds.h),
              }
            : { x: bounds.x, y: bounds.y, w: bounds.w, h: bounds.h };
          const frame = captureRegion(region);
          const stable =
            lastSample !== undefined && samePixels(lastSample, frame.rgb);
          lastSample = frame.rgb;
          if (stable) {
            stableSince ??= Date.now();
            facts.pixelStableFor = Date.now() - stableSince;
            if (Date.now() - stableSince >= stableFor)
              satisfied = { ...facts, pixelStableFor: stableFor };
          } else {
            stableSince = undefined;
          }
        }
        if (satisfied)
          return JSON.stringify(
            {
              satisfied,
              waitedMs: Date.now() - started,
              timedOut: false,
            },
            null,
            2,
          );
        await Bun.sleep(pollMs);
      }
      return JSON.stringify(
        {
          satisfied: null,
          waitedMs: Date.now() - started,
          timedOut: true,
          note:
            "the condition did not hold within the timeout; re-read with " +
            "computer_state and decide again rather than waiting longer",
        },
        null,
        2,
      );
    },
  };
}

/** Whether two same-sized frames are pixel-identical. */
function samePixels(left: Uint8Array, right: Uint8Array): boolean {
  if (left.length !== right.length) return false;
  for (let i = 0; i < left.length; i += 1)
    if (left[i] !== right[i]) return false;
  return true;
}

function computerActionTool(): RuntimeTool {
  return {
    name: "computer_action",
    description:
      "Run a short ATOMIC gesture — a drag, a chord, a move-then-click — where splitting it into separate calls would break it. Each step reports itself; the first failure STOPS the sequence (abortedAt), because a batch that continues after a failure is not convenient, it is faster at causing damage. For anything longer than one gesture, use the semantic tools instead.",
    requiresApproval: true,
    timeoutSec: 30,
    parameters: {
      type: "object",
      properties: {
        steps: {
          type: "array",
          items: {
            type: "object",
            properties: {
              op: {
                type: "string",
                enum: [
                  "move",
                  "mouseDown",
                  "mouseUp",
                  "click",
                  "key",
                  "type",
                  "wait",
                ],
              },
              x: { type: "number" },
              y: { type: "number" },
              button: { type: "string", enum: ["left", "right"] },
              key: { type: "string" },
              text: { type: "string" },
              ms: { type: "number" },
            },
            required: ["op"],
          },
        },
      },
      required: ["steps"],
      additionalProperties: false,
    },
    output: computerOutput("action"),
    async execute(input) {
      requireDesktop();
      const args = requireObject(input);
      const steps = Array.isArray(args.steps) ? args.steps : [];
      if (steps.length === 0)
        throw new Error("computer_action: an empty sequence does nothing");
      const results: Array<{ op: string; ok: boolean; detail?: string }> = [];
      for (const [index, raw] of steps.entries()) {
        const step = (raw ?? {}) as Record<string, unknown>;
        const op = String(step.op ?? "");
        try {
          switch (op) {
            case "move": {
              const x = numberOr(step.x, Number.NaN);
              const y = numberOr(step.y, Number.NaN);
              if (!Number.isInteger(x) || !Number.isInteger(y))
                throw new Error("move needs integer x and y");
              moveCursor(x, y);
              results.push({ op, ok: true, detail: `${x},${y}` });
              break;
            }
            case "mouseDown":
            case "mouseUp": {
              const button =
                optionalString(step.button) === "right" ? "right" : "left";
              if (op === "mouseDown") mouseDown(button);
              else mouseUp(button);
              results.push({ op, ok: true, detail: button });
              break;
            }
            case "click": {
              const x = numberOr(step.x, Number.NaN);
              const y = numberOr(step.y, Number.NaN);
              if (!Number.isInteger(x) || !Number.isInteger(y))
                throw new Error("click needs integer x and y");
              const button =
                optionalString(step.button) === "right" ? "right" : "left";
              clickAt(x, y, button);
              results.push({ op, ok: true, detail: `${x},${y} ${button}` });
              break;
            }
            case "key": {
              const key = requireString(step.key, "key");
              sendKeySpec(key);
              results.push({ op, ok: true, detail: key });
              break;
            }
            case "type": {
              const text = requireString(step.text, "text");
              typeText(text);
              results.push({ op, ok: true, detail: `${text.length} chars` });
              break;
            }
            case "wait": {
              const ms = Math.min(5000, Math.max(0, numberOr(step.ms, 0)));
              await Bun.sleep(ms);
              results.push({ op, ok: true, detail: `${ms}ms` });
              break;
            }
            default:
              throw new Error(`unknown op "${op}"`);
          }
        } catch (error) {
          results.push({
            op,
            ok: false,
            detail: error instanceof Error ? error.message : String(error),
          });
          // Fail fast: nothing after a failure runs.
          return JSON.stringify(
            { ok: false, steps: results, abortedAt: index + 1 },
            null,
            2,
          );
        }
      }
      return JSON.stringify({ ok: true, steps: results }, null, 2);
    },
  };
}

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
