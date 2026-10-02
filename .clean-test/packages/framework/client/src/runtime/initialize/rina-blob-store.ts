import { rustCas } from "@anthelia/object-store";
import { mkdirSync } from "node:fs";
import { join } from "node:path";
import type { VaultBlobStore } from "@anthelia/rina";

/**
 * The object-store study's acceptance 5, the client-side adapter: RINA's
 * vault blobs (the semantic lane's vectors) stored in the content-
 * addressed store. The composition layer is where both worlds already
 * meet — the vault's constructor here, the ObjectStore beside it — so
 * the adapter needs no new package edge in either direction.
 *
 * The interface is SYNC (the vault's recall path's shape), which is why
 * the adapter rides rustCas's synchronous faces rather than the
 * ObjectStore's async ones: the id is the content hash, so a blob's
 * storage is idempotent by construction and needs no transaction.
 */
export function objectStoreVaultBlobStore(root: string): VaultBlobStore {
  const objectsRoot = join(root, "objects");
  mkdirSync(objectsRoot, { recursive: true });
  return {
    put(bytes: Uint8Array): string {
      return rustCas.put(objectsRoot, Buffer.from(bytes));
    },
    get(id: string): Uint8Array | undefined {
      if (!rustCas.has(objectsRoot, id)) return undefined;
      return new Uint8Array(rustCas.get(objectsRoot, id));
    },
  };
}
