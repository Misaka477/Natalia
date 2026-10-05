import { expect, test } from "bun:test";
import {
  createBufferExporter,
  LogService,
  logService,
} from "@anthelia/logging";
import {
  startMemoryTraceSampler,
  stopMemoryTraceSampler,
} from "../src/memory-trace";

/**
 * The sampler's gate and its records both live in the level table now: the
 * name is the switch (`NATALIA_LOG=memory-trace=info`), and the probes assert
 * through the logging surface rather than console — the first version captured
 * `console.warn`, which stopped seeing anything the moment the sampler moved
 * to the named logger.
 */
test("the RSS sampler is a no-op unless the table admits it", () => {
  delete process.env.NATALIA_MEMORY_TRACE;
  const seen = createBufferExporter();
  const remove = logService.addExporter(seen);
  try {
    startMemoryTraceSampler();
    expect(seen.drain()).toEqual([]);
  } finally {
    remove();
    stopMemoryTraceSampler();
  }
});

test("the RSS sampler logs periodic samples when the table admits it", async () => {
  delete process.env.NATALIA_MEMORY_TRACE;
  process.env.NATALIA_LOG = "memory-trace=debug";
  const levels = {
    default: "error" as const,
    "memory-trace": "debug" as const,
  };
  logService.setLevels(levels);
  const seen = createBufferExporter();
  const remove = logService.addExporter(seen);
  process.env.NATALIA_MEMORY_TRACE_INTERVAL_MS = "200";
  try {
    startMemoryTraceSampler();
    await Bun.sleep(450);
    stopMemoryTraceSampler();
    const records = seen.drain();
    expect(records.length).toBeGreaterThan(0);
    expect(records.every((record) => record.name === "memory-trace")).toBe(
      true,
    );
    const rendered = new LogService().format({ maxLength: 10240 }, records[0]!);
    expect(rendered).toContain("rss.sample");
  } finally {
    remove();
    stopMemoryTraceSampler();
    delete process.env.NATALIA_MEMORY_TRACE_INTERVAL_MS;
    delete process.env.NATALIA_LOG;
    logService.setLevels({ default: "error" });
  }
});
