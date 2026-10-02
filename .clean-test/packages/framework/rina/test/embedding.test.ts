import { expect, test } from "bun:test";
import {
  EMBEDDING_DIM,
  cosine,
  deserializeVector,
  embeddableText,
  embedText,
  serializeVector,
} from "../src/embedding";

/**
 * Phase 6's local embedding, as a contract: deterministic (the same text
 * embeds identically across calls), normalized (the dot is the cosine),
 * morphology-aware (shared n-grams beat shared nothing), and a stable
 * BLOB round trip. The vault's semantic lane rides exactly these four
 * properties.
 */

test("the embedding is deterministic and unit-norm", () => {
  const first = embedText("revert the database migration");
  const second = embedText("revert the database migration");
  expect([...first]).toEqual([...second]);
  let norm = 0;
  for (const value of first) norm += value * value;
  expect(Math.sqrt(norm)).toBeCloseTo(1, 5);
  expect(first).toHaveLength(EMBEDDING_DIM);
  // Empty text embeds to the zero vector, not a NaN field.
  const empty = embedText("   ");
  expect([...empty].every((value) => value === 0)).toBe(true);
});

test("morphology and paraphrase score above unrelated text", () => {
  const query = embedText("parser rejects the new syntax");
  const morphology = cosine(query, embedText("parsing rejected new syntax"));
  const paraphrase = cosine(
    query,
    embedText("the parser refuses the new grammar"),
  );
  const unrelated = cosine(query, embedText("rotate the TLS certificates"));
  expect(morphology).toBeGreaterThan(unrelated);
  expect(paraphrase).toBeGreaterThan(unrelated);
  // A record sharing no token with the query still lands above zero —
  // the lane FTS5 cannot offer.
  expect(paraphrase).toBeGreaterThan(0);
});

test("the entity key rides the embedded text", () => {
  expect(embeddableText("summary", "entity")).toBe("summary entity");
  expect(embeddableText("summary")).toBe("summary");
});

test("the BLOB round trip is exact, and a malformed column reads as zero", () => {
  const vector = embedText("a record worth recalling");
  const restored = deserializeVector(serializeVector(vector));
  expect([...restored]).toEqual([...vector]);
  expect(cosine(restored, vector)).toBeCloseTo(1, 5);
  const zero = deserializeVector(null);
  expect([...zero].every((value) => value === 0)).toBe(true);
  const short = deserializeVector(Buffer.alloc(4));
  expect([...short].every((value) => value === 0)).toBe(true);
});
