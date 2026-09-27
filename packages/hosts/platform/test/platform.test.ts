import { describe, expect, test } from "bun:test";
import { win32 } from "node:path";
import {
  LEGACY_STATE_DIR_NAMES,
  STATE_DIR_NAME,
  configureBashExecutable,
  detachedShellPrefix,
  executableName,
  globalConfigHome,
  isWindows,
  profileShellCommand,
  isolatedShellCommand,
  platformJoin,
  processTreeKillCommand,
  resolveBashExecutable,
  resolveStatePath,
  statePath,
  userRuntimeHome,
  userStateHome,
} from "../src/index";

const windowsEnv = {
  ProgramFiles: "C:\\Program Files",
  LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local",
  APPDATA: "C:\\Users\\demo\\AppData\\Roaming",
  USERPROFILE: "C:\\Users\\demo",
};

const gitBash = win32.join(windowsEnv.ProgramFiles, "Git", "bin", "bash.exe");

describe("platform identity", () => {
  test("reports the injected platform rather than the host", () => {
    expect(isWindows("win32")).toBe(true);
    expect(isWindows("linux")).toBe(false);
    expect(isWindows("darwin")).toBe(false);
  });

  test("joins with the target platform separator, not the host separator", () => {
    expect(platformJoin("win32", "C:\\Users\\demo", "AppData")).toBe(
      "C:\\Users\\demo\\AppData",
    );
    expect(platformJoin("linux", "/home/demo", ".config")).toBe(
      "/home/demo/.config",
    );
  });
});

describe("executableName", () => {
  test("leaves POSIX names untouched", () => {
    expect(executableName("wezterm-mux-server", "linux")).toBe(
      "wezterm-mux-server",
    );
  });

  test("appends the Windows suffix exactly once", () => {
    expect(executableName("wezterm-mux-server", "win32")).toBe(
      "wezterm-mux-server.exe",
    );
    expect(executableName("wezterm.exe", "win32")).toBe("wezterm.exe");
    expect(executableName("WEZTERM.EXE", "win32")).toBe("WEZTERM.EXE");
  });
});

describe("resolveBashExecutable", () => {
  test("is not consulted on POSIX", () => {
    expect(resolveBashExecutable({ os: "linux", env: {} })).toBeUndefined();
  });

  test("honours an explicit override on any platform", () => {
    expect(
      resolveBashExecutable({
        os: "linux",
        env: { NATALIA_BASH_EXECUTABLE: "/opt/bash" },
      }),
    ).toBe("/opt/bash");
  });

  test("discovers Git for Windows under Program Files", () => {
    const resolved = resolveBashExecutable({
      os: "win32",
      env: windowsEnv,
      exists: (path) => path === gitBash,
    });
    expect(resolved).toBe(gitBash);
  });

  test("falls back to the msys bash path", () => {
    const msys = win32.join(
      windowsEnv.ProgramFiles,
      "Git",
      "usr",
      "bin",
      "bash.exe",
    );
    expect(
      resolveBashExecutable({
        os: "win32",
        env: windowsEnv,
        exists: (path) => path === msys,
      }),
    ).toBe(msys);
  });

  test("discovers a per-user Git installation", () => {
    const perUser = win32.join(
      windowsEnv.LOCALAPPDATA,
      "Programs",
      "Git",
      "bin",
      "bash.exe",
    );
    expect(
      resolveBashExecutable({
        os: "win32",
        env: windowsEnv,
        exists: (path) => path === perUser,
      }),
    ).toBe(perUser);
  });

  test("returns undefined when no bash is installed", () => {
    expect(
      resolveBashExecutable({
        os: "win32",
        env: windowsEnv,
        exists: () => false,
      }),
    ).toBeUndefined();
  });
});

describe("profileShellCommand", () => {
  test("preserves the existing POSIX invocation", () => {
    expect(profileShellCommand("echo hi", { os: "linux", env: {} })).toEqual({
      executable: "bash",
      args: ["-lc", "echo hi"],
    });
  });

  test("preserves a call-site specific POSIX shell", () => {
    expect(
      profileShellCommand("echo hi", {
        os: "linux",
        env: {},
        posixShell: "/usr/bin/bash",
      }),
    ).toEqual({ executable: "/usr/bin/bash", args: ["-lc", "echo hi"] });
  });

  test("keeps identical arguments on Windows so quoting is unchanged", () => {
    const resolved = profileShellCommand("echo hi", {
      os: "win32",
      env: windowsEnv,
      exists: () => true,
    });
    expect(resolved.args).toEqual(["-lc", "echo hi"]);
    expect(resolved.executable.endsWith("bash.exe")).toBe(true);
  });

  test("fails loudly instead of silently switching to cmd.exe", () => {
    expect(() =>
      profileShellCommand("echo hi", {
        os: "win32",
        env: windowsEnv,
        exists: () => false,
      }),
    ).toThrow(/bash-compatible shell is unavailable/u);
  });
});

describe("isolatedShellCommand", () => {
  test("keeps the profile-free argument vector on both platforms", () => {
    expect(
      isolatedShellCommand("echo hi", { os: "linux", env: {} }).args,
    ).toEqual(["--noprofile", "--norc", "-c", "echo hi"]);
    expect(
      isolatedShellCommand("echo hi", {
        os: "win32",
        env: windowsEnv,
        exists: () => true,
      }).args,
    ).toEqual(["--noprofile", "--norc", "-c", "echo hi"]);
  });
});

describe("process lifetime", () => {
  test("keeps setsid on POSIX and drops it on Windows", () => {
    expect(detachedShellPrefix("linux")).toBe("setsid ");
    expect(detachedShellPrefix("win32")).toBe("");
  });

  test("only Windows needs an external tree-kill command", () => {
    expect(processTreeKillCommand(1234, "linux")).toBeUndefined();
    expect(processTreeKillCommand(1234, "win32")).toEqual({
      executable: "taskkill",
      args: ["/PID", "1234", "/T", "/F"],
    });
  });

  test("truncates a fractional pid", () => {
    expect(processTreeKillCommand(1234.7, "win32")?.args[1]).toBe("1234");
  });
});

describe("user directories", () => {
  test("reproduces the previous POSIX config root", () => {
    expect(globalConfigHome({ os: "linux", env: { HOME: "/home/demo" } })).toBe(
      "/home/demo/.config",
    );
  });

  test("does not let XDG_CONFIG_HOME change POSIX config resolution", () => {
    expect(
      globalConfigHome({
        os: "linux",
        env: { HOME: "/home/demo", XDG_CONFIG_HOME: "/elsewhere" },
      }),
    ).toBe("/home/demo/.config");
  });

  test("uses APPDATA on Windows", () => {
    expect(globalConfigHome({ os: "win32", env: windowsEnv })).toBe(
      windowsEnv.APPDATA,
    );
  });

  test("derives a Windows config root without APPDATA", () => {
    expect(
      globalConfigHome({
        os: "win32",
        env: { USERPROFILE: "C:\\Users\\demo" },
      }),
    ).toBe(win32.join("C:\\Users\\demo", "AppData", "Roaming"));
  });

  test("reproduces the previous POSIX state root", () => {
    expect(userStateHome({ os: "linux", env: { HOME: "/home/demo" } })).toBe(
      "/home/demo/.local/state",
    );
    expect(
      userStateHome({
        os: "linux",
        env: { HOME: "/home/demo", XDG_STATE_HOME: "/state" },
      }),
    ).toBe("/state");
  });

  test("uses LOCALAPPDATA on Windows", () => {
    expect(userStateHome({ os: "win32", env: windowsEnv })).toBe(
      windowsEnv.LOCALAPPDATA,
    );
  });

  test("reports the POSIX runtime directory only when present", () => {
    expect(
      userRuntimeHome({ os: "linux", env: { XDG_RUNTIME_DIR: "/run/user/1" } }),
    ).toBe("/run/user/1");
    expect(userRuntimeHome({ os: "linux", env: {} })).toBeUndefined();
  });

  test("uses a Windows local runtime root", () => {
    expect(userRuntimeHome({ os: "win32", env: windowsEnv })).toBe(
      windowsEnv.LOCALAPPDATA,
    );
    expect(userRuntimeHome({ os: "win32", env: { TEMP: "C:\\Temp" } })).toBe(
      "C:\\Temp",
    );
  });
});

describe("the configured bash path (the settings UI's Git Bash row)", () => {
  const gitBash = win32.join("C:\\Program Files", "Git", "bin", "bash.exe");
  const windowsEnv = {
    ProgramFiles: "C:\\Program Files",
    ProgramW6432: "C:\\Program Files",
    LOCALAPPDATA: "C:\\Users\\demo\\AppData\\Local",
    PATH: "C:\\Windows\\system32",
  };

  test("wins over every discovery — a Git installed anywhere is usable", () => {
    configureBashExecutable("D:\\tools\\Git\\bin\\bash.exe");
    try {
      expect(
        resolveBashExecutable({
          os: "win32",
          env: windowsEnv,
          exists: (path) => path === gitBash,
        }),
      ).toBe("D:\\tools\\Git\\bin\\bash.exe");
      // Even when the default roots would have found a bash.
      expect(resolveBashExecutable({ os: "win32", env: windowsEnv })).toBe(
        "D:\\tools\\Git\\bin\\bash.exe",
      );
    } finally {
      configureBashExecutable(undefined);
    }
  });

  test("is a Windows-only surface — POSIX never consults it", () => {
    configureBashExecutable("/some/where/bash");
    try {
      // The POSIX answer is the call site's own shell, never the setting.
      expect(resolveBashExecutable({ os: "linux", env: {} })).toBeUndefined();
    } finally {
      configureBashExecutable(undefined);
    }
  });

  test("the PATH's own bash.exe is discovered after the default roots", () => {
    expect(
      resolveBashExecutable({
        os: "win32",
        env: { ...windowsEnv, PATH: "D:\\portable\\git\\bin" },
        exists: (path) => path.endsWith("portable\\git\\bin\\bash.exe"),
      }),
    ).toBe(win32.join("D:\\portable\\git\\bin", "bash.exe"));
  });

  test("an empty or unset configuration restores discovery", () => {
    configureBashExecutable("   ");
    try {
      expect(
        resolveBashExecutable({
          os: "win32",
          env: windowsEnv,
          exists: (path) => path === gitBash,
        }),
      ).toBe(gitBash);
    } finally {
      configureBashExecutable(undefined);
    }
  });
});

describe("the state directory's live name and its legacy fallback", () => {
  test("writes go to the live name", () => {
    expect(statePath("/home/demo/.config", "config.json")).toBe(
      "/home/demo/.config/natalia/config.json",
    );
  });

  test("a reader prefers the live path", () => {
    const resolved = resolveStatePath(
      "/root",
      (path) => path === "/root/natalia/config.json",
      "config.json",
    );
    expect(resolved).toEqual({
      path: "/root/natalia/config.json",
      legacy: false,
    });
  });

  test("a reader falls back to the legacy location an existing install wrote", () => {
    const resolved = resolveStatePath(
      "/root",
      (path) => path === "/root/natalia-cli/config.json",
      "config.json",
    );
    expect(resolved).toEqual({
      path: "/root/natalia-cli/config.json",
      legacy: true,
    });
  });

  test("neither existing still answers with the live path, so writes land there", () => {
    const resolved = resolveStatePath("/root", () => false, "config.json");
    expect(resolved).toEqual({
      path: "/root/natalia/config.json",
      legacy: false,
    });
  });

  test("the legacy names are enumerable, and the live name is never among them", () => {
    const legacy: readonly string[] = LEGACY_STATE_DIR_NAMES;
    expect(legacy.includes(STATE_DIR_NAME)).toBe(false);
    const names: readonly string[] = LEGACY_STATE_DIR_NAMES;
    expect(names.includes("natalia-cli")).toBe(true);
  });
});
