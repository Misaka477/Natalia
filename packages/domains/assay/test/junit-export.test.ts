/**
 * A run exports as JUnit XML, and a timeout is not a failing test.
 *
 * The defect this closes: evidence lived only in Natalia's own vocabulary, so
 * nothing outside the product could read it — an export in the format every CI
 * tool already parses was the missing half of "the green is portable". The
 * mapping is where honesty lives: `timed_out` maps to `<error>`, never to
 * `<failure>`, because a run killed at its budget never answered.
 */
import { describe, expect, test } from "bun:test";
import { escapeXml, validationRunToJUnitXml } from "../src/junit";

describe("validationRunToJUnitXml", () => {
  test("a passing run is a plain testcase with its output", () => {
    const xml = validationRunToJUnitXml({
      suite: "fourier-contour-video",
      cases: [
        {
          name: "bun test packages/contour",
          outcome: "exited",
          exitCode: 0,
          durationMs: 12_400,
          summary: "42 pass, 0 fail",
        },
      ],
    });
    expect(xml).toContain('tests="1" failures="0" errors="0"');
    expect(xml).toContain('name="fourier-contour-video"');
    expect(xml).toContain('name="bun test packages/contour" time="12.400"');
    expect(xml).toContain("<system-out>42 pass, 0 fail</system-out>");
    expect(xml).not.toContain("<failure");
  });

  test("a non-zero exit is a failure carrying its status", () => {
    const xml = validationRunToJUnitXml({
      suite: "s",
      cases: [
        {
          name: "ctest",
          outcome: "exited",
          exitCode: 3,
          summary: "3 tests failed",
        },
      ],
    });
    expect(xml).toContain('failures="1"');
    expect(xml).toContain('<failure message="exit 3">3 tests failed</failure>');
  });

  test("a run killed at its budget is an ERROR, not a failure", () => {
    const xml = validationRunToJUnitXml({
      suite: "s",
      cases: [
        { name: "make check", outcome: "timed_out", summary: "killed at 120s" },
      ],
    });
    expect(xml).toContain('errors="1"');
    expect(xml).toContain('failures="0"');
    expect(xml).toContain('<error message="timed out');
    expect(xml).not.toContain("<failure");
  });

  test("cancelled and spawn-failed are distinguished from each other", () => {
    const xml = validationRunToJUnitXml({
      suite: "s",
      cases: [
        { name: "a", outcome: "aborted", summary: "" },
        { name: "b", outcome: "spawn-failed", summary: "" },
      ],
    });
    expect(xml).toContain('skipped="1"');
    expect(xml).toContain('errors="1"');
    expect(xml).toContain('<skipped message="cancelled');
    expect(xml).toContain("the command could not be started");
  });

  test("text is escaped, so a summary cannot break the document", () => {
    const xml = validationRunToJUnitXml({
      suite: 'a "quoted" <suite>',
      cases: [
        {
          name: "cmd <&>",
          outcome: "exited",
          exitCode: 1,
          summary: "error: expected \"<div>\" & got 'x'",
        },
      ],
    });
    expect(xml).toContain('name="a &quot;quoted&quot; &lt;suite&gt;"');
    expect(xml).toContain("&lt;div&gt;");
    expect(xml).not.toContain("<div>");
    expect(escapeXml("\u0000bell\u0007")).toBe("bell");
  });
});
