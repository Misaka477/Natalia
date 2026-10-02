/**
 * spec §6.5: writes the generated `composition.d.ts` at the repo root
 * (beside composition.base.json — the composition plane's home). The
 * output is prettier-normalized before writing so the freshness gate
 * can compare normalize(generator) === file exactly, and so the file
 * doubles as its own syntax check (prettier parses it or the write
 * never happens).
 */
import { join, resolve } from "node:path";
import { generateCompositionDts } from "../packages/core/composition/src/dts-codegen";
import { compositionRowRegistrations } from "../packages/core/composition/src/rows";

const root = resolve(import.meta.dir, "..");
const generated = generateCompositionDts(compositionRowRegistrations);
const normalized = await import("prettier").then((prettier) =>
  prettier.format(generated, { parser: "typescript" }),
);
await Bun.write(join(root, "composition.d.ts"), normalized);
console.log(
  `wrote composition.d.ts (${compositionRowRegistrations.length} row(s))`,
);
