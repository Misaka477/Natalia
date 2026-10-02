import { expect, test } from "bun:test";
import { createMemoryTransport } from "../src";

test("the memory transport reads and writes bytes by path", async () => {
  const files = new Map<string, Uint8Array>();
  const transport = createMemoryTransport(files);
  const payload = new TextEncoder().encode("hello");
  await transport.writeFile("notes.txt", payload);
  expect(await transport.readFile("notes.txt")).toEqual(payload);
  await expect(transport.readFile("missing.txt")).rejects.toThrow(
    "file not found: missing.txt",
  );
});
