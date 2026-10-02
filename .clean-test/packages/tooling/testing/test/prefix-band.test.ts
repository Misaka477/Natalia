import { expect, test } from "bun:test";
import { findEnginePrefixBandViolations } from "../src/prefix-band-rules";

/**
 * §1.1 包前缀即边界 — bite tests for the never-reverse law: every import
 * shape ESM/CJS can express trips it, prose does not, and the other
 * side of the band stays legal.
 */

test("every real import shape toward @natalia is caught", () => {
  expect(
    findEnginePrefixBandViolations('import { foldGoal } from "@natalia/goal";'),
  ).toEqual(["@natalia/goal"]);
  expect(
    findEnginePrefixBandViolations(
      'export type { GoalView } from "@natalia/goal";',
    ),
  ).toEqual(["@natalia/goal"]);
  // the inline port-typing form (import("@natalia/…")) must not sneak
  expect(
    findEnginePrefixBandViolations(
      'type G = import("@natalia/goal").GoalView;',
    ),
  ).toEqual(["@natalia/goal"]);
  expect(
    findEnginePrefixBandViolations('const g = require("@natalia/goal");'),
  ).toEqual(["@natalia/goal"]);
  // multiple, in order
  expect(
    findEnginePrefixBandViolations(
      'import a from "@natalia/collab";\nimport b from "@natalia/client";',
    ),
  ).toEqual(["@natalia/collab", "@natalia/client"]);
});

test("engine-to-engine, third party, and prose stay clean", () => {
  expect(
    findEnginePrefixBandViolations(
      'import { x } from "@anthelia/substrate";\nimport { z } from "zod";',
    ),
  ).toEqual([]);
  // Prose mentioning the band without an import shape = no match
  // (the text-level rule still requires from/import(/require( ).
  expect(
    findEnginePrefixBandViolations(
      "// policy lives under @natalia/goal, never here\n" +
        "The band: @anthelia may not import @natalia.",
    ),
  ).toEqual([]);
});
