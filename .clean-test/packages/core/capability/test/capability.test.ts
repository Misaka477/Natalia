import { expect, test } from "bun:test";
import {
  CapabilityLoadError,
  CapabilityRegistry,
  type CapabilityRegistration,
} from "../src";

function registration(
  id: string,
  overrides: Partial<CapabilityRegistration> = {},
): CapabilityRegistration {
  return {
    id,
    name: id,
    version: "1.0.0",
    scope: "workspace",
    grants: ["tools"],
    ...overrides,
  };
}

test("an opaque owner handle authorizes contributions", () => {
  const registry = new CapabilityRegistry();
  const owner = registry.registerOwner(registration("cap.a"));
  owner.contribute("tools", "read", { run: () => "ok" });
  expect(registry.ownerOf("tools", "read")).toBe("cap.a");
  expect(registry.contribution<{ run(): string }>("tools", "read")?.run()).toBe(
    "ok",
  );
  expect(registry.scopeOf("cap.a")).toBe("workspace");
});

test("authorization and names are checked at storage", () => {
  const registry = new CapabilityRegistry();
  const owner = registry.registerOwner(registration("cap.a"));
  expect(() => owner.contribute("commands", "danger", {})).toThrow(
    /without the "commands" grant/u,
  );
  expect(() => owner.contribute("tools", "", {})).toThrow(/with no name/u);
});

test("owner and individual contribution release are idempotent", () => {
  const registry = new CapabilityRegistry();
  const owner = registry.registerOwner(registration("cap.a"));
  const release = owner.contribute("tools", "read", 1);
  release();
  release();
  expect(registry.contribution("tools", "read")).toBeUndefined();
  owner.contribute("tools", "write", 2);
  owner.release();
  owner.release();
  expect(registry.has("cap.a")).toBe(false);
  expect(registry.contributions("tools")).toEqual([]);
  expect(() => owner.contribute("tools", "late", 3)).toThrow(/is released/u);
});

test("a forged structural handle cannot write owner storage", () => {
  const registry = new CapabilityRegistry();
  registry.registerOwner(registration("cap.a"));
  const forged = {
    id: "cap.a",
    contribute: (_kind: "tools", _name: string, _payload: unknown) => () => {},
    release: () => {},
  };
  forged.contribute("tools", "forged", 1);
  expect(registry.ownerOf("tools", "forged")).toBeUndefined();
});

test("duplicate owners and equal precedence contributions are refused", () => {
  const registry = new CapabilityRegistry();
  const first = registry.registerOwner(registration("cap.a"));
  first.contribute("tools", "shared", "a");
  expect(() => registry.registerOwner(registration("cap.a"))).toThrow(
    CapabilityLoadError,
  );
  const second = registry.registerOwner(registration("cap.b"));
  expect(() => second.contribute("tools", "shared", "b")).toThrow(
    /already provided/u,
  );
});

test("higher precedence replaces and records the effective contribution", () => {
  const registry = new CapabilityRegistry();
  registry
    .registerOwner(registration("base"))
    .contribute("tools", "shared", "base");
  const high = registry.registerOwner(registration("high", { precedence: 10 }));
  high.contribute("tools", "shared", "high");
  expect(registry.contribution<string>("tools", "shared")).toBe("high");
  expect(registry.overrides()).toEqual([
    {
      kind: "tools",
      name: "shared",
      winner: "high",
      winnerPrecedence: 10,
      loser: "base",
      loserPrecedence: 0,
    },
  ]);
});

test("service provide, update, and owner release notify consumers", () => {
  const registry = new CapabilityRegistry();
  const updates: unknown[] = [];
  registry.onServiceUpdate((update) => updates.push(update));
  const owner = registry.registerOwner(
    registration("store", { grants: ["services"] }),
  );
  owner.contribute("services", "store", 1);
  owner.contribute("services", "store", 2);
  expect(registry.service<number>("store")).toBe(2);
  expect(registry.contributions("services")).toHaveLength(1);
  owner.release();
  expect(registry.service("store")).toBeUndefined();
  expect(updates).toEqual([
    { name: "store", provider: "store" },
    { name: "store", provider: "store", providerBefore: "store" },
    { name: "store", provider: undefined },
  ]);
});
