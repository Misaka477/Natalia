import { describe, expect, test } from "bun:test";
import {
  LogService,
  createBufferExporter,
  getLogger,
  logLevelsFromEnv,
  parseLogSpec,
} from "../src/index";

describe("parseLogSpec", () => {
  test("a bare level is the default table", () => {
    expect(parseLogSpec("debug")).toEqual({ default: "debug" });
  });

  test("name=level entries are per-name tables", () => {
    expect(parseLogSpec("runtime=debug, web=warn")).toEqual({
      runtime: "debug",
      web: "warn",
    });
  });

  test("an unparseable fragment is skipped, not fatal", () => {
    expect(parseLogSpec("runtime=chatty,pty=debug,,")).toEqual({
      pty: "debug",
    });
  });

  test("NATALIA_LOG unset means no table", () => {
    expect(logLevelsFromEnv({})).toBeUndefined();
    expect(logLevelsFromEnv({ NATALIA_LOG: "info" })).toEqual({
      default: "info",
    });
  });
});

describe("LogService", () => {
  test("the default table is silent below error", () => {
    const service = new LogService();
    const seen = createBufferExporter();
    service.addExporter(seen);
    const log = {
      name: "runtime",
      error: (f: string, ...a: unknown[]) =>
        service.emit("runtime", "error", [f, ...a]),
      info: (f: string, ...a: unknown[]) =>
        service.emit("runtime", "info", [f, ...a]),
      warn: (f: string, ...a: unknown[]) =>
        service.emit("runtime", "warn", [f, ...a]),
      debug: (f: string, ...a: unknown[]) =>
        service.emit("runtime", "debug", [f, ...a]),
    };
    log.info("filtered");
    expect(seen.drain()).toEqual([]);
    log.error("kept");
    expect(seen.drain()).toHaveLength(1);
  });

  test("the per-name table decides, and the exporter's own table overrides", () => {
    const service = new LogService();
    service.setLevels({ runtime: "error", web: "debug" });
    expect(service.thresholdFor("web")).toBe(3);
    const quiet = createBufferExporter();
    service.addExporter(quiet);
    const loud = createBufferExporter();
    loud.levels = { default: "debug" };
    service.addExporter(loud);
    service.emit("runtime", "info", ["x"]);
    expect(quiet.drain()).toEqual([]);
    expect(loud.drain()).toHaveLength(1);
  });

  test("printf formatting, and an Error renders its cause chain", () => {
    const service = new LogService();
    const seen = createBufferExporter();
    service.addExporter(seen);
    const cause = new Error("the body said unknown method: session.status");
    const error = new Error("rpc failed", { cause });
    service.emit("transport", "error", [
      "turn failed: %s (%d)",
      error.message,
      400,
    ]);
    const [message] = seen.drain();
    const text = service.format({ maxLength: 10240 }, message);
    expect(text).toContain("turn failed: rpc failed (400)");
    service.emit("transport", "error", [error]);
    const [second] = seen.drain();
    const rendered = service.format({ maxLength: 10240 }, second);
    expect(rendered).toContain("rpc failed");
    // The chain is what this is FOR: the 400's body text reaches the log,
    // not just the kind. (The cause renders via its stack, so assert the
    // message rather than one exact prefix.)
    expect(rendered).toContain("caused by:");
    expect(rendered).toContain("unknown method: session.status");
  });

  test("a long line truncates at the exporter's maxLength", () => {
    const service = new LogService();
    const seen = createBufferExporter();
    service.addExporter(seen);
    service.emit("transport", "error", ["%s", "x".repeat(200)]);
    const [message] = seen.drain();
    const text = service.format({ maxLength: 10 }, message);
    expect(text).toBe(`${"x".repeat(10)}...`);
  });

  test("getLogger routes through the shared service", () => {
    const log = getLogger("getlogger-smoke");
    expect(log.name).toBe("getlogger-smoke");
    expect(() => log.error("no exporter, no throw")).not.toThrow();
  });
});
