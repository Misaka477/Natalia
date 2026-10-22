import { expect, test } from "bun:test";
import { CommandRegistry } from "../src/commands/registry";

const command = (id: string, title: string, keywords?: string[]) => ({
  id,
  title,
  keywords,
  run: () => {},
});

test("a registered command appears in the palette", () => {
  const registry = new CommandRegistry();
  const dispose = registry.register(command("shell.settings", "打开设置"));
  expect(registry.list().map((entry) => entry.id)).toEqual(["shell.settings"]);
  dispose();
  expect(registry.list()).toEqual([]);
});

test("a command id has one owner: a duplicate throws", () => {
  const registry = new CommandRegistry();
  registry.register(command("shell.settings", "打开设置"));
  expect(() => registry.register(command("shell.settings", "设置"))).toThrow(
    /already registered/,
  );
});

test("a command needs an id", () => {
  const registry = new CommandRegistry();
  expect(() => registry.register(command("", "无名"))).toThrow(/needs an id/);
});

test("the filter matches the title, the hint and the keywords", () => {
  const registry = new CommandRegistry();
  registry.register(command("shell.search", "搜索工作区", ["find", "grep"]));
  registry.register(command("shell.settings", "打开设置", ["preferences"]));
  expect(registry.search("搜索").map((entry) => entry.id)).toEqual([
    "shell.search",
  ]);
  expect(registry.search("grep").map((entry) => entry.id)).toEqual([
    "shell.search",
  ]);
  expect(registry.search("pref").map((entry) => entry.id)).toEqual([
    "shell.settings",
  ]);
  expect(registry.search("zzz")).toEqual([]);
  expect(registry.search("").length).toBe(2);
  expect(registry.search("  ").length).toBe(2);
});

test("a disposer is idempotent and only removes its own command", () => {
  const registry = new CommandRegistry();
  const first = command("a", "A");
  const dispose = registry.register(first);
  dispose();
  dispose();
  expect(registry.list()).toEqual([]);
  registry.register(command("a", "A2"));
  expect(registry.list().length).toBe(1);
});
