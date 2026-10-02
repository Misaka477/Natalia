/**
 * A pure sha256 for contexts that cannot reach `node:crypto`.
 *
 * Why this exists: five modules in the browser graph hashed with
 * `node:crypto` (session's inbox facts, the composition profile, the
 * plugin package hash, the store-path id, the hash-tree). Vite
 * externalizes node builtins for the browser, and a NAMED import from
 * the external stub is a hard build failure — `"createHash" is not
 * exported by "__vite-browser-external"` — which is how the web build
 * broke. The vite config aliases `node:crypto` here, so those modules
 * keep their import shape and the browser gets a real hash.
 *
 * The algorithm is FIPS 180-4 sha256, and its pin is `content-hash.test.ts`:
 * the suite cross-checks every case against node:crypto itself (the test
 * runs in a node runtime), so a drift between this and the platform's
 * hash is red, not silent. Deterministic work gets a deterministic hash —
 * the same discipline every other content-addressed surface here has.
 */

const ROUND_CONSTANTS = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1,
  0x923f82a4, 0xab1c5ed5, 0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3,
  0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174, 0xe49b69c1, 0xefbe4786,
  0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147,
  0x06ca6351, 0x14292967, 0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13,
  0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85, 0xa2bfe8a1, 0xa81a664b,
  0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a,
  0x5b9cca4f, 0x682e6ff3, 0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208,
  0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
]);

const INITIAL_STATE = new Uint32Array([
  0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c,
  0x1f83d9ab, 0x5be0cd19,
]);

const BLOCK_BYTES = 64;

/** The utf-8 bytes of a string, or the bytes as given. */
function toBytes(input: string | Uint8Array): Uint8Array {
  if (typeof input === "string") return new TextEncoder().encode(input);
  return input;
}

/** The sha256 digest of `input`, raw. Pure; no allocation beyond the work. */
export function sha256Bytes(input: string | Uint8Array): Uint8Array {
  const message = toBytes(input);
  const bitLength = message.length * 8;
  // Pad to a multiple of 64 with 0x80, zeros, and the 64-bit big-endian
  // length (the high word is 0 below 2^32 bits — the browser's inputs).
  const paddedLength =
    Math.ceil((message.length + 9) / BLOCK_BYTES) * BLOCK_BYTES;
  const padded = new Uint8Array(paddedLength);
  padded.set(message);
  padded[message.length] = 0x80;
  const view = new DataView(padded.buffer);
  view.setUint32(paddedLength - 8, Math.floor(bitLength / 0x100000000));
  view.setUint32(paddedLength - 4, bitLength >>> 0);

  const state = INITIAL_STATE.slice();
  const schedule = new Uint32Array(64);
  for (let block = 0; block < paddedLength; block += BLOCK_BYTES) {
    for (let index = 0; index < 16; index += 1)
      schedule[index] = view.getUint32(block + index * 4);
    for (let index = 16; index < 64; index += 1) {
      const w15 = schedule[index - 15]!;
      const w2 = schedule[index - 2]!;
      const s0 =
        ((w15 >>> 7) | (w15 << 25)) ^
        ((w15 >>> 18) | (w15 << 14)) ^
        (w15 >>> 3);
      const s1 =
        ((w2 >>> 17) | (w2 << 15)) ^ ((w2 >>> 19) | (w2 << 13)) ^ (w2 >>> 10);
      schedule[index] =
        (schedule[index - 16]! + s0 + schedule[index - 7]! + s1) >>> 0;
    }
    let a = state[0]!;
    let b = state[1]!;
    let c = state[2]!;
    let d = state[3]!;
    let e = state[4]!;
    let f = state[5]!;
    let g = state[6]!;
    let h = state[7]!;
    for (let index = 0; index < 64; index += 1) {
      const s1 =
        ((e >>> 6) | (e << 26)) ^
        ((e >>> 11) | (e << 21)) ^
        ((e >>> 25) | (e << 7));
      const ch = (e & f) ^ (~e & g);
      const temp1 =
        (h + s1 + ch + ROUND_CONSTANTS[index]! + schedule[index]!) >>> 0;
      const s0 =
        ((a >>> 2) | (a << 30)) ^
        ((a >>> 13) | (a << 19)) ^
        ((a >>> 22) | (a << 10));
      const maj = (a & b) ^ (a & c) ^ (b & c);
      const temp2 = (s0 + maj) >>> 0;
      h = g;
      g = f;
      f = e;
      e = (d + temp1) >>> 0;
      d = c;
      c = b;
      b = a;
      a = (temp1 + temp2) >>> 0;
    }
    state[0] = (state[0]! + a) >>> 0;
    state[1] = (state[1]! + b) >>> 0;
    state[2] = (state[2]! + c) >>> 0;
    state[3] = (state[3]! + d) >>> 0;
    state[4] = (state[4]! + e) >>> 0;
    state[5] = (state[5]! + f) >>> 0;
    state[6] = (state[6]! + g) >>> 0;
    state[7] = (state[7]! + h) >>> 0;
  }

  const digest = new Uint8Array(32);
  const digestView = new DataView(digest.buffer);
  for (let index = 0; index < 8; index += 1)
    digestView.setUint32(index * 4, state[index]!);
  return digest;
}

/** The lowercase hex digest — the shape every caller here wants. */
export function sha256Hex(input: string | Uint8Array): string {
  return [...sha256Bytes(input)]
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

/**
 * The `node:crypto` surface the browser-graph modules actually use:
 * `createHash("sha256").update(text).digest("hex")`. Anything other than
 * sha256 fails loud — a browser needing md5 has a different problem.
 */
export function createHash(algorithm: string) {
  if (algorithm !== "sha256")
    throw new Error(
      `content-hash: algorithm "${algorithm}" is not available in the browser build (sha256 only)`,
    );
  const parts: Uint8Array[] = [];
  return {
    update(chunk: string | Uint8Array) {
      parts.push(toBytes(chunk));
      return this;
    },
    digest(encoding: "hex") {
      const total = parts.reduce((sum, part) => sum + part.length, 0);
      const joined = new Uint8Array(total);
      let offset = 0;
      for (const part of parts) {
        joined.set(part, offset);
        offset += part.length;
      }
      if (encoding !== "hex")
        throw new Error(
          `content-hash: encoding "${encoding}" is not available in the browser build (hex only)`,
        );
      return sha256Hex(joined);
    },
  };
}
