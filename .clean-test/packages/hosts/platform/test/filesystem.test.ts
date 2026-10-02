import { describe, expect, test } from "bun:test";
import { createSymlink, forceRemove, normalizeLinkTarget } from "../src/index";

describe("normalizeLinkTarget", () => {
  test("leaves a POSIX target untouched", () => {
    expect(normalizeLinkTarget("dir/target.txt", "linux")).toBe(
      "dir/target.txt",
    );
    expect(normalizeLinkTarget("../outside", "linux")).toBe("../outside");
    expect(normalizeLinkTarget("C:\\literal\\posix\\name", "linux")).toBe(
      "C:\\literal\\posix\\name",
    );
  });

  test("strips the Windows extended-length prefix and normalises separators", () => {
    expect(
      normalizeLinkTarget("\\\\?\\C:\\work\\dir\\target.txt", "win32"),
    ).toBe("C:/work/dir/target.txt");
    expect(normalizeLinkTarget("dir\\target.txt", "win32")).toBe(
      "dir/target.txt",
    );
  });
});

describe("createSymlink", () => {
  test("POSIX passes no link type, preserving the previous call", async () => {
    const calls: Array<[string, string, string | undefined]> = [];
    await createSymlink("dir/target.txt", "/work/link.txt", {
      os: "linux",
      targetIsDirectory: true,
      symlink: async (target, path, type) => {
        calls.push([target, path, type]);
      },
    });
    expect(calls).toEqual([["dir/target.txt", "/work/link.txt", undefined]]);
  });

  test("Windows requests a junction for a directory target", async () => {
    const calls: Array<[string, string, string | undefined]> = [];
    await createSymlink("dir", "C:\\work\\link", {
      os: "win32",
      targetIsDirectory: true,
      symlink: async (target, path, type) => {
        calls.push([target, path, type]);
      },
    });
    // A junction is the only directory link an unelevated Windows process can
    // create, and it also keeps the link a directory rather than a broken file.
    expect(calls).toEqual([["dir", "C:\\work\\link", "junction"]]);
  });

  test("Windows requests a file link for a file target", async () => {
    const calls: Array<[string, string, string | undefined]> = [];
    await createSymlink("dir\\target.txt", "C:\\work\\link.txt", {
      os: "win32",
      targetIsDirectory: false,
      symlink: async (target, path, type) => {
        calls.push([target, path, type]);
      },
    });
    expect(calls).toEqual([["dir\\target.txt", "C:\\work\\link.txt", "file"]]);
  });
});

describe("forceRemove", () => {
  test("POSIX removes once and never clears a mode", async () => {
    const removals: Array<{ path: string; recursive: boolean }> = [];
    let chmodCalls = 0;
    await forceRemove("/work/file.txt", {
      os: "linux",
      recursive: true,
      rm: async (path, options) => {
        removals.push({ path, recursive: options.recursive });
      },
      chmod: async () => {
        chmodCalls += 1;
      },
    });
    expect(removals).toEqual([{ path: "/work/file.txt", recursive: true }]);
    expect(chmodCalls).toBe(0);
  });

  test("POSIX propagates EPERM without retrying", async () => {
    let attempts = 0;
    const failure = Object.assign(new Error("denied"), { code: "EPERM" });
    await expect(
      forceRemove("/work/file.txt", {
        os: "linux",
        rm: async () => {
          attempts += 1;
          throw failure;
        },
      }),
    ).rejects.toThrow("denied");
    expect(attempts).toBe(1);
  });

  test("Windows clears the read-only attribute and retries once", async () => {
    let attempts = 0;
    const chmods: Array<[string, number]> = [];
    await forceRemove("C:\\work\\file.txt", {
      os: "win32",
      rm: async () => {
        attempts += 1;
        if (attempts === 1)
          throw Object.assign(new Error("denied"), { code: "EPERM" });
      },
      chmod: async (path, mode) => {
        chmods.push([path, mode]);
      },
    });
    expect(attempts).toBe(2);
    expect(chmods).toEqual([["C:\\work\\file.txt", 0o666]]);
  });

  // The retry ladder is 100+200+…+1000ms = 5.5s by design (a transient
  // lock gets a real chance to clear); the test budget must cover it.
  test("Windows retries transient lock failures then rethrows", async () => {
    let attempts = 0;
    await expect(
      forceRemove("C:\\work\\file.txt", {
        os: "win32",
        rm: async () => {
          attempts += 1;
          throw Object.assign(new Error("busy"), { code: "EBUSY" });
        },
      }),
    ).rejects.toThrow("busy");
    // EBUSY/EACCES are transient locks (a just-exited child or an in-flight
    // reader), so removal is retried with a backoff before giving up.
    expect(attempts).toBe(10);
  }, 15_000);
});
