import { expect, test } from "bun:test";
import {
  COMMON_NS,
  FALLBACK_LOCALE,
  LOCALE_PREFERENCE_KEY,
  LocaleRuntime,
  detectBrowserLocale,
  isLocaleId,
} from "../src/locale/runtime";

/** A preference store double that records writes and can push changes. */
function fakeHost(initial?: unknown) {
  const values = new Map<string, unknown>();
  if (initial !== undefined) values.set(LOCALE_PREFERENCE_KEY, initial);
  const listeners = new Set<(key: string, value: unknown) => void>();
  return {
    get<T>(key: string) {
      return values.get(key) as T | undefined;
    },
    set(key: string, value: unknown) {
      values.set(key, value);
      for (const listener of [...listeners]) listener(key, value);
    },
    subscribe(listener: (key: string, value: unknown) => void) {
      listeners.add(listener);
      return () => {
        listeners.delete(listener);
      };
    },
    values,
  };
}

test("the shell dictionaries resolve through the common namespace", () => {
  const runtime = new LocaleRuntime();
  runtime.register(COMMON_NS, {
    "zh-CN": { "common.ok": "确定" },
    en: { "common.ok": "OK" },
  });
  expect(runtime.t("common.ok")).toBe("确定");
  runtime.setLocale("en");
  expect(runtime.t("common.ok")).toBe("OK");
});

test("a missing key falls back to the key itself, never to silence", () => {
  const runtime = new LocaleRuntime();
  runtime.register(COMMON_NS, { "zh-CN": { a: "甲" }, en: { a: "A" } });
  expect(runtime.t("nope")).toBe("nope");
});

test("english falls back to the zh source of truth per key", () => {
  const runtime = new LocaleRuntime();
  runtime.register(COMMON_NS, {
    "zh-CN": { a: "甲", b: "乙" },
    en: { a: "A" },
  });
  runtime.setLocale("en");
  expect(runtime.t("a")).toBe("A");
  // b is absent from en, so the chain reaches zh-CN.
  expect(runtime.t("b")).toBe("乙");
  expect(FALLBACK_LOCALE).toBe("zh-CN");
});

test("a plugin namespace falls back to the common vocabulary", () => {
  const runtime = new LocaleRuntime();
  runtime.register(COMMON_NS, {
    "zh-CN": { "common.ok": "确定" },
    en: { "common.ok": "OK" },
  });
  runtime.register("mcp", {
    "zh-CN": { "mcp.title": "MCP" },
    en: { "mcp.title": "MCP" },
  });
  const t = runtime.bind("mcp");
  expect(t("mcp.title")).toBe("MCP");
  expect(t("common.ok")).toBe("确定");
  runtime.setLocale("en");
  expect(t("common.ok")).toBe("OK");
});

test("interpolation replaces named placeholders", () => {
  const runtime = new LocaleRuntime();
  runtime.register(COMMON_NS, {
    "zh-CN": { "sidebar.selectedCount": "已选 {count} 项" },
    en: { "sidebar.selectedCount": "{count} selected" },
  });
  expect(runtime.t("sidebar.selectedCount", { count: 3 })).toBe("已选 3 项");
  runtime.setLocale("en");
  expect(runtime.t("sidebar.selectedCount", { count: 3 })).toBe("3 selected");
  // An unknown placeholder stays literal.
  expect(runtime.t("sidebar.selectedCount", { other: 1 })).toBe(
    "{count} selected",
  );
});

test("a namespace's texts have one owner: a duplicate registration throws", () => {
  const runtime = new LocaleRuntime();
  runtime.register("mcp", { "zh-CN": { a: "甲" }, en: { a: "A" } });
  expect(() =>
    runtime.register("mcp", { "zh-CN": { a: "甲" }, en: { a: "A" } }),
  ).toThrow(/already has locale/);
});

test("registration returns an idempotent disposer", () => {
  const runtime = new LocaleRuntime();
  runtime.register(COMMON_NS, { "zh-CN": { a: "甲" }, en: { a: "A" } });
  const dispose = runtime.register("mcp", {
    "zh-CN": { "mcp.only": "甲" },
    en: { "mcp.only": "A" },
  });
  expect(runtime.bind("mcp")("mcp.only")).toBe("甲");
  dispose();
  dispose();
  // The namespace's own dictionary is gone; the key is not in common, so
  // the lookup ends at the key itself.
  expect(runtime.bind("mcp")("mcp.only")).toBe("mcp.only");
});

test("a switch writes the preference, bumps the revision and notifies", () => {
  const host = fakeHost();
  const runtime = new LocaleRuntime(host);
  runtime.register(COMMON_NS, { "zh-CN": { a: "甲" }, en: { a: "A" } });
  let notified = 0;
  runtime.subscribe(() => {
    notified += 1;
  });
  const before = runtime.getLocale().revision;
  runtime.setLocale("en");
  expect(host.values.get(LOCALE_PREFERENCE_KEY)).toBe("en");
  expect(runtime.getLocale().active).toBe("en");
  expect(runtime.getLocale().revision).toBeGreaterThan(before);
  expect(notified).toBe(1);
});

test("an unknown locale id throws at the boundary", () => {
  const runtime = new LocaleRuntime();
  expect(() => runtime.setLocale("fr")).toThrow(/not registered/);
  expect(isLocaleId("en")).toBe(true);
  expect(isLocaleId("fr")).toBe(false);
});

test("the stored preference wins over the browser language", () => {
  const runtime = new LocaleRuntime(fakeHost("en"));
  runtime.register(COMMON_NS, { "zh-CN": { a: "甲" }, en: { a: "A" } });
  expect(runtime.getLocale().active).toBe("en");
});

test("an external preference change is adopted without a write-back", () => {
  const host = fakeHost();
  const runtime = new LocaleRuntime(host);
  runtime.register(COMMON_NS, { "zh-CN": { a: "甲" }, en: { a: "A" } });
  host.set(LOCALE_PREFERENCE_KEY, "en");
  expect(runtime.getLocale().active).toBe("en");
});

test("browser detection prefers an exact regional match", () => {
  expect(detectBrowserLocale(["en-US", "zh-CN"])).toBe("en");
  expect(detectBrowserLocale(["zh-CN", "en"])).toBe("zh-CN");
  expect(detectBrowserLocale(["ja-JP"])).toBeUndefined();
  expect(detectBrowserLocale(undefined)).toBeUndefined();
});

test("one throwing subscriber does not strand the rest", () => {
  const runtime = new LocaleRuntime();
  runtime.register(COMMON_NS, { "zh-CN": { a: "甲" }, en: { a: "A" } });
  let second = 0;
  runtime.subscribe(() => {
    throw new Error("boom");
  });
  runtime.subscribe(() => {
    second += 1;
  });
  const errors: unknown[] = [];
  const original = console.error;
  console.error = (...args: unknown[]) => errors.push(args);
  try {
    runtime.setLocale("en");
  } finally {
    console.error = original;
  }
  expect(second).toBe(1);
});

test("dynamic language pack registration discovers new locales and ensureRegistered is idempotent", () => {
  const runtime = new LocaleRuntime();
  runtime.defineLocale({ id: "ja", label: "日本語" });
  runtime.ensureRegistered("terminal", {
    "zh-CN": { title: "终端" },
    en: { title: "Terminal" },
    ja: { title: "ターミナル" },
  });
  // Calling ensureRegistered again on plugin remount does not throw.
  runtime.ensureRegistered("terminal", {
    "zh-CN": { title: "终端" },
    en: { title: "Terminal" },
    ja: { title: "ターミナル" },
  });
  expect(runtime.getLocale().locales.map((l) => l.id)).toContain("ja");
  runtime.setLocale("ja");
  expect(runtime.bind("terminal")("title")).toBe("ターミナル");
});
