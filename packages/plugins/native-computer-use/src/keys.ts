/**
 * Key specifications: "ctrl+v", "enter", "ctrl+shift+esc", "f5".
 *
 * The tool takes a human-shaped spec and the win32 layer takes virtual-key
 * codes and a press order, so the translation lives here where it can be
 * tested without a keyboard: modifiers go down first and come up last, the
 * key itself is pressed and released between them, and an unknown name is
 * an error that lists what IS known rather than a silent no-op.
 *
 * The virtual-key numbers are the Windows ones; the table is this
 * product's own.
 */

export type KeyStep = { vk: number; up: boolean };

const MODIFIER_ALIASES: Record<string, number> = {
  ctrl: 0x11,
  control: 0x11,
  shift: 0x10,
  alt: 0x12,
  menu: 0x12,
  win: 0x5b,
  meta: 0x5b,
  cmd: 0x5b,
};

const NAMED_KEYS: Record<string, number> = {
  enter: 0x0d,
  return: 0x0d,
  esc: 0x1b,
  escape: 0x1b,
  tab: 0x09,
  space: 0x20,
  spacebar: 0x20,
  backspace: 0x08,
  delete: 0x2e,
  del: 0x2e,
  insert: 0x2d,
  ins: 0x2d,
  home: 0x24,
  end: 0x23,
  pageup: 0x21,
  pagedown: 0x22,
  left: 0x25,
  up: 0x26,
  right: 0x27,
  down: 0x28,
  capslock: 0x14,
  numlock: 0x90,
  scrolllock: 0x91,
  printscreen: 0x2c,
  prtsc: 0x2c,
  apps: 0x5d,
};

/** Function keys f1..f24. */
function functionKey(name: string): number | undefined {
  const match = /^f(\d{1,2})$/u.exec(name);
  if (!match) return undefined;
  const index = Number(match[1]);
  if (index < 1 || index > 24) return undefined;
  return 0x70 + index - 1;
}

/** A single printable character's virtual-key code. */
function characterKey(name: string): number | undefined {
  if (name.length !== 1) return undefined;
  const upper = name.toUpperCase();
  if (upper >= "A" && upper <= "Z") return upper.charCodeAt(0);
  if (name >= "0" && name <= "9") return name.charCodeAt(0);
  const punctuation: Record<string, number> = {
    ";": 0xba,
    "=": 0xbb,
    ",": 0xbc,
    "-": 0xbd,
    ".": 0xbe,
    "/": 0xbf,
    "`": 0xc0,
    "[": 0xdb,
    "\\": 0xdc,
    "]": 0xdd,
    "'": 0xde,
  };
  return punctuation[name];
}

function resolveKey(name: string): number | undefined {
  const key = name.trim().toLowerCase();
  if (key in NAMED_KEYS) return NAMED_KEYS[key];
  return functionKey(key) ?? characterKey(key);
}

/** The names a spec may use, for the error message. */
const KNOWN_NAMES = [
  ...Object.keys(MODIFIER_ALIASES),
  ...Object.keys(NAMED_KEYS),
  "f1-f24",
  "a-z, 0-9, and punctuation",
];

/**
 * Parse one spec into the press order the native layer replays.
 *
 * "ctrl+v" presses ctrl, presses v, releases v, releases ctrl. A spec with
 * several non-modifier keys ("ctrl+v c") is refused: one spec is one
 * chord, and a caller that wants a sequence calls once per key.
 */
export function parseKeySpec(spec: string): KeyStep[] {
  const parts = spec
    .split("+")
    .map((part) => part.trim())
    .filter((part) => part.length > 0);
  if (parts.length === 0)
    throw new Error("computer_key: an empty key spec does nothing");
  const modifiers: number[] = [];
  const keys: number[] = [];
  for (const part of parts) {
    const alias = MODIFIER_ALIASES[part.toLowerCase()];
    if (alias !== undefined) {
      if (!modifiers.includes(alias)) modifiers.push(alias);
      continue;
    }
    const vk = resolveKey(part);
    if (vk === undefined)
      throw new Error(
        `computer_key: unknown key "${part}" (known: ${KNOWN_NAMES.join(", ")})`,
      );
    if (!keys.includes(vk)) keys.push(vk);
  }
  if (keys.length === 0)
    throw new Error(
      `computer_key: "${spec}" names only modifiers; add the key to press`,
    );
  if (keys.length > 1)
    throw new Error(
      `computer_key: "${spec}" presses several keys at once; send one chord per call`,
    );
  const steps: KeyStep[] = [];
  for (const vk of modifiers) steps.push({ vk, up: false });
  steps.push({ vk: keys[0]!, up: false });
  steps.push({ vk: keys[0]!, up: true });
  for (const vk of [...modifiers].reverse()) steps.push({ vk, up: true });
  return steps;
}
