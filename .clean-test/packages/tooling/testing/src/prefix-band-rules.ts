/**
 * §1.1 包前缀即边界 — the never-reverse law, machine-checked:
 * `@natalia/*` may import `@anthelia/*`; `@anthelia/*` may NEVER import
 * `@natalia/*` ("engine sees only itself and the contract"). Until now
 * the band lived in the decisions doc; this makes it import-visible.
 *
 * Text-level like the guard's other import rules (a comment reading
 * like a real import trades precision for consistency with the house
 * style), matching the three import shapes ESM/CJS actually use —
 * static `from`, dynamic `import()`, and `require()`, so the inline
 * `import("@natalia/…")` port-typing form cannot sneak through either.
 *
 * Scope (src only, and only for @anthelia packages) is decided by the
 * caller from the PACKAGE NAME — the prefix itself is the boundary, so
 * a new engine package is covered the moment it is named: no list to
 * drift. Tests are fixtures and stay outside the band: engine suites
 * legitimately import policy (provider-runner's D1 test injects
 * @natalia/agent-prompts).
 */
const ENGINE_NATALIA_IMPORT =
  /(?:from\s+|import\s*\(\s*|require\s*\(\s*)["'](@natalia\/[^"']+)["']/gu;

/** Specifiers this file imports from the @natalia band, in order. */
export function findEnginePrefixBandViolations(text: string): string[] {
  return [...text.matchAll(ENGINE_NATALIA_IMPORT)].map((match) => match[1]!);
}
