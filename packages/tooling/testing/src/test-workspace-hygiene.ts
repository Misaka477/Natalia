/**
 * Test-workspace hygiene — the pure core of `bin/test-workspace-hygiene-guard.ts`.
 *
 * The guard exists for the quiet failure: a test file created workspaces
 * without registering them for teardown, everything passed, and the disk kept
 * filling (95,927 leftovers once exhausted btrfs metadata and turned every
 * later verify red with ENOSPC).
 *
 * It used to detect that by counting directories left under
 * `dist/ts/client-test-workspaces`, which turned out to measure the PLATFORM as
 * much as the property. Measured on Windows, four full runs in a row: teardown
 * emptied a workspace and could not unlink the directory (a just-disposed
 * runtime still held the handle), so a suite where every test passed reported
 * red and the recorded remedy was a manual `rm -rf`. A guard whose verdict is
 * "your OS was slow" stops being read.
 *
 * So the property is checked where it is stated — "every test file creating
 * workspaces must call `useWorkspaceCleanup()`" — from the source text. Its
 * scope is the module that owns the hooks: a file importing
 * `plugin-test-helpers` is a file whose workspaces live under
 * `dist/ts/client-test-workspaces` (the `@natalia/testing` fixtures use a
 * different root with their own registry, and are not this guard's business).
 */
export type SourceFile = { path: string; text: string };

const IMPORTS_HELPERS =
  /(?:^|\n)\s*(?:import|export)[\s\S]{0,400}?from\s+["'][^"']*plugin-test-helpers["']/u;

/** True when the text imports the module that owns the cleanup hooks. */
export function importsTestWorkspaceHelpers(text: string): boolean {
  return IMPORTS_HELPERS.test(text);
}

/**
 * The calls that put a workspace under `dist/ts/client-test-workspaces`.
 */
export const WORKSPACE_CREATOR_CALLS = [
  "officialPluginWorkspace(",
  "createOfficialRuntimeClient(",
  "installFixturePlugin(",
] as const;

/** True when the text creates a workspace through those helpers. */
export function createsTestWorkspace(text: string): boolean {
  return WORKSPACE_CREATOR_CALLS.some((call) => text.includes(call));
}

/** True when the text registers the per-test remove and the per-file sweep. */
export function registersWorkspaceCleanup(text: string): boolean {
  return text.includes("useWorkspaceCleanup(");
}

/**
 * The files that create workspaces through the helpers without registering
 * their teardown, sorted by path so a failure message is stable between runs.
 */
export function workspaceCreatorFilesMissingCleanup(
  files: readonly SourceFile[],
): string[] {
  return files
    .filter(
      (file) =>
        importsTestWorkspaceHelpers(file.text) &&
        createsTestWorkspace(file.text) &&
        !registersWorkspaceCleanup(file.text),
    )
    .map((file) => file.path)
    .sort();
}
