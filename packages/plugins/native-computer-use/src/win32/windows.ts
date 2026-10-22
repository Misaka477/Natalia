/**
 * The windows on the desktop: enumeration, geometry, and activation.
 *
 * Enumeration is the FIRST probe, always available, and the one that
 * answers "what is on screen and where" before anything is clicked: a
 * window's title, its class, its rectangle in physical pixels, whether it
 * is visible or minimized, whether it is the one in front, and the process
 * that owns it. A click decided without it is a guess about which window
 * the coordinates belong to.
 *
 * The pure half — filtering the enumeration down to what a reader wants,
 * and matching a query against it — lives here beside the native call but
 * takes no native dependency, so the rules a tool applies are the rules
 * the tests check.
 */
import { FFIType } from "bun:ffi";
import {
  desktopLibraries,
  handleBuffer,
  handleString,
  JSCallback,
  pointBuffer,
  readDword,
  readWideString,
  rectBuffer,
  toHandle,
  type DesktopLibraries,
  type NativeHandle,
  type PointerLike,
} from "./ffi";

export type WindowRecord = {
  /** The window handle, as a decimal string (a bigint in JSON is a lie). */
  hwnd: string;
  title: string;
  className: string;
  pid: number;
  rect: { x: number; y: number; w: number; h: number };
  visible: boolean;
  iconic: boolean;
  foreground: boolean;
};

/** Enumerate every top-level window, in z-order (front to back). */
export function enumerateWindows(): WindowRecord[] {
  const libs = desktopLibraries();
  const found: Array<{
    handle: NativeHandle;
    hwnd: string;
    title: string;
    className: string;
  }> = [];
  const callback = new JSCallback(
    (handle: PointerLike) => {
      const window = toHandle(handle);
      found.push({
        handle: window,
        hwnd: handleString(window),
        title: windowText(libs, window),
        className: windowClass(libs, window),
      });
      return true;
    },
    { returns: FFIType.bool, args: [FFIType.ptr] },
  );
  try {
    // The callback itself, not its address: bun's FFI takes either, and
    // the instance is the one that cannot be a stale address.
    libs.user32.EnumWindows(callback, null);
  } finally {
    // The callback is a native trampoline; leaving one behind per
    // enumeration is a leak that grows with every tool call.
    callback.close();
  }
  const foreground = handleString(libs.user32.GetForegroundWindow());
  const pidBuffer = handleBuffer();
  const rect = rectBuffer();
  return found.map((entry) => {
    libs.user32.GetWindowRect(entry.handle, rect.buffer);
    const box = rect.read();
    libs.user32.GetWindowThreadProcessId(entry.handle, pidBuffer);
    return {
      hwnd: entry.hwnd,
      title: entry.title,
      className: entry.className,
      pid: readDword(pidBuffer),
      rect: {
        x: box.left,
        y: box.top,
        w: box.right - box.left,
        h: box.bottom - box.top,
      },
      visible: libs.user32.IsWindowVisible(entry.handle),
      iconic: libs.user32.IsIconic(entry.handle),
      // Compared as decimal strings: a pointer from the API and a handle
      // read off a tool result are the same window, and `===` between a
      // number and a bigint is the comparison that says they are not.
      foreground: foreground === entry.hwnd,
    };
  });
}

function windowText(libs: DesktopLibraries, handle: NativeHandle): string {
  const length = libs.user32.GetWindowTextLengthW(handle);
  if (length <= 0) return "";
  const buffer = Buffer.alloc((length + 1) * 2);
  const written = libs.user32.GetWindowTextW(handle, buffer, length + 1);
  return readWideString(buffer, written);
}

function windowClass(libs: DesktopLibraries, handle: NativeHandle): string {
  const buffer = Buffer.alloc(512);
  const written = libs.user32.GetClassNameW(handle, buffer, 256);
  return readWideString(buffer, written);
}

/**
 * The windows a reader is shown.
 *
 * A desktop holds hundreds of top-level windows — touch keyboards, shell
 * canvases, invisible message sinks — and a listing that carries all of
 * them costs the model its context to learn nothing. What it keeps is what
 * a person would name: visible windows with a title, or the foreground one
 * whatever its title.
 */
export function readableWindows(records: WindowRecord[]): WindowRecord[] {
  return records.filter((record) => record.visible && record.title.length > 0);
}

/**
 * The window in front, with its title and rectangle.
 *
 * Input goes wherever the foreground window is, so a tool that types or
 * clicks reports which window that was — the fact that turns "I sent
 * ctrl+v" into "I sent ctrl+v to Notepad". A click whose target window was
 * not in front is the failure this line makes visible.
 */
export function foregroundWindow(): WindowRecord | undefined {
  const libs = desktopLibraries();
  const handle = libs.user32.GetForegroundWindow();
  if (!handle) return undefined;
  const pidBuffer = handleBuffer();
  const rect = rectBuffer();
  libs.user32.GetWindowRect(handle, rect.buffer);
  const box = rect.read();
  libs.user32.GetWindowThreadProcessId(handle, pidBuffer);
  return {
    hwnd: handleString(handle),
    title: windowText(libs, handle),
    className: windowClass(libs, handle),
    pid: readDword(pidBuffer),
    rect: {
      x: box.left,
      y: box.top,
      w: box.right - box.left,
      h: box.bottom - box.top,
    },
    visible: libs.user32.IsWindowVisible(handle),
    iconic: libs.user32.IsIconic(handle),
    foreground: true,
  };
}

/**
 * Match a query against the enumeration.
 *
 * A query is a window handle (exact) or a title substring (case
 * insensitive). Several matches are NOT narrowed silently: the caller
 * reports them and lets the model choose, because guessing which
 * "Untitled - Notepad" was meant is how a click lands in the wrong window.
 */
export function matchWindows(
  records: WindowRecord[],
  query: string,
): WindowRecord[] {
  const trimmed = query.trim();
  if (trimmed.length === 0) return [];
  const asHandle = /^\d+$/u.test(trimmed)
    ? records.filter((record) => record.hwnd === trimmed)
    : [];
  if (asHandle.length > 0) return asHandle;
  const needle = trimmed.toLowerCase();
  return records.filter((record) =>
    record.title.toLowerCase().includes(needle),
  );
}

/**
 * The client-area origin, in physical screen pixels.
 *
 * This is the translation a screenshot needs: the capture of a window is
 * its CLIENT AREA, so a point the model reads off that image is relative
 * to this origin, and the click that follows adds it back. The window
 * rectangle itself is wrong for this — it includes the title bar and the
 * borders, which is exactly the offset that makes a click land one
 * title-bar above the button it meant to hit.
 */
export function clientOrigin(handle: NativeHandle): { x: number; y: number } {
  const libs = desktopLibraries();
  const point = pointBuffer().write(0, 0);
  libs.user32.ClientToScreen(handle, point);
  return { x: point.readInt32LE(0), y: point.readInt32LE(4) };
}

/** The client area's size, in physical pixels. */
export function clientSize(handle: NativeHandle): { w: number; h: number } {
  const libs = desktopLibraries();
  const rect = rectBuffer();
  libs.user32.GetClientRect(handle, rect.buffer);
  const box = rect.read();
  return { w: box.right - box.left, h: box.bottom - box.top };
}

/**
 * Bring a window to the front.
 *
 * Windows refuses a background process's request to steal focus, so the
 * sequence works around the lock the way the platform allows: restore a
 * minimized window, tap Alt (the platform's own escape hatch for the
 * foreground lock), then ask. The answer is verified against
 * GetForegroundWindow rather than assumed — a boolean return from
 * SetForegroundWindow means "the request was accepted", not "this window is
 * now in front".
 */
export function activateWindow(handle: NativeHandle): { foreground: boolean } {
  const libs = desktopLibraries();
  if (libs.user32.IsIconic(handle))
    libs.user32.ShowWindow(handle, 9 /* SW_RESTORE */);
  // The Alt tap: keybd_event(VK_MENU down, up) releases the foreground
  // lock for the next SetForegroundWindow call.
  libs.user32.keybd_event(0x12, 0, 0, null);
  libs.user32.keybd_event(0x12, 0, 2 /* KEYEVENTF_KEYUP */, null);
  libs.user32.SetForegroundWindow(handle);
  libs.user32.BringWindowToTop(handle);
  return {
    foreground:
      handleString(libs.user32.GetForegroundWindow()) === handleString(handle),
  };
}
