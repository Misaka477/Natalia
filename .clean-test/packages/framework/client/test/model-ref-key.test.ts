import { expect, test } from "bun:test";
import { deriveModelRefKey } from "../src/model-ref-key";

test("agent model wins over session model and default", () => {
  const key = deriveModelRefKey({
    agent: { model: "agent-model" } as any,
    model: { modelID: "session-model" },
    defaultModel: "default-model",
  });
  expect(key).toBe("agent-model");
});

test("session model wins over the default when no agent model", () => {
  const key = deriveModelRefKey({
    agent: {} as any,
    model: { modelID: "session-model" },
    defaultModel: "default-model",
  });
  expect(key).toBe("session-model");
});

test("the default model is used when nothing is selected", () => {
  const key = deriveModelRefKey({
    agent: {} as any,
    model: {},
    defaultModel: "default-model",
  });
  expect(key).toBe("default-model");
});

test("returns undefined when no model can be resolved", () => {
  const key = deriveModelRefKey({
    agent: {} as any,
    model: {},
    defaultModel: undefined,
  });
  expect(key).toBeUndefined();
});
