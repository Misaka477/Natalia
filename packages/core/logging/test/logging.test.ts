import { describe, expect, test } from "bun:test";
import {
  LogService,
  installDefaultLogExporter,
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
    // A wider table at the sink, without opening the process's verbosity.
    const loud = createBufferExporter(1000, { default: "debug" });
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

describe("installDefaultLogExporter", () => {
  test("an error reaches stderr with no NATALIA_LOG, info stays out", () => {
    const lines: string[] = [];
    const dispose = installDefaultLogExporter({
      write: (l) => lines.push(l),
      env: {},
    });
    getLogger("boot-test").error("the operator must see this");
    getLogger("boot-test").info("this one is diagnostic");
    dispose();
    expect(lines.join("\n")).toContain("the operator must see this");
    expect(lines.join("\n")).not.toContain("this one is diagnostic");
  });

  test("a second boot path reuses the install instead of double-printing", () => {
    const first: string[] = [];
    const dispose = installDefaultLogExporter({
      write: (l) => first.push(l),
      env: {},
    });
    const second: string[] = [];
    // The second call returns the LIVE installer's disposer and adds no sink.
    installDefaultLogExporter({ write: (l) => second.push(l), env: {} });
    getLogger("boot-test").error("printed once");
    dispose();
    expect(first.filter((l) => l.includes("printed once"))).toHaveLength(1);
    expect(second).toEqual([]);
  });

  test("NATALIA_LOG names a subsystem, and off keeps errors", () => {
    const lines: string[] = [];
    const dispose = installDefaultLogExporter({
      write: (l) => lines.push(l),
      env: { NATALIA_LOG: "boot-verbose=debug" },
    });
    getLogger("boot-verbose").debug("asked for by name");
    getLogger("boot-quiet").info("not asked for");
    dispose();
    expect(lines.join("\n")).toContain("asked for by name");
    expect(lines.join("\n")).not.toContain("not asked for");

    const quiet: string[] = [];
    const off = installDefaultLogExporter({
      write: (l) => quiet.push(l),
      env: { NATALIA_LOG: "off" },
    });
    getLogger("boot-test").warn("suppressed");
    getLogger("boot-test").error("but not this one");
    off();
    expect(quiet.join("\n")).not.toContain("suppressed");
    expect(quiet.join("\n")).toContain("but not this one");
  });
});
