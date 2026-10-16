/**
 * The four rungs are a TABLE, and the selector and the writer both read it.
 *
 * The user's model: exactly four rungs, each a PAIR of axes — who asks
 * (approval) and how far a write may reach (confinement). The control used to
 * list the config's three agent modes and write only the approval half, so
 * "auto in the workspace" and "auto everywhere" were indistinguishable and
 * unchoosable.
 */
import { expect, test } from "bun:test";
import {
  PERMISSION_RUNGS,
  availableRungs,
  rungFor,
} from "../src/permission-rungs";

const byID = (id: string) => PERMISSION_RUNGS.find((rung) => rung.id === id)!;

test("the four rungs pair the axes the way the ruling says", () => {
  expect(PERMISSION_RUNGS.map((rung) => rung.id)).toEqual([
    "read",
    "ask",
    "auto",
    "auto-system",
  ]);
  expect(byID("read")).toMatchObject({
    agentMode: "read_only",
    approval: "read_only",
    confinement: "read-only",
  });
  expect(byID("ask")).toMatchObject({
    agentMode: "ask",
    approval: "ask",
    confinement: "workspace-write",
  });
  expect(byID("auto")).toMatchObject({
    agentMode: "auto",
    approval: "auto",
    confinement: "workspace-write",
  });
  expect(byID("auto-system")).toMatchObject({
    agentMode: "auto",
    approval: "auto",
    confinement: "danger-full-access",
  });
  // The two `auto` rungs differ ONLY in the sandbox axis: that distinction is
  // the whole reason the third rung could not be expressed before.
  expect(byID("auto").agentMode).toBe(byID("auto-system").agentMode);
  expect(byID("auto").confinement).not.toBe(byID("auto-system").confinement);
});

test("labels are what the selector shows, and they are distinct", () => {
  const labels = PERMISSION_RUNGS.map((rung) => rung.label);
  expect(new Set(labels).size).toBe(labels.length);
  expect(labels).toContain("read");
  expect(labels).toContain("ask");
  // Both auto rungs name their scope, in the user's own words.
  expect(labels.some((label) => label.includes("工作区"))).toBe(true);
  expect(labels.some((label) => label.includes("系统"))).toBe(true);
});

test("a pair maps back to its rung, and an unmapped pair maps to nothing", () => {
  for (const rung of PERMISSION_RUNGS)
    expect(
      rungFor({ approval: rung.approval, confinement: rung.confinement })?.id,
    ).toBe(rung.id);
  // e.g. a read-only approval with an unrestricted sandbox is not a rung the
  // product offers, and the selector must not pretend otherwise.
  expect(
    rungFor({ approval: "read_only", confinement: "danger-full-access" }),
  ).toBeUndefined();
});

test("a rung whose agent mode is missing is not offered", () => {
  // The selector must hide what it cannot write: choosing such a rung would
  // write a mode the runtime cannot resolve.
  const onlyAsk = availableRungs({ ask: {}, auto: {} });
  expect(onlyAsk.map((rung) => rung.id)).toEqual([
    "ask",
    "auto",
    "auto-system",
  ]);
  expect(availableRungs({})).toEqual([]);
  expect(availableRungs(undefined)).toEqual([]);
  // The shipped config offers all four.
  expect(
    availableRungs({ ask: {}, auto: {}, read_only: {} }).map((r) => r.id),
  ).toEqual(["read", "ask", "auto", "auto-system"]);
});
