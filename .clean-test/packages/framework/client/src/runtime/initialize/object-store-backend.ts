import type { CompositionProfile } from "@anthelia/composition";
import { OBJECTSTORE_COMPOSITION_ROW_ID } from "@anthelia/contracts";
import { configureObjectStoreBackend } from "@anthelia/object-store";

/**
 * Decision17 for the store backend, read from the composition row:
 * the code registers {typescript, rust}, the data binds one. Absence
 * (or `disabled`) = TypeScript, so a profile with no row behaves
 * exactly as before the seam existed. An unknown impl cannot arrive
 * from a loaded profile — the loader's fail-fast rejects it against
 * the registry's implIDs (§6.4, legal values named) — so one reaching
 * here means a hand-built profile and gets the same treatment: an
 * error, not a silent downgrade.
 */
export function objectStoreBackendFromProfile(
  profile: CompositionProfile | undefined,
): "typescript" | "rust" {
  const row = profile?.rows.find(
    (candidate) => candidate.id === OBJECTSTORE_COMPOSITION_ROW_ID,
  );
  if (!row || row.disabled) return "typescript";
  if (row.impl === "rust") return "rust";
  if (row.impl === "typescript") return "typescript";
  throw new Error(
    `composition row "${OBJECTSTORE_COMPOSITION_ROW_ID}" has impl ${JSON.stringify(row.impl)} (legal: typescript | rust)`,
  );
}

/** The wire's one line: apply the row's selection to the store
 * package (called with the freshly loaded profile at boot and at
 * every reload — the same breath as the profile provide). */
export function applyCompositionObjectStoreBackend(
  profile: CompositionProfile | undefined,
): void {
  configureObjectStoreBackend(objectStoreBackendFromProfile(profile));
}
