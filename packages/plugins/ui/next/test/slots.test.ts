import { expect, test } from "bun:test";
import { SLOT_NAMES, SlotsRegistry } from "../src/slots/registry";

const stubSlot = () => null as never;

test("a slot renders whatever a plugin registered into it", () => {
  const slots = new SlotsRegistry();
  expect(slots.get("runbar")).toBeUndefined();
  const dispose = slots.register("runbar", stubSlot);
  expect(slots.get("runbar")).toBe(stubSlot);
  expect(slots.filled()).toEqual(["runbar"]);
  dispose();
  expect(slots.get("runbar")).toBeUndefined();
});

test("a slot has one owner: a duplicate registration throws", () => {
  const slots = new SlotsRegistry();
  slots.register("input.dock", stubSlot);
  expect(() => slots.register("input.dock", stubSlot)).toThrow(
    /already has an entry/,
  );
});

test("an unknown slot name is rejected at the boundary", () => {
  const slots = new SlotsRegistry();
  expect(() => slots.register("nope", stubSlot)).toThrow(
    /not one of the shell's slots/,
  );
});

test("registration bumps the revision so mounted slots re-render", () => {
  const slots = new SlotsRegistry();
  const first = slots.get("statusbar");
  expect(first).toBeUndefined();
  const dispose = slots.register("statusbar", stubSlot);
  expect(slots.get("statusbar")).toBe(stubSlot);
  dispose();
  expect(slots.get("statusbar")).toBeUndefined();
});

test("the shell's slots are the architecture's slots", () => {
  expect(SLOT_NAMES.length).toBe(16);
  expect([...SLOT_NAMES]).toEqual([
    "topbar.start",
    "topbar.end",
    "input.dock",
    "runbar",
    "decision",
    "statusbar",
    "transcript.empty",
    "workbench.end",
    "settings.end",
    "sidebar.brand.mark",
    "sidebar.brand.name",
    "sidebar.panellist",
    "sidebar.workspaces",
    "sidebar.settings",
    "sidebar.footer.action",
    "sidebar.toggle.badge",
  ]);
});

test("a disposer is idempotent and only removes its own entry", () => {
  const slots = new SlotsRegistry();
  const dispose = slots.register("decision", stubSlot);
  dispose();
  dispose();
  expect(slots.get("decision")).toBeUndefined();
  slots.register("decision", stubSlot);
  expect(slots.get("decision")).toBe(stubSlot);
});
