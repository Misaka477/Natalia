/**
 * The accessibility tree: how the desktop is READ.
 *
 * Everything in this file comes from the Windows SDK's own headers
 * (10.0.26100.0) or was measured against the real desktop — nothing is from
 * memory. The interface layouts, slot orders, GUIDs and property ids are
 * read out of UIAutomationClient.h/.idl, because a slot index that is off
 * by one calls the wrong method, and on a COM interface that is a crash or
 * garbage rather than an error.
 *
 * The measurements behind the design (all read-only):
 *
 *   - A webview's content IS exposed to UIA, but only through the RAW
 *     view. A control-view walk from a window handle sees 14 nodes; the raw
 *     walk sees 718 named nodes inside one webview subtree, and a whole
 *     desktop (Edge tabs, WeChat, RustDesk, every Explorer window) comes
 *     back by name. So the walk here is the raw walk, and a caller that
 *     wants "controls" filters by control type afterwards.
 *   - A rendered input box is an `Edit` with a NAME, a RECT, and a
 *     ValuePattern that answers the current text. That is what makes "read
 *     the field back after typing" possible at all.
 *   - `GetFocusedElement` answers with a live node.
 *
 * Four COM rules this file keeps, each learned the hard way while building
 * it:
 *
 *   1. **Two dereferences for a method.** `*(iface)` is the vtable pointer
 *      and the method lives at `*(vtable + slot*8)`. Reading
 *      `*(iface + slot*8)` reads the OBJECT's fields, which for a fresh
 *      object is mostly zeros — a call through that is a segfault.
 *   2. **`this` is the first argument**, and a pointer parameter is
 *      declared `u64` (ABI-identical on Windows x64) so a JavaScript
 *      number can carry it. Declaring it `ptr` makes the call reject the
 *      number; declaring it wrongly is how a walk segfaulted at 0xC.
 *   3. **Out-parameters are out-parameters.** `get_CurrentBoundingRectangle`
 *      takes `RECT*` and returns HRESULT — it is NOT a struct returned by
 *      value, and treating it as one passes the hidden return pointer in
 *      the wrong register (a segfault at 0x50).
 *   4. **BSTRs are freed and interfaces are released.** Every string
 *      out-parameter is a SysAllocString allocation the caller owns, and
 *      every element the walk hands back is refcounted. Leaking either is
 *      a slow bleed that presents much later as reads mysteriously
 *      stopping.
 *
 * The one thing this file does NOT do is bound a cross-process call in
 * time. A UIA call to a window that has stopped pumping messages blocks
 * the calling thread, and a synchronous FFI call cannot be interrupted
 * from JavaScript — the tool layer's `timeoutSec` is the bound a caller
 * gets, and the walk is bounded by node count so a pathological tree
 * cannot loop forever. The hardening path is a worker thread the caller
 * can terminate; it is named here so it stays a decision rather than
 * becoming a discovery.
 */
import { CFunction, dlopen, FFIType, ptr } from "bun:ffi";

/* ------------------------------------------------------------------ *
 * The libraries
 * ------------------------------------------------------------------ */

const ole32 = dlopen("ole32.dll", {
  CoInitializeEx: {
    args: [FFIType.ptr, FFIType.u32],
    returns: FFIType.i32,
  },
  CoCreateInstance: {
    args: [FFIType.ptr, FFIType.ptr, FFIType.u32, FFIType.ptr, FFIType.ptr],
    returns: FFIType.i32,
  },
});

const oleaut32 = dlopen("oleaut32.dll", {
  SysFreeString: { args: [FFIType.u64], returns: FFIType.void },
  SysStringLen: { args: [FFIType.u64], returns: FFIType.u32 },
});

/** memcpy is how a vtable slot is read out of an interface. */
const msvcrt = dlopen("msvcrt.dll", {
  // size_t is u64 on Windows x64; bun 1.4 types have no usize alias, and the
  // ABI width is what matters.
  memcpy: {
    args: [FFIType.u64, FFIType.u64, FFIType.u64],
    returns: FFIType.u64,
  },
});

const COINIT_APARTMENTTHREADED = 0x2;
const CLSCTX_INPROC_SERVER = 0x1;
const S_OK = 0;

/** IID_IUIAutomation — 30cbe57d-d9d0-452a-ab13-7ac5ac4825ee. */
const IID_IUIAUTOMATION = guidBuffer("30cbe57d-d9d0-452a-ab13-7ac5ac4825ee");
/** CLSID_CUIAutomation — ff48dba4-60ef-4201-aa87-54103eef594e. */
const CLSID_CUIAUTOMATION = guidBuffer("ff48dba4-60ef-4201-aa87-54103eef594e");
/** IID_IUIAutomationValuePattern — a94cd8b1-0844-4cd6-9d2d-640537ab39e9. */
const IID_VALUE_PATTERN = guidBuffer("a94cd8b1-0844-4cd6-9d2d-640537ab39e9");

/** The UIA_ValuePatternId from UIAutomationClient.idl. */
const UIA_VALUE_PATTERN_ID = 10002;

/** A GUID string as the 16-byte layout COM compares. */
function guidBuffer(text: string): Buffer {
  const hex = text.replaceAll("-", "");
  const out = Buffer.alloc(16);
  out.writeUInt32LE(Number.parseInt(hex.slice(0, 8), 16), 0);
  out.writeUInt16LE(Number.parseInt(hex.slice(8, 12), 16), 4);
  out.writeUInt16LE(Number.parseInt(hex.slice(12, 16), 16), 6);
  for (let i = 0; i < 8; i += 1)
    out[8 + i] = Number.parseInt(hex.slice(16 + i * 2, 18 + i * 2), 16);
  return out;
}

/* ------------------------------------------------------------------ *
 * Vtable plumbing
 * ------------------------------------------------------------------ */

/** The method in interface slot `slot` — two dereferences (rule 1). */
function slotAddress(iface: number, slot: number): number {
  const vtableBuffer = Buffer.alloc(8);
  msvcrt.symbols.memcpy(Number(ptr(vtableBuffer)), iface, 8);
  const vtable = Number(vtableBuffer.readBigUInt64LE(0));
  const methodBuffer = Buffer.alloc(8);
  msvcrt.symbols.memcpy(Number(ptr(methodBuffer)), vtable + slot * 8, 8);
  return Number(methodBuffer.readBigUInt64LE(0));
}

/**
 * bun's runtime CFunction, whose type surface lags the runtime: the export
 * is typed without a construct signature and its `ptr` field is a branded
 * pointer type a plain number cannot satisfy. Both are facts about the
 * types, not about the call — the runtime accepts a numeric address and
 * calls it correctly (measured against GetCurrentProcessId, GetCursorPos
 * and every COM method below), so the cast is the honest bridge.
 */
const NativeFunction = CFunction as unknown as new (input: {
  ptr: number;
  returns: FFIType;
  args: FFIType[];
}) => (...args: (number | bigint | null)[]) => unknown;

/**
 * A COM method as a JavaScript callable.
 *
 * `this` is prepended as a u64 argument (rule 2), so a caller writes
 * `fn(iface, ...rest)` with interface pointers as plain numbers.
 */
function comMethod(
  iface: number,
  slot: number,
  returns: FFIType,
  args: FFIType[],
): (...callArgs: unknown[]) => number {
  const fn = new NativeFunction({
    ptr: slotAddress(iface, slot),
    returns,
    args: [FFIType.u64, ...args],
  });
  return (...callArgs: unknown[]) =>
    Number(fn(iface, ...(callArgs as never[])));
}

/** IUnknown::Release (slot 2). */
function release(iface: number | undefined): void {
  if (!iface) return;
  comMethod(iface, 2, FFIType.u32, [])();
}

/** Read a BSTR out-parameter and free the allocation (rule 4). */
function readBString(read: (holder: Buffer) => number): string {
  const holder = Buffer.alloc(8);
  const status = read(holder);
  if (status !== S_OK) return "";
  const address = Number(holder.readBigUInt64LE(0));
  if (!address) return "";
  try {
    const length = oleaut32.symbols.SysStringLen(address);
    if (!length) return "";
    const bytes = Buffer.alloc(length * 2);
    msvcrt.symbols.memcpy(Number(ptr(bytes)), address, length * 2);
    return bytes.toString("utf16le");
  } finally {
    oleaut32.symbols.SysFreeString(address);
  }
}

/** Read a pointer-sized out-parameter (a HANDLE, an interface pointer). */
function readHandle(read: (holder: Buffer) => number): number | undefined {
  // Eight bytes, because that is what a pointer out-parameter writes.
  const holder = Buffer.alloc(8);
  if (read(holder) !== S_OK) return undefined;
  const value = Number(holder.readBigUInt64LE(0));
  return value || undefined;
}
/** Read a 32-bit integer out-parameter. */
function readInt32(read: (holder: Buffer) => number): number {
  const holder = Buffer.alloc(4);
  if (read(holder) !== S_OK) return 0;
  return holder.readInt32LE(0);
}

/**
 * Build a BSTR by hand.
 *
 * The layout is a 4-byte length prefix (in CHARACTERS), the UTF-16 text,
 * and a terminating null. The callee takes ownership of the pointer, so
 * the buffer that backs it must outlive the call — which it does, because
 * the caller holds it until the write returns.
 */
function toBString(text: string): { pointer: number; buffer: Buffer } {
  const wide = Buffer.from(`${text}\0`, "utf16le");
  const buffer = Buffer.alloc(4 + wide.length);
  buffer.writeUInt32LE(text.length, 0);
  wide.copy(buffer, 4);
  return { pointer: Number(ptr(buffer)) + 4, buffer };
}

/* ------------------------------------------------------------------ *
 * The singleton automation object
 * ------------------------------------------------------------------ */

type Automation = { pointer: number; rawWalker: number };

let automation: Automation | undefined;
let comInitialized = false;

function ensureCom(): void {
  if (comInitialized) return;
  // S_FALSE (already initialized on this thread) is as good as S_OK here.
  ole32.symbols.CoInitializeEx(null, COINIT_APARTMENTTHREADED);
  comInitialized = true;
}

function ensureAutomation(): Automation {
  ensureCom();
  if (automation) return automation;
  const out = Buffer.alloc(8);
  const status = ole32.symbols.CoCreateInstance(
    ptr(CLSID_CUIAUTOMATION),
    null,
    CLSCTX_INPROC_SERVER,
    ptr(IID_IUIAUTOMATION),
    ptr(out),
  );
  if (status !== S_OK)
    throw new Error(
      `CoCreateInstance(CUIAutomation) failed: 0x${(status >>> 0).toString(16)}`,
    );
  const pointer = Number(out.readBigUInt64LE(0));
  // get_RawViewWalker is slot 16 of IUIAutomation.
  const walkerOut = Buffer.alloc(8);
  const walkerStatus = comMethod(pointer, 16, FFIType.i32, [FFIType.ptr])(
    ptr(walkerOut),
  );
  if (walkerStatus !== S_OK)
    throw new Error("IUIAutomation.get_RawViewWalker failed");
  automation = {
    pointer,
    rawWalker: Number(walkerOut.readBigUInt64LE(0)),
  };
  return automation;
}

/* ------------------------------------------------------------------ *
 * The element model
 * ------------------------------------------------------------------ */

export type UiaRect = { x: number; y: number; w: number; h: number };

export type UiaElement = {
  /** The COM pointer. Kept so `setElementValue` can write through it. */
  pointer: number;
  name: string;
  controlType: number;
  controlTypeName: string;
  className: string;
  /** undefined when the element has no ValuePattern. */
  value?: string;
  /** undefined when the element has no ValuePattern. */
  valueReadOnly?: boolean;
  rect?: UiaRect;
  enabled: boolean;
  focusable: boolean;
  focused: boolean;
  offscreen: boolean;
  isPassword: boolean;
  hwnd?: number;
};

/** The control types worth naming, from UIAutomationClient.idl. */
const CONTROL_TYPES: Record<number, string> = {
  50000: "button",
  50001: "calendar",
  50002: "checkbox",
  50003: "combobox",
  50004: "edit",
  50005: "hyperlink",
  50006: "image",
  50007: "listitem",
  50008: "list",
  50009: "menu",
  50010: "menubar",
  50011: "menuitem",
  50012: "progressbar",
  50013: "radiobutton",
  50014: "scrollbar",
  50015: "slider",
  50016: "spinner",
  50017: "statusbar",
  50018: "tab",
  50019: "tabitem",
  50020: "text",
  50021: "toolbar",
  50022: "tooltip",
  50023: "tree",
  50024: "treeitem",
  50025: "custom",
  50026: "group",
  50027: "thumb",
  50028: "datagrid",
  50029: "dataitem",
  50030: "document",
  50032: "window",
  50033: "pane",
  50034: "header",
  50035: "headeritem",
  50036: "table",
  50037: "titlebar",
  50038: "separator",
};

/** The element a window handle resolves to. */
function elementFromHandle(hwnd: number): number {
  const out = Buffer.alloc(8);
  // ElementFromHandle is slot 6 of IUIAutomation.
  const status = comMethod(ensureAutomation().pointer, 6, FFIType.i32, [
    FFIType.u32,
    FFIType.ptr,
  ])(hwnd, ptr(out));
  if (status !== S_OK)
    throw new Error(
      `no accessibility object for window ${hwnd} (0x${(status >>> 0).toString(16)})`,
    );
  return Number(out.readBigUInt64LE(0));
}

/**
 * Read an element's properties.
 *
 * `keep` leaves the interface un-released for a caller that wants to write
 * through it afterwards; the default releases, because a walk that keeps
 * every element it ever saw leaks a reference per node.
 */
function readElement(pointer: number, keep = false): UiaElement {
  const name = readBString((holder) =>
    comMethod(pointer, 23, FFIType.i32, [FFIType.ptr])(ptr(holder)),
  );
  const controlType = readInt32((holder) =>
    comMethod(pointer, 21, FFIType.i32, [FFIType.ptr])(ptr(holder)),
  );
  const className = readBString((holder) =>
    comMethod(pointer, 30, FFIType.i32, [FFIType.ptr])(ptr(holder)),
  );
  const enabled =
    readInt32((holder) =>
      comMethod(pointer, 28, FFIType.i32, [FFIType.ptr])(ptr(holder)),
    ) !== 0;
  const focusable =
    readInt32((holder) =>
      comMethod(pointer, 27, FFIType.i32, [FFIType.ptr])(ptr(holder)),
    ) !== 0;
  const focused =
    readInt32((holder) =>
      comMethod(pointer, 26, FFIType.i32, [FFIType.ptr])(ptr(holder)),
    ) !== 0;
  const offscreen =
    readInt32((holder) =>
      comMethod(pointer, 38, FFIType.i32, [FFIType.ptr])(ptr(holder)),
    ) !== 0;
  const isPassword =
    readInt32((holder) =>
      comMethod(pointer, 35, FFIType.i32, [FFIType.ptr])(ptr(holder)),
    ) !== 0;
  // UIA_HWND is a HANDLE — EIGHT bytes on x64. Reading it into a 4-byte
  // holder lets the callee write past the buffer, which presents much later
  // as a segfault a few nodes into the walk (measured: 2 nodes fine, 10
  // nodes dead). The holder is sized for what the method WRITES.
  const hwnd = readHandle((holder) =>
    comMethod(pointer, 36, FFIType.i32, [FFIType.ptr])(holder),
  );
  const rectBuffer = Buffer.alloc(16);
  // get_CurrentBoundingRectangle takes RECT* and returns HRESULT (rule 3).
  const rectStatus = comMethod(pointer, 43, FFIType.i32, [FFIType.ptr])(
    ptr(rectBuffer),
  );
  const rect: UiaRect | undefined =
    rectStatus === S_OK
      ? {
          x: rectBuffer.readInt32LE(0),
          y: rectBuffer.readInt32LE(4),
          w: rectBuffer.readInt32LE(8) - rectBuffer.readInt32LE(0),
          h: rectBuffer.readInt32LE(12) - rectBuffer.readInt32LE(4),
        }
      : undefined;
  // GetCurrentPatternAs (slot 14) with UIA_ValuePatternId.
  const patternOut = Buffer.alloc(8);
  const patternStatus = comMethod(pointer, 14, FFIType.i32, [
    FFIType.u32,
    FFIType.ptr,
    FFIType.ptr,
  ])(UIA_VALUE_PATTERN_ID, ptr(IID_VALUE_PATTERN), ptr(patternOut));
  let value: string | undefined;
  let valueReadOnly: boolean | undefined;
  if (patternStatus === S_OK) {
    const pattern = Number(patternOut.readBigUInt64LE(0));
    if (pattern) {
      try {
        // get_CurrentValue is slot 4 of IUIAutomationValuePattern.
        value = readBString((holder) =>
          comMethod(pattern, 4, FFIType.i32, [FFIType.ptr])(ptr(holder)),
        );
        // get_CurrentIsReadOnly is slot 5.
        valueReadOnly =
          readInt32((holder) =>
            comMethod(pattern, 5, FFIType.i32, [FFIType.ptr])(ptr(holder)),
          ) !== 0;
      } finally {
        release(pattern);
      }
    }
  }
  const element: UiaElement = {
    pointer,
    name,
    controlType,
    controlTypeName: CONTROL_TYPES[controlType] ?? `type-${controlType}`,
    className,
    ...(value === undefined ? {} : { value }),
    ...(valueReadOnly === undefined ? {} : { valueReadOnly }),
    ...(rect ? { rect } : {}),
    enabled,
    focusable,
    focused,
    offscreen,
    isPassword,
    ...(hwnd ? { hwnd } : {}),
  };
  if (!keep) release(pointer);
  return element;
}

/* ------------------------------------------------------------------ *
 * The walks
 * ------------------------------------------------------------------ */

export type UiaWalkBudget = {
  /** Maximum nodes to visit. A desktop tree runs to thousands. */
  maxNodes?: number;
  /** Maximum depth, so a deep subtree cannot exhaust the queue. */
  maxDepth?: number;
};

type Walker = {
  // 	his (the walker) is already applied by comMethod, so a caller passes only
  // the element and a POINTER to the out-buffer — ptr(), never the Buffer
  // itself (see the note at the call site).
  first: (element: number, out: unknown) => number;
  sibling: (child: number, out: unknown) => number;
};

/** The two navigation calls, already bound to the walker's interface. */

// The two navigation calls are bound to the walker's own interface, so 	his`n// is already applied; the element and the out-buffer are what a caller passes.

/** The raw-view walker's two navigation calls, bound to its interface. */
function walker(): Walker {
  const { rawWalker } = ensureAutomation();
  return {
    first: comMethod(rawWalker, 4, FFIType.i32, [FFIType.u64, FFIType.ptr]),
    sibling: comMethod(rawWalker, 6, FFIType.i32, [FFIType.u64, FFIType.ptr]),
  };
}
/**
 * Walk a window's raw accessibility tree, breadth-first.
 *
 * The raw view is the one that sees rendered content; the control view
 * prunes it away (measured: 14 nodes vs 718 in one webview).
 *
 * REFERENCE DISCIPLINE, and the reason this loop looks the way it does: an
 * element the walker hands back is a reference the caller owns, and it must
 * stay alive for as long as the walk needs to ASK it anything — including
 * "who are your children". An earlier version released each element as soon
 * as it had read its properties, and then called GetFirstChildElement on
 * the freed pointer: a use-after-free that segfaulted a few nodes in,
 * which is exactly the kind of bug that reads as "UIA is flaky". The order
 * here is read, navigate, release — and every element the budget leaves
 * unvisited is released on the way out.
 */
/**
 * Walk a window's raw accessibility tree, breadth-first.
 *
 * The raw view is the one that sees rendered content; the control view
 * prunes it away (measured: 14 nodes vs 718 in one webview).
 *
 * TWO reference-count lessons are baked into the shape of this loop, both
 * paid for in segfaults while it was being written:
 *
 *   1. **An element must outlive the questions asked of it.** Releasing an
 *      element as soon as its properties were read, and then asking it for
 *      its children, is a use-after-free — it crashed a few nodes in, which
 *      is the kind of failure that reads as "UIA is flaky".
 *   2. **A pointer is not an identity.** Elements are released as the walk
 *      goes, and the allocator hands the same address to the next element;
 *      a `seen` set keyed on the pointer value then skips live elements and
 *      the walk terminates early (measured: 10 nodes where 718 exist). So
 *      nothing is released until the walk is OVER, and the pointer set is
 *      valid for exactly as long as no address can be reused.
 */
export function walkWindowTree(
  hwnd: number,
  budget: UiaWalkBudget = {},
): UiaElement[] {
  const { first, sibling } = walker();
  const maxNodes = budget.maxNodes ?? 2000;
  const maxDepth = budget.maxDepth ?? 24;
  const root = elementFromHandle(hwnd);
  const found: UiaElement[] = [];
  const owned: number[] = [root];
  const queue: Array<{ pointer: number; depth: number }> = [
    { pointer: root, depth: 0 },
  ];
  const seen = new Set<number>();
  while (queue.length > 0 && found.length < maxNodes) {
    const current = queue.shift();
    if (!current || seen.has(current.pointer)) continue;
    seen.add(current.pointer);
    if (current.depth > 0) found.push(readElement(current.pointer, true));
    if (current.depth >= maxDepth) continue;
    const childOut = Buffer.alloc(8);
    // ptr(), not the Buffer: CFunction does not convert a TypedArray to its
    // data pointer the way dlopen's symbols do, and a raw Buffer hands the
    // callee the JS object's address to write into.
    if (first(current.pointer, ptr(childOut)) !== S_OK) continue;
    let child = Number(childOut.readBigUInt64LE(0));
    while (child && found.length + queue.length < maxNodes) {
      if (!seen.has(child)) {
        queue.push({ pointer: child, depth: current.depth + 1 });
        owned.push(child);
      }
      const nextOut = Buffer.alloc(8);
      if (sibling(child, ptr(nextOut)) !== S_OK) break;
      const next = Number(nextOut.readBigUInt64LE(0));
      if (next === child) break;
      child = next;
    }
  }
  // The walk is over: every reference it took is given back at once, which
  // is also what keeps the pointer-keyed `seen` set honest above.
  for (const pointer of owned) release(pointer);
  return found;
}

/**
 * Find elements by name, keeping each match for a caller that wants to
 * write through it.
 *
 * The same two reference-count lessons as the walk: a match is read in full
 * and KEPT (the caller owns it through `releaseElement`), and nothing is
 * released until the search is over, because a pointer is not an identity.
 */
export function findElements(
  hwnd: number,
  query: string,
  budget: UiaWalkBudget = {},
): UiaElement[] {
  const { first, sibling } = walker();
  const maxNodes = budget.maxNodes ?? 2000;
  const maxDepth = budget.maxDepth ?? 24;
  const root = elementFromHandle(hwnd);
  const needle = query.trim().toLowerCase();
  const matches: UiaElement[] = [];
  const owned: number[] = [root];
  const queue: Array<{ pointer: number; depth: number }> = [
    { pointer: root, depth: 0 },
  ];
  const seen = new Set<number>();
  let visited = 0;
  while (queue.length > 0 && visited < maxNodes) {
    const current = queue.shift();
    if (!current || seen.has(current.pointer)) continue;
    seen.add(current.pointer);
    visited += 1;
    if (current.depth > 0) {
      // The name first: a non-match costs one string read, and the full
      // read is only spent on an element that will be kept.
      const name = readBString((holder) =>
        comMethod(current.pointer, 23, FFIType.i32, [FFIType.ptr])(ptr(holder)),
      );
      if (needle.length > 0 && name.toLowerCase().includes(needle))
        matches.push(readElement(current.pointer, true));
    }
    if (current.depth >= maxDepth) continue;
    const childOut = Buffer.alloc(8);
    if (first(current.pointer, ptr(childOut)) !== S_OK) continue;
    let child = Number(childOut.readBigUInt64LE(0));
    while (child && visited + queue.length < maxNodes) {
      if (!seen.has(child)) {
        queue.push({ pointer: child, depth: current.depth + 1 });
        owned.push(child);
      }
      const nextOut = Buffer.alloc(8);
      if (sibling(child, ptr(nextOut)) !== S_OK) break;
      const next = Number(nextOut.readBigUInt64LE(0));
      if (next === child) break;
      child = next;
    }
  }
  // Everything the search took, minus the matches the caller now owns.
  const kept = new Set(matches.map((match) => match.pointer));
  for (const pointer of owned) if (!kept.has(pointer)) release(pointer);
  return matches;
}
/** The element that has keyboard focus right now, if any. */
export function focusedElement(): UiaElement | undefined {
  const { pointer } = ensureAutomation();
  const out = Buffer.alloc(8);
  // GetFocusedElement is slot 8.
  const status = comMethod(pointer, 8, FFIType.i32, [FFIType.ptr])(ptr(out));
  if (status !== S_OK) return undefined;
  const element = Number(out.readBigUInt64LE(0));
  if (!element) return undefined;
  return readElement(element);
}

/** Give back an element `findElements` kept. */
export function releaseElement(element: UiaElement): void {
  release(element.pointer);
}

/**
 * Write a field's value through its ValuePattern.
 *
 * This is the atomic write: one call sets the whole string, so there is no
 * per-character loss to verify afterwards (the "Are yu done yet?" failure
 * mode of synthesized keystrokes). The caller reads the value back anyway —
 * a write that reports success without a readback is a write nobody
 * checked.
 */
export function setElementValue(element: UiaElement, text: string): void {
  const patternOut = Buffer.alloc(8);
  const status = comMethod(element.pointer, 14, FFIType.i32, [
    FFIType.u32,
    FFIType.ptr,
    FFIType.ptr,
  ])(UIA_VALUE_PATTERN_ID, ptr(IID_VALUE_PATTERN), ptr(patternOut));
  if (status !== S_OK)
    throw new Error(
      `element "${element.name}" has no value pattern — it cannot be written this way`,
    );
  const pattern = Number(patternOut.readBigUInt64LE(0));
  if (!pattern)
    throw new Error(`element "${element.name}" returned no value pattern`);
  try {
    // SetValue is slot 3 of IUIAutomationValuePattern, and its text
    // argument is a BSTR the callee reads (and copies) — the buffer that
    // backs it must outlive the call, so it is held until SetValue
    // returns.
    const bstr = toBString(text);
    // SetValue takes the BSTR by value (a pointer), declared u64.
    const write = comMethod(pattern, 3, FFIType.i32, [FFIType.u64]);
    const writeStatus = write(bstr.pointer);
    void bstr.buffer;
    if (writeStatus !== S_OK)
      throw new Error(
        `ValuePattern.SetValue on "${element.name}" failed: 0x${(writeStatus >>> 0).toString(16)}`,
      );
  } finally {
    release(pattern);
  }
}

/** Whether the UIA layer is usable at all (a probe, not a promise). */
export function uiaAvailable(): boolean {
  try {
    ensureAutomation();
    return true;
  } catch {
    return false;
  }
}
