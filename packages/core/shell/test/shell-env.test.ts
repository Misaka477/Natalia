import { describe, expect, test } from "bun:test";

import {
  NATALIA_HOME_ENV,
  NATALIA_SESSION_ID_ENV,
  NATALIA_SHELL_ENV,
  ShellEnvRegistry,
  applyShellEnv,
} from "../src/shell-env";

/**
 * The managed shell environment.
 *
 * The behaviour that matters is not that a registry can hold values — it is that a
 * harness-owned fact reaches a command that the allowlist would have filtered out,
 * and that nothing can displace it. So the tests below are about the merge order and
 * about what is refused, not about storage.
 */
describe("ShellEnvRegistry", () => {
  test("the built-in facts are always present", () => {
    const registry = new ShellEnvRegistry("/natalia");
    const env = registry.collect({});
    expect(env[NATALIA_HOME_ENV]).toBe("/natalia");
    expect(env[NATALIA_SHELL_ENV]).toBe("1");
    // Absent rather than a placeholder: a command reading it must be able to tell
    // "no session" from "this session".
    expect(NATALIA_SESSION_ID_ENV in env).toBe(false);
  });

  test("the session id rides along when there is a session", () => {
    const registry = new ShellEnvRegistry("/natalia");
    expect(
      registry.collect({ sessionID: "ses_1" })[NATALIA_SESSION_ID_ENV],
    ).toBe("ses_1");
  });

  test("a contributor's declared keys arrive", () => {
    const registry = new ShellEnvRegistry("/natalia");
    registry.register({
      name: "browser",
      variables: { NATALIA_BRIDGE_PORT: { description: "the bridge's port" } },
      resolve: () => ({ NATALIA_BRIDGE_PORT: "9222" }),
    });
    expect(registry.collect({}).NATALIA_BRIDGE_PORT).toBe("9222");
  });

  test("two contributors cannot own the same key", () => {
    const registry = new ShellEnvRegistry("/natalia");
    registry.register({
      name: "first",
      variables: { NATALIA_BRIDGE_PORT: { description: "port" } },
      resolve: () => ({}),
    });
    expect(() =>
      registry.register({
        name: "second",
        variables: { NATALIA_BRIDGE_PORT: { description: "port" } },
        resolve: () => ({}),
      }),
    ).toThrow(/already owned by "first"/);
  });

  test("a reserved key cannot be contributed", () => {
    const registry = new ShellEnvRegistry("/natalia");
    expect(() =>
      registry.register({
        name: "hijack",
        variables: { [NATALIA_HOME_ENV]: { description: "my own home" } },
        resolve: () => ({}),
      }),
    ).toThrow(/reserved/);
  });

  test("a key outside the namespace is refused", () => {
    const registry = new ShellEnvRegistry("/natalia");
    expect(() =>
      registry.register({
        name: "outsider",
        variables: { PATH: { description: "the search path" } },
        resolve: () => ({}),
      }),
    ).toThrow(/outside the NATALIA_ namespace/);
  });

  test("an undescribed key is refused, because it cannot be audited", () => {
    const registry = new ShellEnvRegistry("/natalia");
    expect(() =>
      registry.register({
        name: "terse",
        variables: { NATALIA_THING: { description: "   " } },
        resolve: () => ({}),
      }),
    ).toThrow(/must be described/);
  });

  test("returning an undeclared key is an error at execution, not silence", () => {
    const registry = new ShellEnvRegistry("/natalia");
    registry.register({
      name: "sloppy",
      variables: { NATALIA_DECLARED: { description: "declared" } },
      // eslint-disable-next-line
      resolve: () => ({ NATALIA_UNDECLARED: "x" }) as never,
    });
    expect(() => registry.collect({})).toThrow(/undeclared key/);
  });

  test("the snapshot does not depend on the order contributors registered", () => {
    // The property that matters: `collect` visits contributors by sorted name, so a
    // command's environment is the same whether a plugin loaded first or second.
    // Registering in one order and asserting equality with itself would pass even
    // with the sort removed, so the two registries below are built in OPPOSITE orders.
    const snapshot = (reverse: boolean) => {
      const registry = new ShellEnvRegistry("/natalia");
      const add = [
        () =>
          registry.register({
            name: "zeta",
            variables: { NATALIA_Z: { description: "z" } },
            resolve: () => ({ NATALIA_Z: "1" }),
          }),
        () =>
          registry.register({
            name: "alpha",
            variables: { NATALIA_A: { description: "a" } },
            resolve: () => ({ NATALIA_A: "2" }),
          }),
      ];
      for (const registerOne of reverse ? add.reverse() : add) registerOne();
      return registry.collect({});
    };
    // Every key, built-ins included, is sorted — so the order is alphabetical and a
    // reader must not expect "built-ins first".
    expect(Object.keys(snapshot(false))).toEqual([
      "NATALIA_A",
      NATALIA_HOME_ENV,
      NATALIA_SHELL_ENV,
      "NATALIA_Z",
    ]);
    expect(Object.entries(snapshot(true))).toEqual(
      Object.entries(snapshot(false)),
    );
  });

  test("the snapshot is frozen", () => {
    const registry = new ShellEnvRegistry("/natalia");
    expect(Object.isFrozen(registry.collect({}))).toBe(true);
  });

  test("list enumerates declarations without running a resolver", () => {
    const registry = new ShellEnvRegistry("/natalia");
    let resolved = 0;
    registry.register({
      name: "counting",
      variables: { NATALIA_COUNTED: { description: "a side effect" } },
      resolve: () => {
        resolved += 1;
        return { NATALIA_COUNTED: String(resolved) };
      },
    });
    expect(registry.list()).toEqual([
      {
        contributor: "counting",
        description: "a side effect",
        key: "NATALIA_COUNTED",
      },
    ]);
    // Diagnostics must not be able to advance the thing they report on.
    expect(resolved).toBe(0);
  });

  test("registration is disposable", () => {
    const registry = new ShellEnvRegistry("/natalia");
    const dispose = registry.register({
      name: "temporary",
      variables: { NATALIA_TEMP: { description: "goes away" } },
      resolve: () => ({ NATALIA_TEMP: "1" }),
    });
    expect(registry.collect({}).NATALIA_TEMP).toBe("1");
    dispose();
    expect(registry.collect({}).NATALIA_TEMP).toBeUndefined();
    // And the key is free again, so a replacement can take it.
    registry.register({
      name: "replacement",
      variables: { NATALIA_TEMP: { description: "mine now" } },
      resolve: () => ({ NATALIA_TEMP: "2" }),
    });
    expect(registry.collect({}).NATALIA_TEMP).toBe("2");
  });
});

/**
 * `applyShellEnv` is where the gap this module exists to close actually closes, so
 * the merge order is asserted directly rather than through a spawn.
 */
describe("applyShellEnv", () => {
  test("an ambient managed value is dropped, not inherited", () => {
    const merged = applyShellEnv(
      { NATALIA_HOME: "/wherever/this/process/started", PATH: "/usr/bin" },
      { NATALIA_HOME: "/natalia", NATALIA_SHELL: "1" },
    );
    expect(merged!.NATALIA_HOME).toBe("/natalia");
    // The caller's ordinary entries survive.
    expect(merged!.PATH).toBe("/usr/bin");
  });

  test("a caller cannot displace a managed fact", () => {
    const merged = applyShellEnv(
      { NATALIA_HOME: "/callers/choice" },
      { NATALIA_HOME: "/natalia" },
    );
    expect(merged!.NATALIA_HOME).toBe("/natalia");
  });

  test("a caller's own NATALIA_ entry survives, because it is not an ambient leak", () => {
    // This test asserted the opposite until the implementation changed. A caller
    // naming `NATALIA_PROBE_VAR` through the allowlist is deliberate, not an ambient
    // value leaking from the harness process — and dropping it took away a caller's
    // ability to use their own namespace. What the managed layer guarantees is only
    // that a MANAGED key wins, which the previous test covers.
    const merged = applyShellEnv(
      { NATALIA_PROBE_VAR: "mine", PATH: "/bin" },
      undefined,
    );
    expect(merged!.NATALIA_PROBE_VAR).toBe("mine");
  });

  test("an absent environment and an absent snapshot stay absent", () => {
    // ABSENT, not an empty object. `spawn(env: {})` inherits nothing, so returning
    // keys here would take PATH away from every command run without an explicit env
    // — a regression an existing test caught on the first attempt at this.
    expect(applyShellEnv(undefined, undefined)).toBeUndefined();
    // One side present is enough to have an environment at all.
    expect(applyShellEnv({ PATH: "/bin" }, undefined)).toEqual({
      PATH: "/bin",
    });
    expect(applyShellEnv(undefined, { NATALIA_SHELL: "1" })).toEqual({
      NATALIA_SHELL: "1",
    });
  });
});
