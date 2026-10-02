/**
 * Terminal text handling: paging a native terminal's scrollback, and turning a
 * key description into the bytes a terminal expects.
 *
 * Both are pure string work with no registry, no process and no state, which is
 * why they are here rather than inside the tools that call them: the paging
 * budget and the key encoding are the parts worth testing directly, and they are
 * exported from the package because a consumer driving a terminal needs the same
 * encoding the model's tools use.
 */
import { requireString } from "./arguments";

export function nativeTerminalSearchPage(
  text: string,
  input: {
    query: string;
    startLine: number;
    endLine: number;
    requestedEndLine?: number;
    maxMatches: number;
  },
) {
  const lines = text.split("\n");
  if (lines.at(-1) === "") lines.pop();
  const matches = lines
    .flatMap((line, index) =>
      line.includes(input.query)
        ? [{ line: input.startLine + index, text: truncateTerminalLine(line) }]
        : [],
    )
    .slice(0, input.maxMatches);
  const scannedEndLine = input.startLine + Math.max(0, lines.length - 1);
  return {
    query: input.query,
    searchedRange: {
      startLine: input.startLine,
      endLine: Math.min(input.endLine, scannedEndLine),
      scannedLines: lines.length,
    },
    matches,
    truncatedMatches: matches.length === input.maxMatches,
    nextCursor:
      lines.length === 200 &&
      (input.requestedEndLine === undefined ||
        scannedEndLine < input.requestedEndLine)
        ? {
            startLine: scannedEndLine + 1,
            ...(input.requestedEndLine === undefined
              ? {}
              : { endLine: input.requestedEndLine }),
          }
        : undefined,
  };
}

function truncateTerminalLine(line: string) {
  return nativeTerminalReadPage(line, {}, 1_024).text;
}

export function nativeTerminalReadPage(
  text: string,
  input: { startLine?: number; endLine?: number },
  maxBytes = 16_384,
) {
  const bytes = Buffer.from(text);
  const totalBytes = bytes.byteLength;
  if (totalBytes <= maxBytes)
    return {
      text,
      totalBytes,
      truncated: false,
      deliveredLines: deliveredLineCount(text),
      endLine:
        input.startLine === undefined
          ? undefined
          : input.startLine + deliveredLineCount(text) - 1,
      nextStartLine: undefined,
    };
  let end = maxBytes;
  while (end > 0 && (bytes[end]! & 0xc0) === 0x80) end--;
  const boundary = bytes.subarray(0, end).toString("utf8");
  const newline = boundary.lastIndexOf("\n");
  const pageText = newline >= 0 ? boundary.slice(0, newline + 1) : boundary;
  const deliveredLines = deliveredLineCount(pageText);
  return {
    text: pageText,
    totalBytes,
    truncated: true,
    deliveredLines,
    endLine:
      input.startLine === undefined
        ? undefined
        : input.startLine + deliveredLines - 1,
    nextStartLine:
      input.startLine === undefined || deliveredLines === 0
        ? undefined
        : input.startLine + deliveredLines,
  };
}

function deliveredLineCount(text: string) {
  if (!text) return 0;
  const lines = text.split("\n");
  return lines.at(-1) === "" ? lines.length - 1 : lines.length;
}

type TerminalKeyInput = {
  key?: unknown;
  text?: unknown;
  modifiers?: unknown;
  repeat?: unknown;
};

export function encodeTerminalKey(input: TerminalKeyInput) {
  const modifiers = normalizeTerminalModifiers(input.modifiers);
  const repeat = input.repeat === undefined ? 1 : requireRepeat(input.repeat);
  const text =
    input.text === undefined ? undefined : requireString(input.text, "text");
  if (text !== undefined) {
    if (modifiers.size)
      throw new Error("UTF-8 committed text cannot have terminal modifiers");
    return text.repeat(repeat);
  }
  const rawKey = requireString(input.key, "key");
  const key = normalizeTerminalKey(rawKey);
  if (key.length === 1 && key >= "A" && key <= "Z" && !modifiers.has("shift"))
    modifiers.add("shift");
  const bytes = encodeTerminalKeyOnce(key, modifiers);
  return bytes.repeat(repeat);
}

function normalizeTerminalModifiers(value: unknown) {
  if (value === undefined) return new Set<string>();
  if (!Array.isArray(value)) throw new Error("modifiers must be an array");
  const modifiers = new Set(value.map((item) => String(item).toLowerCase()));
  for (const modifier of modifiers)
    if (!["ctrl", "alt", "shift"].includes(modifier))
      throw new Error(`unsupported terminal modifier: ${modifier}`);
  return modifiers;
}

function requireRepeat(value: unknown) {
  if (
    !Number.isInteger(value) ||
    (value as number) < 1 ||
    (value as number) > 100
  )
    throw new Error("repeat must be an integer between 1 and 100");
  return value as number;
}

function normalizeTerminalKey(value: string) {
  const aliases: Record<string, string> = {
    enter: "Enter",
    esc: "Esc",
    escape: "Esc",
    backspace: "Backspace",
    delete: "Delete",
    tab: "Tab",
    "ctrl-c": "CtrlC",
    "ctrl-d": "CtrlD",
    arrowup: "ArrowUp",
    arrowdown: "ArrowDown",
    arrowleft: "ArrowLeft",
    arrowright: "ArrowRight",
    home: "Home",
    end: "End",
    pageup: "PageUp",
    pagedown: "PageDown",
    insert: "Insert",
  };
  const canonical = aliases[value.toLowerCase()] ?? value;
  if (/^F(?:[1-9]|1[0-2])$/u.test(canonical)) return canonical;
  if ([...canonical].length === 1) return canonical;
  if (canonical === "CtrlC" || canonical === "CtrlD") return canonical;
  if (
    [
      "Enter",
      "Esc",
      "Backspace",
      "Delete",
      "Tab",
      "ArrowUp",
      "ArrowDown",
      "ArrowLeft",
      "ArrowRight",
      "Home",
      "End",
      "PageUp",
      "PageDown",
      "Insert",
    ].includes(canonical)
  )
    return canonical;
  throw new Error(`unsupported terminal key: ${value}`);
}

function encodeTerminalKeyOnce(key: string, modifiers: Set<string>) {
  if (key === "CtrlC") return "\x03";
  if (key === "CtrlD") return "\x04";
  const modifier = terminalModifierCode(modifiers);
  const plain = modifiers.size === 0;
  const base: Record<string, string> = {
    Enter: "\r",
    Esc: "\x1b",
    Tab: "\t",
    Backspace: "\x7f",
    Delete: "\x1b[3~",
    Insert: "\x1b[2~",
    Home: "\x1b[H",
    End: "\x1b[F",
    PageUp: "\x1b[5~",
    PageDown: "\x1b[6~",
    ArrowUp: "\x1b[A",
    ArrowDown: "\x1b[B",
    ArrowRight: "\x1b[C",
    ArrowLeft: "\x1b[D",
    F1: "\x1bOP",
    F2: "\x1bOQ",
    F3: "\x1bOR",
    F4: "\x1bOS",
    F5: "\x1b[15~",
    F6: "\x1b[17~",
    F7: "\x1b[18~",
    F8: "\x1b[19~",
    F9: "\x1b[20~",
    F10: "\x1b[21~",
    F11: "\x1b[23~",
    F12: "\x1b[24~",
  };
  if (key in base) {
    if (plain) return base[key]!;
    if (["Enter", "Esc", "Tab", "Backspace"].includes(key))
      throw new Error(`terminal modifiers are not encodable for ${key}`);
    return applyTerminalModifier(base[key]!, modifier);
  }
  if (key.length !== 1) throw new Error(`unsupported terminal key: ${key}`);
  if (modifiers.has("ctrl")) {
    const code = key.toUpperCase().codePointAt(0)!;
    if (code < 0x40 || code > 0x5f)
      throw new Error(`Ctrl modifier is not encodable for ${key}`);
    return `${modifiers.has("alt") ? "\x1b" : ""}${String.fromCharCode(code - 0x40)}`;
  }
  return `${modifiers.has("alt") ? "\x1b" : ""}${key}`;
}

function terminalModifierCode(modifiers: Set<string>) {
  return (
    1 +
    Number(modifiers.has("shift")) +
    Number(modifiers.has("alt")) * 2 +
    Number(modifiers.has("ctrl")) * 4
  );
}

function applyTerminalModifier(bytes: string, modifier: number) {
  if (bytes.startsWith("\x1bO")) return `\x1b[1;${modifier}${bytes.at(-1)}`;
  if (bytes.endsWith("~")) return `${bytes.slice(0, -1)};${modifier}~`;
  return `${bytes.slice(0, -1)}1;${modifier}${bytes.at(-1)}`;
}
