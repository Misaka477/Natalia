import { expect, test } from "bun:test";
import {
  deriveAgentToolPolicy,
  deriveProfileToolPolicy,
} from "../src/tool-policy-derivation";

test("agent policy falls back to mode defaults then agent overrides", () => {
  const mode = {
    allowedTools: ["a", "b"],
    excludedTools: ["x"],
  } as any;
  const agent = {
    allowedTools: ["b", "c"],
    excludedTools: ["y"],
    permissions: { tools: { allow: ["plugin"], exclude: ["z"] } },
  } as any;
  const { allow, exclude } = deriveAgentToolPolicy({ agent, mode });
  expect(allow).toEqual(["b", "c", "plugin"]);
  expect(exclude).toEqual(["y", "z"]);
});

test("agent policy uses mode only when the agent omits a field", () => {
  const mode = { allowedTools: ["base"], excludedTools: [] } as any;
  const agent = {} as any;
  const { allow, exclude } = deriveAgentToolPolicy({ agent, mode });
  expect(allow).toEqual(["base"]);
  expect(exclude).toEqual([]);
});

test("profile policy forwards allow and exclude verbatim", () => {
  const policy = deriveProfileToolPolicy({
    profile: {
      permissions: { tools: { allow: ["a"], exclude: ["b"] } },
    } as any,
  });
  expect(policy).toEqual({ allow: ["a"], exclude: ["b"] });
});
