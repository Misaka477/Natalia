import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { generateCompositionDts } from "../src/dts-codegen";
import { compositionRowRegistrations } from "../src/rows";

/**
 * spec §6.5's freshness gate (dsh's verify-cordis-catalog discipline):
 * composition.d.ts must equal a fresh generation from the row registry,
 * both prettier-normalized — the comparison doubles as a syntax check
 * (prettier parses the committed file or the read throws). A registry
 * change without a regen = RED, with the regen command in the message.
 */

const root = resolve(import.meta.dir, "..", "..", "..", "..");

test("composition.d.ts is exactly what the registry generates right now", async () => {
  const prettier = await import("prettier");
  const normalized = await prettier.format(
    generateCompositionDts(compositionRowRegistrations),
    { parser: "typescript" },
  );
  const committed = readFileSync(join(root, "composition.d.ts"), "utf8");
  expect(committed).toBe(normalized);
});

test("the generator emits the authoring surface: envelope, row ids, schema-derived config, origins", async () => {
  const text = generateCompositionDts([
    ...compositionRowRegistrations,
    {
      rowID: "anthelia.example.thing",
      implIDs: ["alpha", "beta"],
      legalSummary: "…",
      configSchema: { safeParse: () => ({ success: true, data: {} }) },
    },
  ]);
  expect(text).toContain(
    'CompositionProfileSchema = "natalia.composition-profile/1"',
  );
  expect(text).toContain("z.input<typeof confinementConfigSchema>");
  expect(text).toContain('id: "anthelia.sandbox";');
  expect(text).toContain("impl?: never;"); // the discovered-backend row
  expect(text).toContain('impl?: "alpha" | "beta";'); // literal union emitter
  expect(text).toContain(
    "origin: registry — @anthelia/contracts.confinementConfigSchema",
  );
  expect(text).toContain("CompositionProfileEnvelope");
  // a registration without a ref stays honest rather than inventing a type
  expect(text).toContain("no configSchemaRef declared");
});
