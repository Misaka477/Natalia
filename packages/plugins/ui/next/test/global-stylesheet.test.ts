/**
 * The global stylesheet is intact.
 *
 * base.ts is one giant template literal. A single stray backtick inside
 * it — and CSS comments are full of the markdown habit of quoting a
 * class name in backticks — terminates the literal, and everything
 * after it is parsed as TypeScript. The result is either a tsc failure
 * or, worse, a truncated stylesheet: the shell boots with a fraction of
 * its rules and every control loses its styling. It happened twice
 * while this package was being built, and the second time the only
 * symptom was that the page came up bare.
 *
 * This guard reads the composed sheet the way the browser will receive
 * it and asserts it is still a stylesheet: hundreds of rules, balanced
 * braces, and no template syntax leaking into the CSS.
 */
import { expect, test } from "bun:test";
import {
  confirmDialogCss,
  nataliaNeuBaseStyles,
  nataliaNeuStyles,
  nataliaNeuThemeStyles,
  settingsFullscreenCss,
} from "../src/styles";

const SHEET = nataliaNeuStyles;

test("the composed stylesheet is still a stylesheet", () => {
  // No template syntax survived into the CSS.
  expect(SHEET).not.toContain("${");
  expect(SHEET).not.toContain("`");
  // Braces balance: an unbalanced sheet drops every rule after the
  // imbalance, which is the whole sheet in practice.
  const open = (SHEET.match(/\{/gu) ?? []).length;
  const close = (SHEET.match(/\}/gu) ?? []).length;
  expect(open).toBe(close);
  expect(open).toBeGreaterThan(250);
  // The rule count is a floor, not a target: it only ever shrinks when
  // something is dropped, which is what this guard exists to catch.
  const rules = (SHEET.match(/\.[a-z][\w-]*\s*[,{]/gu) ?? []).length;
  expect(rules).toBeGreaterThan(280);
  // Both palettes and the shape tokens are in there: without them every
  // var() in the sheet resolves to nothing.
  expect(SHEET).toContain('[data-theme="light"]');
  expect(SHEET).toContain('[data-theme="dark"]');
  expect(SHEET).toContain("--neu-radius:");
  expect(SHEET).toContain("--neu-elevation-3:");
});

test("the shared form input has its rule back", () => {
  // The regression this package shipped: the form family was restored
  // member by member and the input itself was skipped, so twenty-three
  // inputs across seven files rendered as raw browser controls.
  expect(nataliaNeuBaseStyles).toContain(".neu-form-input {");
  expect(nataliaNeuBaseStyles).toContain(".neu-form-input::placeholder");
  expect(nataliaNeuBaseStyles).toContain(".neu-form-select {");
  expect(nataliaNeuBaseStyles).toContain(".neu-form-checkbox {");
});
