/**
 * The one resolver every user-data location now goes through.
 *
 * The port had five global roots, and the rules below are the ones that make
 * one root sufficient: a blank environment value must mean UNSET (an empty
 * override that resolves to the working directory would silently write user
 * data wherever the process happened to start — which the install-directory
 * layout already did once, and the uninstaller then deleted the user's model
 * configuration), the default is the same on both platforms, and every child
 * location is derived rather than spelled.
 */
import { expect, test } from "bun:test";
import { homedir } from "node:os";
import { join, posix, win32 } from "node:path";
import {
  DEFAULT_NATALIA_HOME_DISPLAY,
  NATALIA_HOME_DIR_NAME,
  NATALIA_HOME_ENV,
  NATALIA_STORE_HOME_ENV,
  defaultNataliaHome,
  expandHomePath,
  legacyNataliaRoots,
  nataliaCachePath,
  nataliaHomeDisplay,
  nataliaHomePath,
  nataliaUserHome,
  resolveNataliaHome,
  usableDirectory,
} from "../src/home-paths";

const linux = { os: "linux" as const, env: { HOME: "/home/demo" } };
const windows = {
  os: "win32" as const,
  env: {
    USERPROFILE: "C:\\Users\\demo",
    APPDATA: "C:\\Users\\demo\\AppData\\Roaming",
  },
};

test("the default home is the same directory name on both platforms", () => {
  expect(NATALIA_HOME_DIR_NAME).toBe(".natalia");
  expect(DEFAULT_NATALIA_HOME_DISPLAY).toBe("~/.natalia");
  expect(defaultNataliaHome(linux)).toBe(posix.join("/home/demo", ".natalia"));
  expect(defaultNataliaHome(windows)).toBe(
    win32.join("C:\\Users\\demo", ".natalia"),
  );
  // No APPDATA/XDG branch: a per-platform rule is what produced five roots.
  expect(resolveNataliaHome(undefined, linux)).toBe(
    posix.join("/home/demo", ".natalia"),
  );
  expect(resolveNataliaHome(undefined, windows)).toBe(
    win32.join("C:\\Users\\demo", ".natalia"),
  );
});

test("an explicit path beats the environment, which beats the default", () => {
  const env = { HOME: "/home/demo", [NATALIA_HOME_ENV]: "/home/demo/from-env" };
  expect(resolveNataliaHome("/explicit/home", { os: "linux", env })).toBe(
    "/explicit/home",
  );
  expect(resolveNataliaHome(undefined, { os: "linux", env })).toBe(
    "/home/demo/from-env",
  );
  // The store's own switch is an alias: two switches for one root is how a
  // store and a config end up in different trees.
  expect(
    resolveNataliaHome(undefined, {
      os: "linux",
      env: { HOME: "/home/demo", [NATALIA_STORE_HOME_ENV]: "/home/demo/store" },
    }),
  ).toBe("/home/demo/store");
});

test("a blank override is unset, never the working directory", () => {
  // `resolve("")` is the cwd, so accepting an empty value would mean "write
  // user data wherever this process was started".
  for (const blank of ["", "   ", "\t"]) {
    expect(
      resolveNataliaHome(undefined, {
        os: "linux",
        env: { HOME: "/home/demo", [NATALIA_HOME_ENV]: blank },
      }),
    ).toBe(posix.join("/home/demo", ".natalia"));
    expect(
      resolveNataliaHome(undefined, {
        os: "linux",
        env: { HOME: "/home/demo", [NATALIA_STORE_HOME_ENV]: blank },
      }),
    ).toBe(posix.join("/home/demo", ".natalia"));
  }
});

test("a tilde in a configured path is a home, not a directory name", () => {
  expect(expandHomePath("~", linux)).toBe("/home/demo");
  expect(expandHomePath("~/env-natalia", linux)).toBe(
    posix.join("/home/demo", "env-natalia"),
  );
  expect(expandHomePath("~\\env-natalia", windows)).toBe(
    win32.join("C:\\Users\\demo", "env-natalia"),
  );
  expect(expandHomePath("/absolute", linux)).toBe("/absolute");
});

test("every child location is derived from the one home", () => {
  // Host-appropriate on purpose: `nataliaHomePath` resolves for the platform
  // this process is actually on, which is the only thing production calls it
  // with.
  const scoped = join(homedir(), "scoped-home");
  process.env[NATALIA_HOME_ENV] = scoped;
  try {
    expect(nataliaHomePath()).toBe(scoped);
    expect(nataliaHomePath("config.json")).toBe(join(scoped, "config.json"));
    expect(nataliaCachePath("context-window.json")).toBe(
      join(scoped, "cache", "context-window.json"),
    );
  } finally {
    delete process.env[NATALIA_HOME_ENV];
  }
  // Display never prints a machine path: it names the default symbolically
  // and anything else by the variable that set it.
  expect(nataliaHomeDisplay(defaultNataliaHome())).toBe("~/.natalia");
  expect(nataliaHomeDisplay("/somewhere/else")).toBe(`$${NATALIA_HOME_ENV}`);
});

test("the legacy roots are read candidates that exclude the live home", () => {
  const roots = legacyNataliaRoots(windows);
  const live = resolveNataliaHome(undefined, windows);
  expect(roots).not.toContain(live);
  // The two Windows roots the old code actually wrote, plus the `.config`
  // spellings a POSIX install used.
  expect(roots).toContain(
    win32.join("C:\\Users\\demo\\AppData\\Roaming", "natalia"),
  );
  expect(roots).toContain(
    win32.join("C:\\Users\\demo\\AppData\\Roaming", "natalia-cli"),
  );
  expect(roots).toContain(win32.join("C:\\Users\\demo", ".config", "natalia"));
  expect(roots).toContain(
    win32.join("C:\\Users\\demo", ".config", "natalia-cli"),
  );
  // Deduplicated by RESOLVED path: on POSIX the config home and `~/.config`
  // are the same directory, and listing it twice would be a lie about how many
  // places are searched.
  expect(new Set(roots).size).toBe(roots.length);
  expect(legacyNataliaRoots(linux)).toEqual([
    posix.join("/home/demo", ".config", "natalia"),
    posix.join("/home/demo", ".config", "natalia-cli"),
  ]);
});

test("the user home is read from the platform's own variable", () => {
  expect(nataliaUserHome(linux)).toBe("/home/demo");
  expect(nataliaUserHome(windows)).toBe("C:\\Users\\demo");
  // HOME alone is unset on Windows, which is why a resolver reading only HOME
  // threw there (packages/tooling/installer/src/update.ts).
  expect(nataliaUserHome({ os: "win32", env: {} })).toBe(homedir());
  expect(nataliaUserHome({ os: "linux", env: { HOME: "D:" } })).toBe(homedir());
});

test("a bare drive letter is refused as a directory", () => {
  expect(usableDirectory(["D:"], () => "fallback")).toBe("fallback");
  expect(usableDirectory([undefined, "C:\\real"], () => "fallback")).toBe(
    "C:\\real",
  );
});
