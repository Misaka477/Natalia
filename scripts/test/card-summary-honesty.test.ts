/**
 * A completed row says what happened, not which verb the call used.
 *
 * The row's summary on a FINISHED call is derived from the result — that is the
 * third ruler ("green is data, not a boolean", applied to every row): a reader
 * looking at `generation · listed` learns nothing, and "listed" is what four
 * families drew on every single call until they were made to read their own
 * envelope.
 *
 * The check is a source walk: inside a `presentResult`, a `summary:` that is a
 * bare quoted string is flagged. A PENDING row (`presentCall`) may say its verb —
 * there is no result yet — so only `presentResult` blocks are scanned.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const repoRoot = join(import.meta.dir, "..", "..");

function sourceFiles(): string[] {
  const found: string[] = [];
  const walk = (dir: string) => {
    let entries;
    try {
      entries = readdirSync(dir, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      if (entry.name === "node_modules" || entry.name === "dist") continue;
      const path = join(dir, entry.name);
      if (entry.isDirectory()) {
        if (entry.name !== "native") walk(path);
        continue;
      }
      if (entry.name.endsWith(".ts") && !entry.name.includes(".test."))
        found.push(path);
    }
  };
  for (const group of ["packages"]) walk(join(repoRoot, group));
  return found;
}

/** Every `presentResult(...) { ... }` body in one file, brace-matched. */
function presentResultBodies(source: string): string[] {
  const bodies: string[] = [];
  const marker = "presentResult";
  let index = source.indexOf(marker);
  while (index !== -1) {
    const open = source.indexOf("{", index);
    if (open === -1) break;
    let depth = 0;
    let end = open;
    for (let cursor = open; cursor < source.length; cursor += 1) {
      const character = source[cursor];
      if (character === "{") depth += 1;
      else if (character === "}") {
        depth -= 1;
        if (depth === 0) {
          end = cursor;
          break;
        }
      }
    }
    bodies.push(source.slice(open, end + 1));
    index = source.indexOf(marker, end);
  }
  return bodies;
}

test("a completed row derives its summary from the result", () => {
  const offenders: string[] = [];
  for (const file of sourceFiles()) {
    const source = readFileSync(file, "utf8");
    if (!source.includes("presentResult")) continue;
    for (const body of presentResultBodies(source)) {
      // `summary: "verb",` — a literal, with no template, ternary or call.
      const literal =
        /\bsummary:\s*("([^"\\]|\\.)*"|'([^'\\]|\\.)*')\s*,/u.exec(body);
      if (!literal) continue;
      // A card that carries the detail elsewhere (a body, a facet, a structured
      // output, hunks, lines) is not a verb-only row: `write_file` says "wrote"
      // and shows the diff, `read_file` says nothing but the page. The defect is
      // a row where the summary is ALL the reader gets.
      if (
        /\b(body|meta|output|lines|hunks|checklist|matches|paths|content):/u.test(
          body,
        )
      )
        continue;
      const name = /name:\s*"([a-z_]+)"/u.exec(source)?.[1] ?? "?";
      offenders.push(
        `${file.replace(repoRoot, "").replace(/\\/gu, "/")} (${name}): ${literal[1]}`,
      );
    }
  }
  expect(
    offenders,
    "a completed card's summary is a bare verb — derive it from the result " +
      "(a status, a count, a path) so the row says what happened",
  ).toEqual([]);
});
