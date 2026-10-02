import { expect, test } from "bun:test";
import { foregroundProcessForTTY, parseProcessStat } from "../src";

const stat = (input: {
  pid: number;
  name: string;
  tty: number;
  foregroundGroup: number;
}) =>
  `${input.pid} (${input.name}) S 1 ${input.pid} ${input.pid} ${input.tty} ${input.foregroundGroup} 4194304 0 0 0 0`;

function io(input: {
  device?: number | undefined;
  processes: Array<{
    pid: number;
    name: string;
    tty: number;
    foregroundGroup: number;
  }>;
  unreadable?: number[];
}) {
  return {
    os: "linux" as NodeJS.Platform,
    deviceNumber: () => input.device ?? 1035,
    processIDs: () => input.processes.map((process) => process.pid),
    processStat: (pid: number) =>
      input.unreadable?.includes(pid)
        ? undefined
        : stat(input.processes.find((process) => process.pid === pid)!),
  };
}

test("a process stat line survives a command name with spaces and parentheses", () => {
  expect(
    parseProcessStat("42 (my (odd) program) S 1 42 42 1035 77 4194304 0"),
  ).toEqual({
    pid: 42,
    name: "my (odd) program",
    tty: 1035,
    foregroundGroup: 77,
  });
  expect(parseProcessStat("nonsense")).toBeUndefined();
  expect(parseProcessStat("42 (bash) S")).toBeUndefined();
});

test("the foreground program of a tty is read from the process table", () => {
  const probe = foregroundProcessForTTY(
    "/dev/pts/3",
    io({
      processes: [
        { pid: 100, name: "bash", tty: 1035, foregroundGroup: 200 },
        { pid: 200, name: "vim", tty: 1035, foregroundGroup: 200 },
        { pid: 300, name: "unrelated", tty: 0, foregroundGroup: -1 },
      ],
    }),
  );
  expect(probe).toEqual({
    supported: true,
    process: { pid: 200, name: "vim" },
  });
});

test("a shell in the foreground reports the shell itself", () => {
  expect(
    foregroundProcessForTTY(
      "/dev/pts/3",
      io({
        processes: [
          { pid: 100, name: "bash", tty: 1035, foregroundGroup: 100 },
        ],
      }),
    ),
  ).toEqual({ supported: true, process: { pid: 100, name: "bash" } });
});

test("an unconfirmable foreground never masquerades as a known program", () => {
  // The group leader exists but cannot be read.
  expect(
    foregroundProcessForTTY(
      "/dev/pts/3",
      io({
        processes: [
          { pid: 100, name: "bash", tty: 1035, foregroundGroup: 200 },
          { pid: 200, name: "vim", tty: 1035, foregroundGroup: 200 },
        ],
        unreadable: [200],
      }),
    ),
  ).toMatchObject({ supported: false });
  // No process is attached to the tty at all.
  expect(
    foregroundProcessForTTY(
      "/dev/pts/3",
      io({
        processes: [
          { pid: 300, name: "unrelated", tty: 7, foregroundGroup: 300 },
        ],
      }),
    ),
  ).toEqual({ supported: true, process: undefined });
  expect(
    foregroundProcessForTTY("/dev/pts/3", {
      os: "linux",
      deviceNumber: () => undefined,
    }),
  ).toMatchObject({ supported: false, reason: expect.stringContaining("tty") });
  expect(foregroundProcessForTTY("", { os: "linux" })).toMatchObject({
    supported: false,
  });
});

test("platforms without a process table report unsupported instead of guessing", () => {
  for (const os of ["win32", "darwin"] as NodeJS.Platform[])
    expect(foregroundProcessForTTY("/dev/pts/3", { os })).toMatchObject({
      supported: false,
      reason: expect.stringContaining(os),
    });
});
