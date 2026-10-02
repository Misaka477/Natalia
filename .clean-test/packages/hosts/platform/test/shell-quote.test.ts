import { describe, expect, test } from "bun:test";
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import { shellQuote } from "../src/index";

const run = promisify(execFile);

describe("shellQuote", () => {
  test("wraps a plain value in a single-quoted string", () => {
    expect(shellQuote("echo hi")).toBe("'echo hi'");
  });

  test("produces an empty quoted string for an empty value", () => {
    expect(shellQuote("")).toBe("''");
  });

  test("closes, escapes, and reopens an embedded quote", () => {
    // The `'''` form would instead terminate the string and silently drop text.
    expect(shellQuote("it's")).toBe(`'it'\\''s'`);
    expect(shellQuote("'")).toBe(`''\\'''`);
  });

  test("escapes every occurrence rather than only the first", () => {
    expect(shellQuote("a'b'c")).toBe(`'a'\\''b'\\''c'`);
  });

  // These cases are the regressions that a `'''` replacement caused: the shell
  // either failed to parse the script or, worse, ran a silently altered command.
  test.each([
    [`echo "it's fine"`, "it's fine"],
    [`printf '%s\\n' hello`, "hello"],
    [`echo 'a b'`, "a b"],
    [`echo 'single'`, "single"],
  ])("round-trips %j through a nested shell", async (command, expected) => {
    const { stdout } = await run("bash", [
      "-lc",
      `bash -c ${shellQuote(command)}`,
    ]);
    expect(stdout.trim()).toBe(expected);
  });

  test("keeps a quoted value from breaking out of the surrounding script", async () => {
    // A value that tries to close the quote and append a command must stay a
    // single argument.
    const hostile = `x'; echo INJECTED; echo '`;
    const { stdout } = await run("bash", [
      "-lc",
      `printf '%s' ${shellQuote(hostile)}`,
    ]);
    expect(stdout).toBe(hostile);
    expect(stdout).not.toContain("INJECTED\n");
  });
});
