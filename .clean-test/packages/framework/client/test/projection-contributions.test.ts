import { expect, test } from "bun:test";
import { CapabilityRegistry } from "@anthelia/capability";
import { snapshotProjectionContributions } from "@anthelia/substrate";

test("projection contributions keep title and placement and drop unknown keys", () => {
  const registry = new CapabilityRegistry();
  const owner = registry.registerOwner({
    id: "demo.plugin",
    name: "Demo",
    version: "1.0.0",
    scope: "workspace",
    grants: ["projections"],
  });
  owner.contribute("projections", "demo.card", {
    name: "demo.card",
    title: "Demo card",
    placement: "sidebar",
    text: "hello",
    reactNode: {},
  });
  owner.contribute("projections", "bad", {
    name: "bad",
    placement: "sidebar",
  });
  expect(snapshotProjectionContributions(registry)).toEqual([
    {
      name: "demo.card",
      title: "Demo card",
      placement: "sidebar",
      text: "hello",
    },
  ]);
});
