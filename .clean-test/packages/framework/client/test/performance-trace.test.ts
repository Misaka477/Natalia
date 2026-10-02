import { expect, test } from "bun:test";
import { mkdtemp, readFile } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { RuntimePerformanceTrace } from "@anthelia/substrate";

test("writes bounded aggregate samples without retaining event payloads", async () => {
  const directory = await mkdtemp(join(tmpdir(), "natalia-perf-trace-"));
  const destination = join(directory, "trace.jsonl");
  const trace = new RuntimePerformanceTrace({ destination });
  trace.record(
    {
      type: "diagnostic",
      level: "info",
      message: "terminal payload must not be retained here",
    },
    { publishMs: 2, sinkMs: 1, pluginMs: 0.5 },
  );
  await trace.stop();
  const sample = JSON.parse(await readFile(destination, "utf8")) as {
    events: Record<string, number>;
    memory: { rss: number; arrayBuffers: number };
  };
  expect(sample.events.diagnostic).toBe(1);
  expect(sample.memory.rss).toBeGreaterThan(0);
  expect(sample.memory.arrayBuffers).toBeGreaterThanOrEqual(0);
});
