import { expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { en, zh } from "../src/locales";

test("both shipped dictionaries carry the same key set", () => {
  // The compile-time guarantee (en satisfies Record<CommonKey, string>)
  // is re-checked here so a runtime edit cannot slip past it.
  const zhKeys = Object.keys(zh).sort();
  const enKeys = Object.keys(en).sort();
  expect(enKeys).toEqual(zhKeys);
  expect(zhKeys.length).toBeGreaterThan(0);
});

test("no dictionary value is empty", () => {
  for (const [key, value] of Object.entries({ ...zh, ...en })) {
    expect(value.length).toBeGreaterThan(0);
  }
});

/**
 * Every `t("...")` key used in source must exist in the zh dictionary.
 * This is the source-scan half of the language-pack contract: the
 * dictionary is the key inventory, and a typo is a test failure rather
 * than a raw key on screen.
 */
test("every t() key used in source exists in the dictionary", () => {
  const roots = [
    join(import.meta.dir, "..", "src", "controllers"),
    join(import.meta.dir, "..", "src", "app-neu.tsx"),
  ];
  const used = new Set<string>();
  const walk = (path: string) => {
    const stat = statSync(path);
    if (stat.isDirectory()) {
      for (const entry of readdirSync(path)) walk(join(path, entry));
      return;
    }
    if (!path.endsWith(".tsx") && !path.endsWith(".ts")) return;
    const source = readFileSync(path, "utf8");
    for (const match of source.matchAll(/\bt\(\s*"([^"]+)"/g)) {
      used.add(match[1]);
    }
  };
  for (const root of roots) walk(root);
  const missing = [...used].filter((key) => !(key in zh)).sort();
  expect(missing).toEqual([]);
  expect(used.size).toBeGreaterThan(0);
});

import { readdirSync, statSync } from "node:fs";
