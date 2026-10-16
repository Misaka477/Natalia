import { expect, test } from "bun:test";
import { defineService, ServiceDirectory } from "@anthelia/runtime-services";
import {
  createPluginInputBindings,
  sameInputData,
} from "../src/runtime/plugin-input-bindings";

type FakeInput = {
  workspaceRoot: string;
  remoteURLs: string[];
  read(): string;
};

const fakeInput = defineService<FakeInput>("test.plugin-input");

function directory() {
  const values = new Map<string, unknown>();
  const provides: string[] = [];
  return {
    values,
    provides,
    directory: new ServiceDirectory({
      provide: (id, value) => {
        provides.push(id);
        values.set(id, value);
        return () => {
          values.delete(id);
        };
      },
      get: <T>(id: string) => values.get(id) as T | undefined,
    }),
  };
}

test("two builds of one input's data are interchangeable, functions are read faces", () => {
  const left: FakeInput = {
    workspaceRoot: "/ws",
    remoteURLs: ["https://a", "https://b"],
    read: () => "left",
  };
  const right: FakeInput = {
    workspaceRoot: "/ws",
    remoteURLs: ["https://a", "https://b"],
    read: () => "right",
  };
  expect(sameInputData(left, right)).toBe(true);
  expect(sameInputData(left, { ...right, workspaceRoot: "/other" })).toBe(
    false,
  );
  expect(sameInputData(left, { ...right, remoteURLs: ["https://a"] })).toBe(
    false,
  );
  expect(sameInputData(left, { ...right, extra: 1 })).toBe(false);
  expect(sameInputData(undefined, undefined)).toBe(true);
  expect(sameInputData(left, undefined)).toBe(false);
  // A value the comparison cannot see inside (behaviour, not data) counts as
  // changed: the conservative answer keeps the rebind, never a stale binding.
  expect(sameInputData({ at: new Date(0) }, { at: new Date(0) })).toBe(false);
});

test("an equivalent rebuild keeps the binding already in place", () => {
  const { directory: dir, provides, values } = directory();
  const bindings = createPluginInputBindings(dir);
  const first: FakeInput = {
    workspaceRoot: "/ws",
    remoteURLs: ["https://a"],
    read: () => "first",
  };
  expect(bindings.rebind(fakeInput, first)).toBe(true);
  const second: FakeInput = {
    workspaceRoot: "/ws",
    remoteURLs: ["https://a"],
    read: () => "second",
  };
  // A config reload rebuilds the input object with new closures. Nothing the
  // plugin can observe changed, so the binding stays the very object it had:
  // no provide, no transient absence, no plugin re-arm.
  expect(bindings.rebind(fakeInput, second)).toBe(false);
  expect(provides).toEqual([fakeInput.id]);
  expect(values.get(fakeInput.id)).toBe(first);
});

test("a changed input is rebound, and a withdrawn input is unbound", () => {
  const { directory: dir, provides, values } = directory();
  const bindings = createPluginInputBindings(dir);
  const base: FakeInput = {
    workspaceRoot: "/ws",
    remoteURLs: ["https://a"],
    read: () => "base",
  };
  bindings.rebind(fakeInput, base);
  const changed: FakeInput = {
    workspaceRoot: "/ws",
    remoteURLs: ["https://b"],
    read: () => "changed",
  };
  expect(bindings.rebind(fakeInput, changed)).toBe(true);
  expect(provides).toEqual([fakeInput.id, fakeInput.id]);
  expect(values.get(fakeInput.id)).toBe(changed);

  // The plugin is disabled in the new config: the input it requires is gone, so
  // the absence is the point — that is what unloads it.
  expect(bindings.rebind(fakeInput, undefined)).toBe(true);
  expect(values.has(fakeInput.id)).toBe(false);
  expect(bindings.rebind(fakeInput, undefined)).toBe(false);
  expect(bindings.boundIDs()).toEqual([]);
});

test("disposeAll releases every binding once, in reverse order", () => {
  const { directory: dir, values } = directory();
  const bindings = createPluginInputBindings(dir);
  const second = defineService<FakeInput>("test.plugin-input-second");
  bindings.rebind(fakeInput, {
    workspaceRoot: "/ws",
    remoteURLs: [],
    read: () => "one",
  });
  bindings.rebind(second, {
    workspaceRoot: "/ws",
    remoteURLs: [],
    read: () => "two",
  });
  expect(bindings.boundIDs()).toEqual([fakeInput.id, second.id]);
  bindings.disposeAll();
  expect(values.size).toBe(0);
  expect(bindings.boundIDs()).toEqual([]);
  bindings.disposeAll();
  expect(values.size).toBe(0);
});
