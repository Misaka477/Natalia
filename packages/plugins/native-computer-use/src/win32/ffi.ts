/**
 * The Win32 surface this plugin drives the desktop through.
 *
 * Bun's FFI calls the system DLLs directly, so the control layer has no
 * native build step and no prebuilt binary to stage: the symbols are
 * declared here once and opened lazily. Opening lazily is what lets the
 * plugin LOAD on a platform that has none of these libraries — a tool
 * family that throws at import time takes the whole runtime down with it,
 * and this product ships on more than one platform.
 *
 * The platform branch is a runtime check (`process.platform`), never a
 * build-time choice: the same release carries the plugin everywhere and
 * answers honestly where the desktop cannot be driven.
 */
import { dlopen, FFIType, JSCallback, ptr } from "bun:ffi";

/** Thrown when the desktop cannot be driven on this platform. */
export class DesktopUnavailableError extends Error {
  constructor(reason: string) {
    super(
      `computer use is unavailable on this platform: ${reason}. The tools ` +
        `load everywhere and refuse here rather than pretending; the ` +
        `Windows desktop layer (user32/gdi32) is what backs them.`,
    );
    this.name = "DesktopUnavailableError";
  }
}

const USER32_SYMBOLS = {
  EnumWindows: { args: [FFIType.function, FFIType.ptr], returns: FFIType.bool },
  GetWindowTextW: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.int],
    returns: FFIType.int,
  },
  GetWindowTextLengthW: { args: [FFIType.ptr], returns: FFIType.int },
  GetClassNameW: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.int],
    returns: FFIType.int,
  },
  IsWindowVisible: { args: [FFIType.ptr], returns: FFIType.bool },
  IsIconic: { args: [FFIType.ptr], returns: FFIType.bool },
  GetForegroundWindow: { args: [], returns: FFIType.ptr },
  GetWindowRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  GetClientRect: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  ClientToScreen: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.bool },
  SetForegroundWindow: { args: [FFIType.ptr], returns: FFIType.bool },
  BringWindowToTop: { args: [FFIType.ptr], returns: FFIType.bool },
  ShowWindow: { args: [FFIType.ptr, FFIType.int], returns: FFIType.bool },
  GetDC: { args: [FFIType.ptr], returns: FFIType.ptr },
  ReleaseDC: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.int },
  GetCursorPos: { args: [FFIType.ptr], returns: FFIType.bool },
  SetCursorPos: { args: [FFIType.int, FFIType.int], returns: FFIType.bool },
  GetSystemMetrics: { args: [FFIType.int], returns: FFIType.int },
  SetProcessDPIAware: { args: [], returns: FFIType.bool },
  GetWindowThreadProcessId: {
    args: [FFIType.ptr, FFIType.ptr],
    returns: FFIType.u32,
  },
  mouse_event: {
    args: [FFIType.u32, FFIType.u32, FFIType.u32, FFIType.u32, FFIType.ptr],
    returns: FFIType.void,
  },
  keybd_event: {
    args: [FFIType.u8, FFIType.u8, FFIType.u32, FFIType.ptr],
    returns: FFIType.void,
  },
} as const;

const GDI32_SYMBOLS = {
  CreateCompatibleDC: { args: [FFIType.ptr], returns: FFIType.ptr },
  CreateCompatibleBitmap: {
    args: [FFIType.ptr, FFIType.int, FFIType.int],
    returns: FFIType.ptr,
  },
  SelectObject: { args: [FFIType.ptr, FFIType.ptr], returns: FFIType.ptr },
  BitBlt: {
    args: [
      FFIType.ptr,
      FFIType.int,
      FFIType.int,
      FFIType.int,
      FFIType.int,
      FFIType.ptr,
      FFIType.int,
      FFIType.int,
      FFIType.int,
    ],
    returns: FFIType.bool,
  },
  GetDIBits: {
    args: [
      FFIType.ptr,
      FFIType.ptr,
      FFIType.int,
      FFIType.int,
      FFIType.ptr,
      FFIType.ptr,
      FFIType.int,
    ],
    returns: FFIType.int,
  },
  DeleteObject: { args: [FFIType.ptr], returns: FFIType.bool },
  DeleteDC: { args: [FFIType.ptr], returns: FFIType.bool },
} as const;

export type User32 = ReturnType<
  typeof dlopen<typeof USER32_SYMBOLS>
>["symbols"];
export type Gdi32 = ReturnType<typeof dlopen<typeof GDI32_SYMBOLS>>["symbols"];

export type DesktopLibraries = {
  user32: User32;
  gdi32: Gdi32;
  /** Close nothing: dlopen'd libraries live for the process. */
  close(): void;
};

let libraries: DesktopLibraries | undefined;
let failure: string | undefined;

/**
 * The native libraries, opened once and cached.
 *
 * A platform without them (or a machine where the DLLs refuse to open)
 * answers with a DesktopUnavailableError naming the reason — the honest
 * answer for "this release cannot drive this desktop".
 */
export function desktopLibraries(): DesktopLibraries {
  if (libraries) return libraries;
  if (failure) throw new DesktopUnavailableError(failure);
  if (process.platform !== "win32") {
    failure = `the Windows input and capture layer is not present on ${process.platform}`;
    throw new DesktopUnavailableError(failure);
  }
  try {
    const user32 = dlopen("user32.dll", USER32_SYMBOLS);
    const gdi32 = dlopen("gdi32.dll", GDI32_SYMBOLS);
    libraries = {
      user32: user32.symbols,
      gdi32: gdi32.symbols,
      close() {
        // The libraries are process-lifetime; there is nothing to close.
      },
    };
    return libraries;
  } catch (error) {
    failure = error instanceof Error ? error.message : String(error);
    throw new DesktopUnavailableError(failure);
  }
}

/** A four-int RECT buffer, read and written in Win32's own layout. */
export function rectBuffer() {
  const buffer = Buffer.alloc(16);
  return {
    buffer,
    write(left: number, top: number, right: number, bottom: number) {
      buffer.writeInt32LE(left, 0);
      buffer.writeInt32LE(top, 4);
      buffer.writeInt32LE(right, 8);
      buffer.writeInt32LE(bottom, 12);
      return buffer;
    },
    read(): { left: number; top: number; right: number; bottom: number } {
      return {
        left: buffer.readInt32LE(0),
        top: buffer.readInt32LE(4),
        right: buffer.readInt32LE(8),
        bottom: buffer.readInt32LE(12),
      };
    },
  };
}

/** A POINT buffer. */
export function pointBuffer() {
  const buffer = Buffer.alloc(8);
  return {
    buffer,
    write(x: number, y: number) {
      buffer.writeInt32LE(x, 0);
      buffer.writeInt32LE(y, 4);
      return buffer;
    },
    read(): { x: number; y: number } {
      return { x: buffer.readInt32LE(0), y: buffer.readInt32LE(4) };
    },
  };
}

/**
 * A native handle — a window, a device context, a bitmap — branded the way
 * bun's FFI brands a pointer value: a number at runtime, a distinct type at
 * compile time so an arbitrary integer cannot be passed where a window
 * belongs.
 */
export type NativeHandle = number & { readonly __pointer__: null };

/** The value a pointer parameter or return arrives as. */
export type PointerLike = NodeJS.TypedArray | number | bigint | null;

/**
 * Normalize whatever the FFI layer handed back into a handle.
 *
 * bun returns pointer values as numbers and hands them to callbacks the
 * same way; a caller holding a handle read off a tool result holds a
 * decimal string. One function, so "is this the foreground window" is
 * never answered by comparing a number to a bigint.
 */
export function toHandle(value: PointerLike): NativeHandle {
  if (typeof value === "number") return value as NativeHandle;
  if (typeof value === "bigint") return Number(value) as NativeHandle;
  throw new Error(`not a native handle: ${String(value)}`);
}

/**
 * A decimal handle string back into the value the FFI call takes.
 *
 * The tools carry handles as strings (JSON has no pointers), so this is
 * the boundary a string crosses on its way back to the native layer — and
 * a string that is not a handle is refused here rather than deep inside a
 * call that would interpret it as an address.
 */
export function handleValue(handle: string): NativeHandle {
  const value = Number(handle);
  if (!Number.isSafeInteger(value) || value < 0)
    throw new Error(`not a window handle: ${handle}`);
  return value as NativeHandle;
}

/**
 * A native handle as its decimal string — the one form that survives JSON
 * and stays comparable.
 */
export function handleString(handle: unknown): string {
  return typeof handle === "string" ? handle : String(handle);
}

/** A caller-supplied buffer, for out parameters that hold a handle. */
export function handleBuffer() {
  return Buffer.alloc(8);
}

/** Read a process id out of a DWORD-sized buffer. */
export function readDword(buffer: Buffer): number {
  return buffer.readUInt32LE(0);
}

/** A UTF-16 window title, read out of a buffer the API filled. */
export function readWideString(buffer: Buffer, length: number): string {
  return buffer
    .toString("utf16le", 0, Math.max(0, length * 2))
    .replace(/\0+$/u, "");
}

export { JSCallback, ptr };
