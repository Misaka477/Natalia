import { expect, test } from "bun:test";
import { confinementConfigSchema } from "../src/schema-foundation";

test("the shipped default is workspace-write (L1 confinement on)", () => {
  // The threat model speaking: runShell gets Landlock-level enforcement by
  // default, workspace and /tmp writable, the rest of the filesystem
  // read-only. An old config without the row parses to the same default.
  expect(confinementConfigSchema.parse({})).toEqual({
    mode: "workspace-write",
  });
});

test("an explicit mode is preserved", () => {
  expect(confinementConfigSchema.parse({ mode: "read-only" })).toEqual({
    mode: "read-only",
  });
  expect(confinementConfigSchema.parse({ mode: "danger-full-access" })).toEqual(
    { mode: "danger-full-access" },
  );
});

test("an unknown mode is rejected", () => {
  expect(() => confinementConfigSchema.parse({ mode: "sometimes" })).toThrow();
});
