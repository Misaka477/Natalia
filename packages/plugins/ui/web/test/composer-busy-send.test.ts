/**
 * A running turn does not restyle the send key.
 *
 * Measured defect this pins: while a turn ran, typing in the composer showed
 * the send key painted `--neu-error` with INSET shadows — a pressed, refused
 * control — and the user read it as broken. The reference harnesses spell the
 * same vocabulary without recoloring the key: ZCode's composer shows Stop only
 * for an empty draft while streaming (`showStopControl = canStop &&
 * !hasDraftToSubmit`) and keeps the ordinary send key for a draft, which is
 * queued; DSH's `BusyEnterBehavior` is `'queue' | 'steer'`, a delivery mode
 * rather than a danger. So "send while running" is a NORMAL action whose
 * meaning rides the tooltip, and the color stays the accent's. Stop keeps the
 * red: it is the control that interrupts the turn.
 *
 * Shape assertions on the stylesheet, the same discipline the selector tests
 * use — the component keeps `data-busy` so the tooltip can name the delivery.
 */
import { expect, test } from "bun:test";

const styles = await Bun.file(
  new URL("../src/styles/base.ts", import.meta.url).pathname.replace(
    /^\/([A-Za-z]:)/u,
    "$1",
  ),
).text();

const busyRule = () => {
  const at = styles.indexOf('.natalia-composer-submit[data-busy="true"]');
  expect(at).toBeGreaterThan(0);
  return styles.slice(at, styles.indexOf("}", at));
};

test("the busy send key keeps the accent color, not the error color", () => {
  const rule = busyRule();
  expect(rule).toContain("color: var(--neu-accent)");
  expect(rule).not.toContain("--neu-error");
});

test("the busy send key stays raised, never inset", () => {
  const rule = busyRule();
  expect(rule).not.toContain("inset");
  expect(rule).toContain("box-shadow: 3px 3px 6px var(--neu-shadow-dark)");
});

test("the delivery mode rides the tooltip, and Stop keeps the red", async () => {
  const composer = await Bun.file(
    new URL("../src/components/Composer.tsx", import.meta.url).pathname.replace(
      /^\/([A-Za-z]:)/u,
      "$1",
    ),
  ).text();
  expect(composer).toContain('title={props.busy ? "发送并注入当前轮" : "发送"}');
  // The interrupt control is the red one, and it is a separate control.
  expect(composer).toContain("natalia-composer-stop");
  const stopRule = styles.slice(
    styles.indexOf(".neu-pane .natalia-composer-stop {"),
    styles.indexOf("}", styles.indexOf(".neu-pane .natalia-composer-stop {")),
  );
  expect(stopRule).toContain("var(--neu-error)");
  expect(stopRule).not.toContain("inset");
});
