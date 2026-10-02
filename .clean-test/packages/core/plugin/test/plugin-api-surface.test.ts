import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";

/**
 * The plugin-facing contract's freshness gate — the PluginAPI half of the
 * behavioral-compatibility contract (interface spec §1.2). The RuntimeClient
 * side has its in-seat vehicles (api-reference's freshness tests,
 * capabilities' exhaustive check, refusals' completeness check); the
 * plugin-facing surface had none, so "members only add, additions must be
 * optional" was a prose promise with no teeth.
 *
 * This gate parses the source type and pins it: a REMOVAL is red, and a
 * non-optional ADDITION is red — an existing plugin does not pass a new
 * required member, so requiring one is a breaking change wearing an
 * additive costume. A deliberate surface edit updates the golden below,
 * the same way every other inventory in this house is edited.
 */

const members = (): Map<string, { optional: boolean }> => {
  const source = readFileSync(
    join(import.meta.dir, "..", "src", "types.ts"),
    "utf8",
  );
  const start = source.indexOf("export type PluginAPI = {");
  expect(start).toBeGreaterThan(-1);
  let depth = 0;
  let end = start;
  for (let index = start; index < source.length; index += 1) {
    const char = source[index]!;
    if (char === "{") depth += 1;
    if (char === "}") {
      depth -= 1;
      if (depth === 0) {
        end = index;
        break;
      }
    }
  }
  const body = source.slice(start, end);
  const found = new Map<string, { optional: boolean }>();
  // Top-level members only: the member line sits at depth 1 of the body's
  // braces BEFORE its own braces are counted, so `tools: {` is matched on
  // its declaration line and its inner lines (depth 2) are not.
  let bodyDepth = 0;
  for (const raw of body.split("\n")) {
    const line = raw.trim();
    if (line.startsWith("//") || line.startsWith("*")) continue;
    const depthBefore = bodyDepth;
    for (const char of line) {
      if (char === "{") bodyDepth += 1;
      if (char === "}") bodyDepth -= 1;
    }
    if (depthBefore !== 1) continue;
    const match = /^([A-Za-z][A-Za-z0-9]*)(\??)\s*:/u.exec(line);
    if (match) found.set(match[1]!, { optional: match[2] === "?" });
  }
  return found;
};

/** The pinned surface: every member a plugin author can rely on today. */
const PLUGIN_API_GOLDEN: readonly string[] = [
  "config",
  "runtimeConfig",
  "tools",
  "services",
  "events",
  "commands",
  "resources",
  "projections",
  "workflows",
  "settingsSchema",
  "adapters",
  "scheduler",
  "effects",
  // 2026-09-25: the cache port (the master plan's closure round). Optional
  // on the type — the freshness gate's rule for additions — while the
  // natalia runtime always provides it (the runtimeConfig pattern).
  "cache",
];

test("the PluginAPI surface only grows, and every growth is optional", () => {
  const surface = members();
  // No removals: every member the golden pins is still on the surface. A
  // plugin-facing removal is a breaking change; the only legal path is a
  // new member with the old kept until the ecosystem stops consuming it.
  for (const name of PLUGIN_API_GOLDEN) expect(surface.has(name)).toBe(true);
  // Additions must be optional: an existing plugin cannot pass a new
  // required member, so requiring one breaks every plugin on the day it
  // ships. This is §1.2's "new parameters optional with defaults", pinned.
  // A required addition is a breaking change and needs the dual-shape path
  // (new name + old kept), never a same-name requirement.
  for (const [name, shape] of surface)
    if (!PLUGIN_API_GOLDEN.includes(name)) expect(shape.optional).toBe(true);
});

test("the golden matches the shipped surface exactly (no silent drift)", () => {
  const surface = members();
  // The golden and the parsed surface must agree in BOTH directions — a
  // member removed from the golden while still in the source is the same
  // lie as a member removed from the source.
  expect([...surface.keys()].sort()).toEqual([...PLUGIN_API_GOLDEN].sort());
});
