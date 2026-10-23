/**
 * Every declared slot must actually be rendered.
 *
 * The shell declares nine slots a UI plugin may fill. A slot that is
 * declared and never rendered is worse than no slot at all: the plugin
 * registers into it, the registration succeeds, and nothing appears —
 * the plugin author's surface silently vanishes while the registry
 * reports it filled.
 *
 * That is exactly what this guard found: `runbar`, `decision`,
 * `topbar.end` and `workbench.end` were declared in SLOT_NAMES with no
 * SlotMount anywhere, so four of the nine extension points were
 * advertising a place that did not exist.
 */
import { expect, test } from "bun:test";
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative } from "node:path";

const srcRoot = join(import.meta.dir, "..", "src");

/** The shell's declared slots, read from the registry itself. */
function declaredSlots(): string[] {
  const source = readFileSync(join(srcRoot, "slots", "registry.ts"), "utf8");
  const start = source.indexOf("export const SLOT_NAMES");
  const end = source.indexOf("] as const;", start);
  const block = source.slice(start, end);
  // A slot name is lowercase and may carry one dot; three of the nine
  // (statusbar, decision, runbar) are a single word, so the pattern must
  // not require a dot.
  return [...block.matchAll(/"([a-z][a-z.]*)"/g)].map((m) => m[1]!);
}

/** Every source file under src, so the walk is the whole shell. */
function sourceFiles(dir: string): string[] {
  const found: string[] = [];
  let entries;
  try {
    entries = readdirSync(dir, { withFileTypes: true });
  } catch {
    return found;
  }
  for (const entry of entries) {
    const full = join(dir, entry.name);
    if (entry.isDirectory()) found.push(...sourceFiles(full));
    else if (/\.tsx?$/.test(entry.name)) found.push(full);
  }
  return found;
}

/** Every mount, including the ones that ride through a helper: the
 *  sidebar's brand row and settings seat render through `SlotOr`, which
 *  carries the shell's own fallback for an unfilled hole. The name is
 *  still literal at the call site, so the walk sees it. */
function mountedSlots(): Set<string> {
  const mounted = new Set<string>();
  for (const file of sourceFiles(srcRoot)) {
    const source = readFileSync(file, "utf8");
    for (const match of source.matchAll(
      /Slot(?:Mount|Or)[^>]*name="([^"]+)"/g,
    )) {
      mounted.add(match[1]!);
    }
  }
  return mounted;
}

test("every declared slot is rendered by the shell", () => {
  const mounted = mountedSlots();
  const missing = declaredSlots().filter((name) => !mounted.has(name));
  expect(
    missing,
    "these slots are declared in SLOT_NAMES but no SlotMount renders " +
      "them — a plugin registering into one would silently vanish",
  ).toEqual([]);
});

test("every mounted slot is one the shell declares", () => {
  const declared = new Set(declaredSlots());
  const unknown = [...mountedSlots()].filter((name) => !declared.has(name));
  expect(
    unknown,
    "these SlotMounts name a slot the registry does not declare — the " +
      "registry throws on registration, so the mount can never fill",
  ).toEqual([]);
});

test("the shell declares the sixteen slots the architecture names", () => {
  expect(declaredSlots().sort()).toEqual(
    [
      "decision",
      "input.dock",
      "runbar",
      "settings.end",
      "sidebar.brand.mark",
      "sidebar.brand.name",
      "sidebar.footer.action",
      "sidebar.panellist",
      "sidebar.settings",
      "sidebar.toggle.badge",
      "sidebar.workspaces",
      "statusbar",
      "topbar.end",
      "topbar.start",
      "transcript.empty",
      "workbench.end",
    ].sort(),
  );
});
