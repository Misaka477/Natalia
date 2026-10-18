import { describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ASSAY_DECLARATION_PATH,
  declaredChecksForFootprint,
  loadAssayDeclaration,
  parseAssayDeclaration,
} from "../src/assay-declaration";

const valid = {
  version: 1,
  checks: [
    {
      id: "types",
      command: "bun run typecheck",
      covers: ["validation:typecheck"],
    },
    {
      id: "unit",
      command: "bun test",
      covers: ["validation:test"],
      timeoutSec: 600,
      scope: ["packages/**"],
      note: "the suite",
      rules: [{ id: "no-any", title: "no explicit any", level: "warning" }],
    },
    { id: "docs", command: "npm run docs:check", covers: ["validation:any"] },
  ],
};

describe("parseAssayDeclaration", () => {
  test("a well-formed declaration reads whole", () => {
    const declaration = parseAssayDeclaration(valid);
    expect(declaration.warnings).toEqual([]);
    expect(declaration.checks.map((check) => check.id)).toEqual([
      "types",
      "unit",
      "docs",
    ]);
    expect(declaration.checks[1]).toMatchObject({
      command: "bun test",
      covers: ["validation:test"],
      timeoutSec: 600,
      scope: ["packages/**"],
      note: "the suite",
    });
    expect(declaration.checks[1]!.rules).toEqual([
      { id: "no-any", title: "no explicit any", level: "warning" },
    ]);
  });

  test("a check without id or command is dropped and said so", () => {
    const declaration = parseAssayDeclaration({
      checks: [
        { id: "good", command: "true", covers: ["validation:any"] },
        { command: "no id", covers: ["validation:any"] },
        { id: "no-command", covers: ["validation:any"] },
      ],
    });
    expect(declaration.checks.map((check) => check.id)).toEqual(["good"]);
    expect(declaration.warnings).toHaveLength(2);
    expect(declaration.warnings.join("\n")).toContain("needs a non-empty");
  });

  test("an unknown evidence class is reported, and the closed vocabulary named", () => {
    const declaration = parseAssayDeclaration({
      checks: [{ id: "a", command: "true", covers: ["validation:lint"] }],
    });
    // The check itself stands — the class it cannot earn is the warning.
    expect(declaration.checks).toHaveLength(1);
    expect(declaration.warnings.join("\n")).toContain("validation:lint");
    expect(declaration.warnings.join("\n")).toContain("validation:typecheck");
  });

  test("a check declaring no covers is warned: a pass would prove nothing", () => {
    const declaration = parseAssayDeclaration({
      checks: [{ id: "a", command: "true" }],
    });
    expect(declaration.warnings.join("\n")).toContain("establishes nothing");
  });

  test("a repeated id keeps the first, and says which", () => {
    const declaration = parseAssayDeclaration({
      checks: [
        { id: "a", command: "first", covers: ["validation:any"] },
        { id: "a", command: "second", covers: ["validation:any"] },
      ],
    });
    expect(declaration.checks).toHaveLength(1);
    expect(declaration.checks[0]!.command).toBe("first");
    expect(declaration.warnings.join("\n")).toContain("repeats the id");
  });

  test("a rule needs id and title; an unknown level is reported", () => {
    const declaration = parseAssayDeclaration({
      checks: [
        {
          id: "a",
          command: "true",
          covers: ["validation:any"],
          rules: [
            { id: "ok", title: "fine", level: "note" },
            { id: "no-title" },
            { id: "bad-level", title: "t", level: "fatal" },
          ],
        },
      ],
    });
    expect(declaration.checks[0]!.rules).toEqual([
      { id: "ok", title: "fine", level: "note" },
      { id: "bad-level", title: "t" },
    ]);
    expect(declaration.warnings.join("\n")).toContain("fatal");
  });

  test("a non-object is one warning and no checks", () => {
    expect(parseAssayDeclaration([])).toMatchObject({
      checks: [],
      warnings: ["the declaration is not a JSON object"],
    });
  });

  test("a future version is read as v1 and the extra fields are ignored loudly", () => {
    const declaration = parseAssayDeclaration({
      version: 7,
      checks: [],
    });
    expect(declaration.version).toBe(7);
    expect(declaration.warnings.join("\n")).toContain("version 1");
  });
});

describe("loadAssayDeclaration", () => {
  test("no file means no declared checks, not an error", async () => {
    const root = await mkdtemp(join(tmpdir(), "assay-declaration-none-"));
    try {
      expect(await loadAssayDeclaration(root)).toEqual({
        version: 1,
        checks: [],
        warnings: [],
      });
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a broken file is an error with the reason, not a silent empty declaration", async () => {
    const root = await mkdtemp(join(tmpdir(), "assay-declaration-broken-"));
    try {
      await mkdir(join(root, ".natalia"), { recursive: true });
      await writeFile(join(root, ASSAY_DECLARATION_PATH), "{ not json", "utf8");
      await expect(loadAssayDeclaration(root)).rejects.toThrow(
        /not valid JSON/u,
      );
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });

  test("a real file round-trips", async () => {
    const root = await mkdtemp(join(tmpdir(), "assay-declaration-ok-"));
    try {
      await mkdir(join(root, ".natalia"), { recursive: true });
      await writeFile(
        join(root, ASSAY_DECLARATION_PATH),
        JSON.stringify(valid),
        "utf8",
      );
      const declaration = await loadAssayDeclaration(root);
      expect(declaration.checks.map((check) => check.command)).toEqual([
        "bun run typecheck",
        "bun test",
        "npm run docs:check",
      ]);
    } finally {
      await rm(root, { recursive: true, force: true });
    }
  });
});

describe("declaredChecksForFootprint", () => {
  const checks = parseAssayDeclaration(valid).checks;

  test("an unscoped check applies to every change", () => {
    expect(
      declaredChecksForFootprint(checks, ["README.md"]).map((c) => c.id),
    ).toEqual(["types", "docs"]);
  });

  test("a scoped check applies when a changed path matches", () => {
    expect(
      declaredChecksForFootprint(checks, [
        "packages/domains/assay/src/x.ts",
      ]).map((c) => c.id),
    ).toEqual(["types", "unit", "docs"]);
  });

  test("** crosses segments and / needs the segment", () => {
    const scoped = parseAssayDeclaration({
      checks: [
        {
          id: "client",
          command: "true",
          covers: ["validation:any"],
          scope: ["packages/framework/client/**"],
        },
        {
          id: "tests",
          command: "true",
          covers: ["validation:any"],
          scope: ["**/test/**"],
        },
      ],
    }).checks;
    expect(
      declaredChecksForFootprint(scoped, [
        "packages/framework/client/src/a.ts",
      ]).map((c) => c.id),
    ).toEqual(["client"]);
    expect(
      declaredChecksForFootprint(scoped, [
        "packages/core/tools/test/a.test.ts",
      ]).map((c) => c.id),
    ).toEqual(["tests"]);
    expect(
      declaredChecksForFootprint(scoped, ["packages/framework/clientx/a.ts"]),
    ).toEqual([]);
  });

  test("windows separators in the footprint read the same", () => {
    expect(
      declaredChecksForFootprint(checks, [
        "packages\\domains\\assay\\src\\x.ts",
      ]).map((c) => c.id),
    ).toEqual(["types", "unit", "docs"]);
  });

  test("no change footprint at all selects only the unscoped checks", () => {
    expect(declaredChecksForFootprint(checks, []).map((c) => c.id)).toEqual([
      "types",
      "docs",
    ]);
  });
});
