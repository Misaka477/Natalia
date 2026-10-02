import { expect, test } from "bun:test";
import {
  describeToolAccess,
  renderSubagentTypes,
  resolveSubagentType,
} from "../src/agent-types";

test("an explicit allow-list is reported as itself", () => {
  expect(
    describeToolAccess({
      name: "explore",
      description: "d",
      allowedTools: ["read_file"],
    }),
  ).toBe("tools: read_file");
});

test("a type with no restrictions reports the whole set", () => {
  expect(describeToolAccess({ name: "general", description: "d" })).toBe(
    "tools: all available",
  );
});

test("a type narrowed by exclusions names the exclusions", () => {
  expect(
    describeToolAccess({
      name: "planner",
      description: "d",
      excludedTools: ["write_file", "edit_file"],
    }),
  ).toBe("tools: all except write_file, edit_file");
});

test("an empty exclusion list is the same as no restriction", () => {
  expect(
    describeToolAccess({ name: "g", description: "d", excludedTools: [] }),
  ).toBe("tools: all available");
});

test("only subagent-mode agents with a description are advertised", () => {
  // A primary agent is the main runner, not a spawn target, and one with no
  // description cannot be chosen for any reason.
  const rendered = renderSubagentTypes([
    { name: "build", description: "primary agent", mode: "primary" },
    { name: "explore", description: "read-only search", mode: "subagent" },
    { name: "silent", description: "", mode: "subagent" },
  ]);

  expect(rendered).toContain(
    "explore: read-only search (tools: all available)",
  );
  expect(rendered).not.toContain("build");
  expect(rendered).not.toContain("silent");
  expect(rendered).toContain("Pass one of these as `type`");
});

test("nothing spawnable renders nothing rather than an empty section", () => {
  // A section listing nothing reads as "there are types and they are
  // undocumented".
  expect(renderSubagentTypes([])).toBe("");
  expect(
    renderSubagentTypes([
      { name: "build", description: "primary", mode: "primary" },
    ]),
  ).toBe("");
});

test("an unknown type throws rather than falling back to a general subagent", () => {
  // A caller that asked for a read-only explorer and got a full implementer has
  // not been served, and nothing downstream would say so.
  expect(() =>
    resolveSubagentType("nope", [
      { name: "explore", description: "read-only", mode: "subagent" },
    ]),
  ).toThrow(/unknown subagent type "nope".*explore/);
});

test("a known type resolves", () => {
  const agents = [
    { name: "explore", description: "read-only", mode: "subagent" },
  ];
  expect(resolveSubagentType("explore", agents).name).toBe("explore");
});
