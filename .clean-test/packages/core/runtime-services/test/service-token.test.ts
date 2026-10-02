import { expect, test } from "bun:test";
import {
  createTestContext,
  defineService,
  ServiceDirectory,
  type ServiceBindings,
  type ServiceToken,
} from "../src";

type FakeController = { ping(): string };

const controllerToken = defineService<FakeController>("fake.controller", {
  scope: "process",
  capability: "adapters",
});

const namedToken = defineService<{ name: string }>("fake.named");

test("defineService freezes the token and keeps the id as the wire name", () => {
  expect(controllerToken.id).toBe("fake.controller");
  expect(Object.isFrozen(controllerToken)).toBe(true);
  expect(Object.isFrozen(controllerToken.meta)).toBe(true);
  expect(controllerToken.meta.scope).toBe("process");
  expect(namedToken.meta).toEqual({});
});

test("defineService rejects an empty id and reserved composition namespaces", () => {
  expect(() => defineService("")).toThrow(/must not be empty/u);
  for (const id of [
    "anthelia.sandbox",
    "natalia.collaboration",
    "plugin:native-terminal",
    "facet:web",
  ])
    expect(() => defineService(id)).toThrow(/reserved prefix/u);
});

test("two definitions of one id denote the same service", () => {
  const first = defineService<FakeController>("fake.controller");
  const second = defineService<FakeController>("fake.controller");
  expect(first.id).toBe(second.id);
});

test("a directory resolves by token and fails loud on a missing service", () => {
  const directory = new ServiceDirectory({
    provide: () => () => {},
    get: <T>(id: string) =>
      id === "fake.controller" ? ({ ping: () => "pong" } as T) : undefined,
  });
  expect(directory.get(controllerToken).ping()).toBe("pong");
  expect(() => directory.get(namedToken)).toThrow(
    /service "fake.named" is not provided/u,
  );
});

test("provide binds through the bindings and the disposer unbinds", () => {
  const values = new Map<string, unknown>();
  const directory = new ServiceDirectory({
    provide: (id, value) => {
      values.set(id, value);
      return () => {
        values.delete(id);
      };
    },
    get: <T>(id: string) => values.get(id) as T | undefined,
  });
  const dispose = directory.provide(namedToken, { name: "bound" });
  expect(directory.get(namedToken).name).toBe("bound");
  dispose();
  expect(() => directory.get(namedToken)).toThrow(/is not provided/u);
});

test("getOptional resolves when present and returns undefined when not", () => {
  const ctx = createTestContext([namedToken.mock({ name: "here" })]);
  expect(ctx.getOptional(namedToken)?.name).toBe("here");
  expect(ctx.getOptional(controllerToken)).toBeUndefined();
});

test("createTestContext builds a directory from heterogeneous mocks", () => {
  const ctx = createTestContext([
    controllerToken.mock({ ping: () => "test-pong" }),
    namedToken.mock({ name: "mocked" }),
  ]);
  expect(ctx.get(controllerToken).ping()).toBe("test-pong");
  expect(ctx.get(namedToken).name).toBe("mocked");
});

test("createTestContext rejects a duplicate mock for one wire", () => {
  expect(() =>
    createTestContext([
      namedToken.mock({ name: "first" }),
      namedToken.mock({ name: "second" }),
    ]),
  ).toThrow(/duplicate test mock for service "fake.named"/u);
});

// Compile-time proof: the type flows from the token, no `<T>` at the call site.
test("the token type flows to consumers without a cast", () => {
  const ctx = createTestContext([
    controllerToken.mock({ ping: () => "typed" }),
  ]);
  const controller: FakeController = ctx.get(controllerToken);
  const alsoController = ctx.get<FakeController>(controllerToken);
  expect(controller.ping()).toBe("typed");
  expect(alsoController.ping()).toBe("typed");
  const asUnknown: ServiceToken<unknown> = controllerToken;
  expect(asUnknown.id).toBe("fake.controller");
});

// A bindings double that counts resolutions, proving the directory stays a thin seam.
test("the directory adds no resolution layer of its own", async () => {
  let gets = 0;
  const bindings: ServiceBindings = {
    provide: () => () => {},
    get: <T>(id: string) => {
      gets++;
      return id === "fake.controller"
        ? ({ ping: () => "counted" } as T)
        : undefined;
    },
  };
  const directory = new ServiceDirectory(bindings);
  directory.get(controllerToken);
  directory.get(controllerToken);
  expect(gets).toBe(2);
});

test("provide passes the token's declared scope to the bindings", () => {
  const scopes: (string | undefined)[] = [];
  const directory = new ServiceDirectory({
    provide: (_id, _value, scope) => {
      scopes.push(scope);
      return () => {};
    },
    get: <T>() => undefined as T | undefined,
  });
  directory.provide(controllerToken, { ping: () => "scoped" });
  directory.provide(namedToken, { name: "default-scope" });
  expect(scopes).toEqual(["process", undefined]);
});
