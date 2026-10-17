/**
 * A project may say what its checks establish; the command text only checks it.
 *
 * The defect this closes: evidence classes came from a regex over the command
 * name — `bun test|vitest|jest|pytest|go test|cargo test|ctest` — so a project
 * whose tests run `make check`, `meson test` or `./run_tests.sh` could never
 * honestly show `validation:test`, and the completion card stayed
 * `missing: validation:test` forever. The regex knew `ctest` only because an
 * earlier sweep measured that exact case.
 *
 * A declaration is now authoritative for a command the platform does not
 * recognise, and a CROSS-CHECK for one it does: `tsc` may not claim
 * `validation:test`, because the one thing its text proves is that no test
 * runner ran.
 */
import { describe, expect, test } from "bun:test";
import { resolveValidationClasses, validationClassesFor } from "../src";

describe("resolveValidationClasses", () => {
  test("an unrecognised command accepts the declaration and says so", () => {
    const resolved = resolveValidationClasses({
      command: "make check",
      passed: true,
      declared: ["validation:test"],
    });
    expect(resolved.classes).toContain("validation:test");
    expect(resolved.source).toBe("declared");
    expect(resolved.refused).toBeUndefined();
  });

  test("a recognised command accepts a declaration it supports", () => {
    const resolved = resolveValidationClasses({
      command: "bun test packages/core",
      passed: true,
      declared: ["validation:test", "validation:parser"],
    });
    expect(resolved.classes).toEqual(
      expect.arrayContaining(["validation:any", "validation:test"]),
    );
    expect(resolved.source).toBe("declared+text");
    expect(resolved.refused).toBeUndefined();
  });

  test("a declaration the command text contradicts earns nothing", () => {
    // `tsc` proves a typecheck ran, and equally proves no test runner did.
    const resolved = resolveValidationClasses({
      command: "bunx tsc --noEmit",
      passed: true,
      declared: ["validation:test"],
    });
    expect(resolved.classes).toEqual([]);
    expect(resolved.source).toBe("declared+text");
    expect(resolved.refused).toContain("cannot also claim validation:test");
  });

  test("without a declaration the text alone answers, as before", () => {
    const resolved = resolveValidationClasses({
      command: "cargo test",
      passed: true,
    });
    expect(resolved.source).toBe("text");
    expect(resolved.classes).toEqual(
      validationClassesFor("cargo test", true) as never,
    );
  });

  test("a failed run earns nothing whatever it declared", () => {
    const resolved = resolveValidationClasses({
      command: "make check",
      passed: false,
      declared: ["validation:test"],
    });
    expect(resolved.classes).toEqual([]);
  });

  test("unknown class names are dropped, not passed through", () => {
    const resolved = resolveValidationClasses({
      command: "make check",
      passed: true,
      declared: ["validation:test", "validation:imaginary"],
    });
    expect(resolved.classes).not.toContain("validation:imaginary");
  });
});
