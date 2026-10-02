/**
 * Phase 6's local embedding: a deterministic, zero-dependency vector for
 * the vault's semantic recall lane (rina-cache study Phase 6: "本地
 * embedding + vector index；semantic + BM25 + entity 融合").
 *
 * What this is NOT: a neural embedding. There is no model file, no ONNX
 * runtime, no network — the study's core principle 6 ("no external
 * service dependency") rules those out for the engine, and Phase 10's
 * acceptance is "runs Phases 0/1 without external services". A hashed
 * n-gram vector is the honest local representation: character n-grams
 * catch morphology (parser/parsing/parsed share grams), word unigrams+bigrams
 * catch topicality, and the hashing is stable — the same text always
 * embeds to the same vector, in this process and in the next one.
 *
 * What it buys: a record whose summary shares no token with the query
 * ("roll back the schema migration" ~ "revert the database change") still
 * reaches the fusion through the semantic lane, which FTS5's bm25 can
 * never offer. The fusion decides how much that is worth (the study
 * prescribes the signals; the coefficients are ours, once, in the vault).
 *
 * Cost: dim 512 × 4 bytes = 2KB per record — bounded by the vault's own
 * size, and the scan is linear over the scoped rows (the vault is
 * per-workspace, thousands of rows; a cosine per row is microseconds).
 */

/** The vector dimension: 512 hashed features, a power of two for tidy math. */
export const EMBEDDING_DIM = 512;

/** One record's text: the summary is the identity; the entity key rides. */
export function embeddableText(summary: string, entityKey?: string): string {
  return entityKey ? `${summary} ${entityKey}` : summary;
}

/**
 * The embedding: L2-normalized counts over hashed character n-grams
 * (3–4) and word n-grams (1–2). Normalization makes the dot product the
 * cosine, so one operation serves both store and compare.
 */
export function embedText(text: string): Float32Array {
  const vector = new Float32Array(EMBEDDING_DIM);
  const normalized = text.toLowerCase().replace(/\s+/gu, " ").trim();
  if (!normalized) return vector;

  // Word n-grams (1-2): the topicality lane.
  const words = normalized.split(/[^a-z0-9_]+/u).filter(Boolean);
  for (const word of words) bump(vector, `w:${word}`, 1);
  for (let index = 0; index + 1 < words.length; index += 1)
    bump(vector, `b:${words[index]} ${words[index + 1]}`, 1);

  // Character n-grams (3-4) over the whole normalized string, word
  // boundaries included as separators: the morphology lane.
  const chars = ` ${normalized} `;
  for (let index = 0; index < chars.length; index += 1) {
    for (const size of [3, 4]) {
      if (index + size > chars.length) break;
      bump(vector, `c:${chars.slice(index, index + size)}`, 1);
    }
  }
  return normalize(vector);
}

/** Cosine over two (possibly unnormalized) vectors; 0 for empty input. */
export function cosine(left: Float32Array, right: Float32Array): number {
  let dot = 0;
  let leftNorm = 0;
  let rightNorm = 0;
  for (let index = 0; index < Math.min(left.length, right.length); index += 1) {
    dot += left[index]! * right[index]!;
    leftNorm += left[index]! * left[index]!;
    rightNorm += right[index]! * right[index]!;
  }
  if (leftNorm === 0 || rightNorm === 0) return 0;
  return dot / (Math.sqrt(leftNorm) * Math.sqrt(rightNorm));
}

/** The BLOB form for SQLite: a Float32Array's raw little-endian bytes. */
export function serializeVector(vector: Float32Array): Buffer {
  return Buffer.from(vector.buffer, vector.byteOffset, vector.byteLength);
}

/** The BLOB back to a vector; a malformed column reads as the zero vector. */
export function deserializeVector(
  blob: Buffer | Uint8Array | null,
): Float32Array {
  if (!blob || blob.byteLength !== EMBEDDING_DIM * 4)
    return new Float32Array(EMBEDDING_DIM);
  return new Float32Array(blob.buffer, blob.byteOffset, EMBEDDING_DIM).slice();
}

function bump(vector: Float32Array, feature: string, weight: number): void {
  // FNV-1a over the feature name: stable across processes, no crypto
  // import needed, and the bucket collisions average out over a
  // normalized count vector.
  let hash = 0x811c9dc5;
  for (let index = 0; index < feature.length; index += 1) {
    hash ^= feature.charCodeAt(index);
    hash = Math.imul(hash, 0x01000193);
  }
  vector[(hash >>> 0) % EMBEDDING_DIM]! += weight;
}

function normalize(vector: Float32Array): Float32Array {
  let norm = 0;
  for (const value of vector) norm += value * value;
  if (norm === 0) return vector;
  const scale = 1 / Math.sqrt(norm);
  for (let index = 0; index < vector.length; index += 1)
    vector[index] = vector[index]! * scale;
  return vector;
}
