import { expect, test } from "bun:test";
import { createHash as nodeCreateHash } from "node:crypto";
import { createHash, sha256Bytes, sha256Hex } from "../src/content-hash";

/**
 * The pure sha256's pin: the suite cross-checks against node:crypto
 * itself. A drift between this implementation and the platform's hash is
 * red, not silent — the whole point of the module (five browser-graph
 * modules hash through it via the vite alias).
 */

test("the known FIPS vectors", () => {
  expect(sha256Hex("")).toBe(
    "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855",
  );
  expect(sha256Hex("abc")).toBe(
    "ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad",
  );
  // A multi-block input (the padding path with a non-zero high length word).
  expect(sha256Hex("a".repeat(1000))).toBe(
    "41edece42d63e8d9bf515a9ba6932e1c20cbc9f5a5d134645adb5db1b9737ea3",
  );
});

test("byte-for-byte identical to node:crypto across the corpus shapes", () => {
  // The shapes the graph actually hashes: the inbox's Chinese text, the
  // composition's canonical JSON, the store-path id, a package listing.
  const corpus: Array<string | Uint8Array> = [
    "",
    "abc",
    "回复完全相同的文本且不作其他输出：PONG-DEEPSEEK-OK",
    '{"policyRows":[],"schema":"1"}'.repeat(40),
    "/home/aquama/Development/Natalia_Project/natalia-cli",
    "x".repeat(55), // exactly one block minus padding
    "x".repeat(56), // exactly one block (forces a second, empty one)
    "x".repeat(64), // exactly one block
    "x".repeat(65), // one block plus a byte
    new Uint8Array([0, 1, 2, 255, 128, 64]),
  ];
  for (const input of corpus) {
    const expected =
      typeof input === "string"
        ? nodeCreateHash("sha256").update(input, "utf8").digest("hex")
        : nodeCreateHash("sha256").update(input).digest("hex");
    expect(sha256Hex(input)).toBe(expected);
  }
});

test("the createHash shim answers the exact shape the graph uses", () => {
  const digest = createHash("sha256")
    .update("prefix:")
    .update("body")
    .digest("hex");
  expect(digest).toBe(
    nodeCreateHash("sha256").update("prefix:body").digest("hex"),
  );
  // The bytes view agrees with the hex view.
  expect(sha256Hex("prefix:body")).toBe(digest);
  expect(sha256Bytes("abc")[0]).toBe(0xba);
});

test("the shim fails loud outside its surface", () => {
  expect(() => createHash("md5")).toThrow(/algorithm "md5"/u);
  expect(() => createHash("sha256").digest("base64" as "hex")).toThrow(
    /encoding "base64"/u,
  );
});
