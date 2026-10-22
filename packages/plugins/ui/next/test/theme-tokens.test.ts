import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { PALETTES, PALETTE_MODES } from "../src/theme/palettes";
import { derivedColorSlots, shapeTokens } from "../src/theme/shape";

const baseCss = readFileSync(
  new URL("../src/styles/base.ts", import.meta.url),
  "utf8",
);

/** Component-local variables written by JS at render time, not by the theme. */
const COMPONENT_LOCAL_VARS = ["--context-meter-color", "--context-percent"];

test("every CSS variable base.ts consumes is defined by the theme layer", () => {
  const consumed = new Set<string>();
  for (const match of baseCss.matchAll(/var\((--[a-z0-9-]+)/g)) {
    consumed.add(match[1]);
  }
  const defined = new Set<string>([
    ...Object.keys(PALETTES.light),
    ...Object.keys(shapeTokens),
    ...derivedColorSlots,
    ...COMPONENT_LOCAL_VARS,
  ]);
  const missing = [...consumed].filter((name) => !defined.has(name)).sort();
  expect(missing).toEqual([]);
});

test("every palette defines the same semantic slot set", () => {
  const slots = Object.keys(PALETTES.light).sort();
  expect(slots.length).toBeGreaterThan(0);
  for (const mode of PALETTE_MODES) {
    expect(Object.keys(PALETTES[mode]).sort()).toEqual(slots);
  }
});

test("no palette value is empty and every value is a CSS color or shadow", () => {
  for (const mode of PALETTE_MODES) {
    for (const [slot, value] of Object.entries(PALETTES[mode])) {
      expect(value.length).toBeGreaterThan(0);
      expect(value).toMatch(/^(#|rgb|hsl|color-mix|var\(|inset |\d)/);
    }
  }
});

test("shape tokens carry no color literal, only structure", () => {
  for (const [name, value] of Object.entries(shapeTokens)) {
    expect(value).not.toMatch(/#[0-9a-fA-F]{3,6}\b/);
    expect(value).not.toMatch(/\brgba?\(/);
  }
});

test("the stylesheet carries no hardcoded color outside the derived aliases", () => {
  const lines = baseCss.split("\n");
  const offenders: string[] = [];
  lines.forEach((line, index) => {
    if (line.includes("color-mix")) return;
    if (/#[0-9a-fA-F]{3,6}\b/.test(line) || /\brgba?\(/.test(line)) {
      offenders.push(`${index + 1}: ${line.trim()}`);
    }
  });
  expect(offenders).toEqual([]);
});
