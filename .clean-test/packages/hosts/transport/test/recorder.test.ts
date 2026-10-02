import { expect, test } from "bun:test";
import { mkdtemp } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { createRecordedFetch, readCassette } from "../src";

test("native TS cassette records redacted HTTP and replays deterministically", async () => {
  const root = await mkdtemp(join(tmpdir(), "natalia-recorder-"));
  const cassettePath = join(root, "provider.json");
  const recording = createRecordedFetch({
    cassettePath,
    mode: "record",
    fetch: async () =>
      Response.json({ token: "sk-live-very-secret-value", value: "recorded" }),
  });
  expect(
    await (
      await recording("https://provider.test/v1", {
        headers: { authorization: "Bearer sk-live-very-secret-value" },
      })
    ).json(),
  ).toMatchObject({ value: "recorded" });
  const cassette = await readCassette(cassettePath);
  expect(JSON.stringify(cassette)).not.toContain("sk-live-very-secret-value");
  const replay = createRecordedFetch({ cassettePath, mode: "replay" });
  expect(await (await replay("https://provider.test/v1")).json()).toMatchObject(
    { value: "recorded" },
  );
  await expect(replay("https://provider.test/other")).rejects.toThrow(
    "cassette exhausted",
  );
});
