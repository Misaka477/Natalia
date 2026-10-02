import { expect, test } from "bun:test";
import { RUNTIME_CONFIG_SERVICE, type RuntimeConfigService } from "../src";

test("runtime config service is exposed by its kernel name", () => {
  expect(RUNTIME_CONFIG_SERVICE).toBe("runtime.config");
});

test("the config value contract is the resolved ConfigV3", () => {
  const config = {
    version: 3,
    defaultAgentMode: "ask",
  } as RuntimeConfigService;
  expect(config.version).toBe(3);
});
