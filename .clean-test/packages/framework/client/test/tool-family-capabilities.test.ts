import { expect, test } from "bun:test";
import { CapabilityRegistry } from "@anthelia/capability";
import type { ToolFamily } from "@anthelia/tools";
import {
  runtimeToolNames,
  createToolRegistryFromCapabilities,
  registerToolFamilyCapabilities,
  toolFamilyCapabilityID,
  toolFamilyRegistration,
} from "../src/capabilities/tool-family-capabilities";
import { createToolPublish } from "../src/runtime/tool-publish";

// The built-in tools are capabilities now, so they must be assemblable without a
// runtime. If any of this needed a real client, nothing would have been decoupled.
// Every built-in family is a plugin now, so the family-capability machinery below
// is exercised with synthetic families rather than host-built ones.

function syntheticFamily(id: string): ToolFamily {
  return {
    id,
    name: id,
    version: "1.0.0",
    description: `synthetic ${id}`,
    scope: "session",
    tools: [
      {
        name: `${id}_run`,
        description: "Run",
        requiresApproval: false,
        parameters: { type: "object", properties: {} },
        async execute() {
          return "ok";
        },
      },
    ],
  };
}

test("the effective tool catalogue names migrated plugin tools", () => {
  expect(runtimeToolNames()).toContain("ask_user");
  expect(runtimeToolNames()).toEqual(
    expect.arrayContaining(["plan", "todo_read", "todo_write"]),
  );
  expect(runtimeToolNames()).toEqual(expect.arrayContaining(["glob", "grep"]));
  expect(runtimeToolNames()).toEqual(
    expect.arrayContaining(["read_file", "write_file", "edit_file"]),
  );
  expect(runtimeToolNames()).toContain("apply_edits");
  expect(runtimeToolNames()).toContain("web_fetch");
  expect(runtimeToolNames()).toContain("run_shell");
  expect(runtimeToolNames()).toContain("agent_spawn");
  expect(runtimeToolNames()).toContain("interactive_terminal_start");
  expect(runtimeToolNames()).toContain("interactive_start");
  expect(runtimeToolNames()).toContain("sandbox_create");
  expect(runtimeToolNames()).toContain("process_start");
  expect(runtimeToolNames()).toContain("background_start");
});

test("each family declares exactly the tools grant", () => {
  const family = syntheticFamily("alpha");
  const registration = toolFamilyRegistration(family);
  expect(registration.id).toBe(`natalia-tool-${family.id}`);
  expect(registration.grants).toEqual(["tools"]);
  expect(registration.scope).toBe(family.scope);
});

test("every tool is owned by the family that contributed it", () => {
  const registry = new CapabilityRegistry();
  const family = syntheticFamily("alpha");
  const { tools, outcome } = createToolRegistryFromCapabilities({
    registry,
    families: [family],
  });
  expect(outcome.failed).toEqual([]);
  for (const tool of family.tools) {
    expect(tools.has(tool.name)).toBe(true);
    expect(registry.ownerOf("tools", tool.name)).toBe(
      toolFamilyCapabilityID(family.id),
    );
  }
  // Nothing is in the registry that the kernel does not own: a tool the kernel
  // never accepted must not be callable.
  for (const name of tools.keys())
    expect(registry.ownerOf("tools", name)).toBeString();
});

test("a family that fails to load leaves none of its tools callable", () => {
  const registry = new CapabilityRegistry();
  const good = syntheticFamily("good");
  const broken: ToolFamily = {
    ...syntheticFamily("broken"),
    tools: [
      ...syntheticFamily("broken").tools,
      { ...syntheticFamily("broken").tools[0]!, name: "" },
    ],
  };
  const { tools, outcome } = createToolRegistryFromCapabilities({
    registry,
    families: [good, broken],
  });
  expect(outcome.failed.map((entry) => entry.id)).toEqual([
    toolFamilyCapabilityID("broken"),
  ]);
  // Activation rolled back, so the family is absent rather than half-present:
  // the tools it had already contributed before the bad one are gone too.
  for (const tool of broken.tools) expect(tools.has(tool.name)).toBe(false);
  // The good family still loads.
  expect(tools.has("good_run")).toBe(true);
});

test("registering the same families twice is refused, not silently doubled", () => {
  const registry = new CapabilityRegistry();
  const families = [syntheticFamily("alpha")];
  expect(registerToolFamilyCapabilities(registry, families).failed).toEqual([]);
  const second = registerToolFamilyCapabilities(registry, families);
  expect(second.loaded).toEqual([]);
  expect(second.failed.length).toBe(families.length);
  for (const failure of second.failed)
    expect(failure.reason).toMatch(/already registered/u);
});

test("dependency ordering registers a dependent after its dependency", () => {
  const registry = new CapabilityRegistry();
  const dependent: ToolFamily = {
    ...syntheticFamily("later"),
    dependencies: ["earlier"],
  };
  const earlier = syntheticFamily("earlier");
  // Dependent listed first on purpose: ordering must fix it, not the caller.
  const { tools, outcome } = createToolRegistryFromCapabilities({
    registry,
    families: [dependent, earlier],
  });
  expect(outcome.failed).toEqual([]);
  expect(outcome.loaded.map((entry) => entry.registration.id)).toEqual([
    toolFamilyCapabilityID("earlier"),
    toolFamilyCapabilityID("later"),
  ]);
  expect(tools.has("earlier_run")).toBe(true);
  expect(tools.has("later_run")).toBe(true);
  expect(registry.has(toolFamilyCapabilityID("later"))).toBe(true);
  expect(registry.has(toolFamilyCapabilityID("earlier"))).toBe(true);
});

test("publishing capabilities reports the ones that went away", () => {
  // Publishing only `loaded` made the stream additive: a consumer accumulated
  // capabilities and never heard about one going away, so a reload that dropped
  // a family left it on screen. The sync is what makes removal observable.
  const published: Array<{ type: string; id: string; name?: string }> = [];
  let present = [
    {
      id: "family_a",
      name: "Family A",
      version: "1.0.0",
      scope: "session",
      grants: [],
    },
    {
      id: "family_b",
      name: "Family B",
      version: "1.0.0",
      scope: "session",
      grants: [],
    },
  ];
  const tools = createToolPublish(
    {
      ports: {
        publish: (event: { type: string; id: string; name?: string }) =>
          published.push(event),
        getCapabilityRegistry: () => ({ list: () => present }),
      },
    } as never,
    {} as never,
  );

  tools.publishRuntimeCapabilities();
  expect(published.map((event) => `${event.type}:${event.id}`)).toEqual([
    "capability.loaded:cap:family_a",
    "capability.loaded:cap:family_b",
  ]);

  // A reload drops family_b.
  present = [present[0]!];
  published.length = 0;
  tools.publishRuntimeCapabilities();

  expect(published.map((event) => `${event.type}:${event.id}`)).toEqual([
    "capability.loaded:cap:family_a",
    "capability.unloaded:cap:family_b",
  ]);
  // The removal carries the name, which is what a UI needs to say what left.
  expect(published[1]!.name).toBe("Family B");
});
