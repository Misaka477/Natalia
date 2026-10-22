import { expect, test } from "bun:test";
import {
  SHARED_CARD_KINDS,
  ToolCardRegistry,
  resolveToolCard,
} from "../src/tool-cards/registry";

const stubCard = () => null as never;

test("a tool's own card wins over the shared renderers", () => {
  const registry = new ToolCardRegistry();
  const dispose = registry.register("mcp__github__create_issue", stubCard, {
    localeNS: "mcp",
  });
  const decision = resolveToolCard({
    toolName: "mcp__github__create_issue",
    cardKind: "generic",
    registry,
  });
  expect(decision).toEqual({ tier: "registered" });
  dispose();
});

test("a structured card slot picks the shared renderer", () => {
  const registry = new ToolCardRegistry();
  expect(
    resolveToolCard({ toolName: "read_file", cardKind: "read", registry }),
  ).toEqual({ tier: "shared", kind: "read" });
  expect(
    resolveToolCard({ toolName: "run_shell", cardKind: "terminal", registry }),
  ).toEqual({ tier: "shared", kind: "terminal" });
});

test("a tool with neither still gets the generic card", () => {
  const registry = new ToolCardRegistry();
  expect(
    resolveToolCard({ toolName: "todo_write", cardKind: undefined, registry }),
  ).toEqual({ tier: "generic" });
  // An unknown kind is not a shared renderer either.
  expect(resolveToolCard({ toolName: "x", cardKind: "wat", registry })).toEqual(
    { tier: "generic" },
  );
});

test("a tool name has one owner: a duplicate registration throws", () => {
  const registry = new ToolCardRegistry();
  registry.register("mcp__github__list", stubCard);
  expect(() => registry.register("mcp__github__list", stubCard)).toThrow(
    /already has a registered card/,
  );
});

test("registration is disposable and idempotent", () => {
  const registry = new ToolCardRegistry();
  const dispose = registry.register("skill", stubCard);
  expect(registry.get("skill")).toBe(stubCard);
  expect(registry.toolNames()).toEqual(["skill"]);
  dispose();
  dispose();
  expect(registry.get("skill")).toBeUndefined();
  expect(registry.toolNames()).toEqual([]);
});

test("a registration bumps the revision so mounted rows re-render", () => {
  const registry = new ToolCardRegistry();
  const before = registry.revision();
  const dispose = registry.register("skill", stubCard);
  expect(registry.revision()).toBeGreaterThan(before);
  dispose();
  expect(registry.revision()).toBeGreaterThan(before);
});

test("an empty tool name is rejected at the boundary", () => {
  const registry = new ToolCardRegistry();
  expect(() => registry.register("", stubCard)).toThrow(/needs a tool name/);
});

test("the shared kinds cover the kit's six renderers", () => {
  expect([...SHARED_CARD_KINDS].sort()).toEqual([
    "diff",
    "generic",
    "read",
    "search",
    "terminal",
    "web",
  ]);
});
