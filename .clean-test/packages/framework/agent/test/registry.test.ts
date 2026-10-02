import { expect, test } from "bun:test";
import { AgentRegistry } from "../src";

test("agent registry selects visible primary agents and respects configured defaults", () => {
  const registry = new AgentRegistry({
    defaultAgent: "hidden",
    agents: {
      worker: { description: "Worker", mode: "subagent" },
      hidden: { description: "Hidden", mode: "primary", hidden: true },
      review: { description: "Review", mode: "primary" },
    },
  });
  expect(registry.default()?.name).toBe("review");
  expect(registry.select("worker")?.mode).toBe("subagent");
  expect(registry.selectable().map((agent) => agent.name)).toEqual(["review"]);
});

test("agent registry replaces definitions and clears removed defaults", () => {
  const registry = new AgentRegistry({
    defaultAgent: "build",
    agents: { build: { description: "Build", mode: "primary" } },
  });
  registry.register({ name: "build", description: "Updated", mode: "primary" });
  expect(registry.get("build")?.description).toBe("Updated");
  registry.remove("build");
  expect(registry.default()).toBeUndefined();
});
