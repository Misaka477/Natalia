/**
 * The cache fabric (RINA study: an engine-level cache for memory AND
 * computation — retrieval is not always needed, and neither is recompute).
 *
 * Three design laws from the study are structural here, not advisory:
 *
 * 1. **Cacheability is an explicit classification.** A kind may only register
 *    with `deterministic: true` — the literal type makes the decision
 *    compile-time, so an unclassified kind cannot enter the registry at all.
 * 2. **A hit carries evidence; invalidation is hash/epoch, never a TTL.**
 *    Path-scoped kinds capture evidence at compute time and revalidate it
 *    before every hit (the file's own size + mtime as recorded by the fs);
 *    tree-scoped kinds are dropped on any workspace write — no guessing
 *    when something "should" expire. A hit that is actually stale is a
 *    correctness bug, which is worse than a miss.
 * 3. *(Speculation never persists — applies to the speculative tier, not
 *    to this primitive.)*
 *
 * The journal/cache boundary from the study holds: entries here are derived
 * heat that can always be thrown away; nothing factual lives only in a
 * cache entry.
 */

/** How a kind learns that its entries are no longer true. */
export type CacheInvalidationMode = "path" | "tree";

/** Path-scoped evidence: every capture must name the path it describes. */
export interface PathEvidence {
  path: string;
  [field: string]: unknown;
}

export interface CacheKindDefinition {
  readonly id: string;
  /** Law 1: only explicitly classified deterministic work may register. */
  readonly deterministic: true;
  /**
   * `path` kinds are dropped per written path and additionally revalidate
   * their evidence on every hit (external writers are seen by the stat);
   * `tree` kinds are dropped entirely on any workspace write — their
   * results describe the whole tree and cannot be checked cheaply.
   */
  readonly invalidation: CacheInvalidationMode;
  /**
   * Captured once when an entry is stored, re-checked before every hit.
   * Both hooks or neither; a capture without a validator would freeze a
   * value forever (the TTL sin in another shape).
   */
  readonly captureEvidence?: (key: string) => unknown | Promise<unknown>;
  readonly validEvidence?: (
    evidence: unknown,
    key: string,
  ) => boolean | Promise<boolean>;
  /** How much budget an entry costs; strings count their UTF-8 bytes. */
  readonly sizeOf?: (value: unknown) => number;
}

export interface CacheKindMetrics {
  hits: number;
  misses: number;
  invalidations: number;
  evictions: number;
  entries: number;
  bytes: number;
  /** Bytes of value served from cache instead of being recomputed. */
  bytesServed: number;
}

export interface CacheFabric {
  registerKind(kind: CacheKindDefinition): void;
  hasKind(kindID: string): boolean;
  /**
   * Drop a kind and every entry it holds. The ownership discipline: the
   * plugin port's `registerKind` disposer calls this, so a plugin's kind
   * dies with the plugin (a kind whose definition unloaded with the
   * plugin would otherwise keep answering under a definition nobody
   * maintains). Engine kinds are safe from it: a duplicate id cannot be
   * registered by a plugin in the first place. Returns the dropped count.
   */
  unregisterKind(kindID: string): number;
  /**
   * Look up `key`, else run `compute` once (single-flight: concurrent
   * callers of the same slot share one computation). Unknown kinds throw —
   * silently running through an unclassified kind would make law 1
   * decorative.
   */
  compute<T>(
    kindID: string,
    key: string,
    compute: () => T | Promise<T>,
  ): Promise<T>;
  /** Workspace write hook: path kinds drop what changed, tree kinds drop all. */
  invalidatePaths(paths: readonly string[]): number;
  /** An opaque workspace writer finished (e.g. a shell command): drop trees. */
  markTreeChanged(): number;
  /** Per-kind cost observability (hits/misses/bytes), the study's platform principle. */
  metrics(kindID?: string): Record<string, CacheKindMetrics>;
  /**
   * §6.6(b) / law 2 — "组成换→缓存整体失效": point the fabric at a new
   * composition hash. Returns how many entries it dropped: every entry
   * carries the generation it was computed under (the key's scope
   * component, kept as a field because the slot format parses kind\0key
   * internally), so an old-composition entry can never answer a new one
   * — and the sweep removes them now instead of waiting for budget
   * eviction. Pending in-flight computes keep serving THEIR original
   * awaiters but may not store into the new scope.
   */
  setGeneration(hash: string): number;
}

interface Entry {
  value: unknown;
  evidence: unknown;
  size: number;
  /** The composition hash this value was computed under (§6.6(b)). */
  generation: string;
}

function defaultSizeOf(value: unknown): number {
  if (typeof value === "string") return Buffer.byteLength(value, "utf8");
  if (value instanceof Buffer) return value.byteLength;
  try {
    return JSON.stringify(value)?.length ?? 0;
  } catch {
    return 0;
  }
}

export interface CacheFabricOptions {
  /** Budget for stored values; the least-recently-used leave first. */
  maxBytes?: number;
  /**
   * The composition hash the entries are scoped to (§6.6(b)). Absent =
   * the genesis epoch ("0"): the wiring passes the profile's hash at
   * boot and re-points on every reload, so law 2 holds from the first
   * entry.
   */
  generation?: string;
}

/** 64 MiB of cached value heat: bounded so a long session cannot leak. */
export const DEFAULT_CACHE_MAX_BYTES = 64 * 1024 * 1024;

export function createCacheFabric(options: CacheFabricOptions = {}) {
  const maxBytes = options.maxBytes ?? DEFAULT_CACHE_MAX_BYTES;
  const kinds = new Map<string, CacheKindDefinition>();
  const store = new Map<string, Entry>();
  const inflight = new Map<string, Promise<unknown>>();
  const stats = new Map<string, CacheKindMetrics>();
  let totalBytes = 0;
  let currentGeneration = options.generation ?? "0";

  function freshMetrics(): CacheKindMetrics {
    return {
      hits: 0,
      misses: 0,
      invalidations: 0,
      evictions: 0,
      entries: 0,
      bytes: 0,
      bytesServed: 0,
    };
  }

  function slot(kindID: string, key: string): string {
    return `${kindID}\u0000${key}`;
  }

  function kindOf(id: string): string {
    return id.slice(0, id.indexOf("\u0000"));
  }

  function metricsFor(kindID: string): CacheKindMetrics {
    let record = stats.get(kindID);
    if (!record) {
      record = freshMetrics();
      stats.set(kindID, record);
    }
    return record;
  }

  function recount(kindID: string): void {
    const record = metricsFor(kindID);
    let entries = 0;
    let bytes = 0;
    const prefix = `${kindID}\u0000`;
    for (const [id, entry] of store) {
      if (id.startsWith(prefix)) {
        entries += 1;
        bytes += entry.size;
      }
    }
    record.entries = entries;
    record.bytes = bytes;
  }

  function drop(kindID: string, id: string): void {
    const entry = store.get(id);
    if (!entry) return;
    store.delete(id);
    inflight.delete(id);
    totalBytes -= entry.size;
    metricsFor(kindID).invalidations += 1;
    recount(kindID);
  }

  function evictOverBudget(): void {
    while (totalBytes > maxBytes && store.size > 0) {
      // Map iteration order is insertion order, and hits re-insert, so the
      // first key is the least recently used.
      const oldest = store.keys().next();
      if (oldest.done) return;
      const id = oldest.value;
      drop(kindOf(id), id);
      const record = metricsFor(kindOf(id));
      record.invalidations -= 1;
      record.evictions += 1;
    }
  }

  const fabric: CacheFabric = {
    registerKind(kind) {
      if (kinds.has(kind.id))
        throw new Error(`duplicate cache kind: ${kind.id}`);
      if (Boolean(kind.captureEvidence) !== Boolean(kind.validEvidence))
        throw new Error(
          `cache kind "${kind.id}" must capture and validate evidence together (a capture without a validator freezes values forever)`,
        );
      if (kind.invalidation === "path" && !kind.captureEvidence)
        throw new Error(
          `cache kind "${kind.id}" is path-scoped but captures no path evidence — a written file would stay hot`,
        );
      kinds.set(kind.id, kind);
      metricsFor(kind.id);
    },

    hasKind(kindID) {
      return kinds.has(kindID);
    },

    unregisterKind(kindID) {
      if (!kinds.has(kindID)) return 0;
      const prefix = `${kindID}\u0000`;
      const ids = [...store.keys()].filter((id) => id.startsWith(prefix));
      for (const id of ids) drop(kindID, id);
      kinds.delete(kindID);
      // The kind's record leaves with it: a disposed plugin's kind must
      // not linger in the metrics surface answering with zeros.
      stats.delete(kindID);
      return ids.length;
    },

    setGeneration(hash) {
      const previous = currentGeneration;
      currentGeneration = hash;
      // In-flight computes keep serving their awaiters; drop them from
      // the single-flight index so the new scope computes fresh.
      inflight.clear();
      if (previous === hash) return 0;
      let dropped = 0;
      for (const id of [...store.keys()]) {
        const entry = store.get(id);
        if (entry && entry.generation !== hash) {
          drop(kindOf(id), id);
          dropped += 1;
        }
      }
      return dropped;
    },

    async compute(kindID, key, compute) {
      const kind = kinds.get(kindID);
      if (!kind)
        throw new Error(
          `unknown cache kind: ${kindID} (kinds must be registered and classified before use)`,
        );
      const id = slot(kindID, key);
      const record = metricsFor(kindID);
      const existing = store.get(id);
      if (existing && existing.generation !== currentGeneration) {
        // Law 2, the hit guard: an entry computed under another
        // composition can never answer — dropped (an invalidation),
        // then the miss path recomputes under the CURRENT generation.
        drop(kindID, id);
      }
      const stored = store.get(id);
      if (stored) {
        const existing = stored;
        let valid = true;
        if (kind.validEvidence) {
          try {
            valid = await kind.validEvidence(existing.evidence, key);
          } catch {
            // A validator that cannot answer is a negative answer: without
            // proof the entry is not a hit.
            valid = false;
          }
        }
        if (valid) {
          // Re-insert: this refreshes the entry's LRU position.
          store.delete(id);
          store.set(id, existing);
          record.hits += 1;
          record.bytesServed += existing.size;
          return existing.value as never;
        }
        // Stale evidence is a miss, not an invalidation: nothing wrote
        // through the hooks, the file simply moved on underneath.
        drop(kindID, id);
        record.invalidations -= 1;
      }
      record.misses += 1;
      const flight = inflight.get(id);
      if (flight) return flight as Promise<never>;
      // The work starts on the NEXT microtask, so `inflight.set` below
      // always precedes any settle: a compute that throws synchronously
      // used to delete its own slot before it was registered, parking a
      // permanently rejected promise where later callers would find it.
      const scopeGeneration = currentGeneration;
      const run = Promise.resolve()
        .then(() => compute())
        .then((value) => {
          const size = (kind.sizeOf ?? defaultSizeOf)(value);
          inflight.delete(id);
          if (size <= maxBytes) {
            // Storing is best-effort AFTER the value exists: an evidence
            // capture that fails (a path the kind cannot stat) means there
            // is no proof for a future hit, so nothing is stored — but the
            // computation's value still returns. A cache never gets to fail
            // work that already succeeded.
            return Promise.resolve()
              .then(() =>
                kind.captureEvidence ? kind.captureEvidence(key) : undefined,
              )
              .then(
                (evidence) => {
                  // A composition switch mid-compute: the value answers
                  // its ORIGINAL caller, but nothing computed under the
                  // old scope stores into the new one.
                  if (scopeGeneration !== currentGeneration) return;
                  store.set(id, {
                    value,
                    evidence,
                    size,
                    generation: scopeGeneration,
                  });
                  totalBytes += size;
                  recount(kindID);
                  evictOverBudget();
                },
                () => undefined,
              )
              .then(() => value);
          }
          return value;
        })
        .catch((error: unknown) => {
          inflight.delete(id);
          throw error;
        }) as Promise<never>;
      inflight.set(id, run);
      return run;
    },

    invalidatePaths(paths) {
      const written = new Set(paths);
      let dropped = 0;
      for (const id of [...store.keys()]) {
        const kindID = kindOf(id);
        const kind = kinds.get(kindID);
        if (!kind) continue;
        if (kind.invalidation === "tree") {
          // Any workspace write can change a listing or a search result.
          drop(kindID, id);
          dropped += 1;
          continue;
        }
        const evidence = store.get(id)?.evidence as PathEvidence | undefined;
        if (evidence?.path && written.has(evidence.path)) {
          drop(kindID, id);
          dropped += 1;
        }
      }
      return dropped;
    },

    markTreeChanged() {
      let dropped = 0;
      for (const id of [...store.keys()]) {
        const kindID = kindOf(id);
        if (kinds.get(kindID)?.invalidation === "tree") {
          drop(kindID, id);
          dropped += 1;
        }
      }
      return dropped;
    },

    metrics(kindID) {
      if (kindID) return { [kindID]: { ...metricsFor(kindID) } };
      const all: Record<string, CacheKindMetrics> = {};
      for (const id of kinds.keys()) all[id] = { ...metricsFor(id) };
      for (const [id, record] of stats)
        if (!(id in all)) all[id] = { ...record };
      return all;
    },
  };

  return fabric;
}
