/**
 * The first-use workspace is a fixed path under Documents, and deleting it is
 * remembered.
 *
 * The reference implementation settles this with the OS's own Documents
 * directory and a fixed leaf (`packages/api/workspace-controller/
 * src/default-directory.ts`); the rule this replaces is seeding the working
 * directory, which for a Start Menu launch IS the install directory — the
 * program tree became a workspace, and the uninstaller deleted the user's
 * sessions with it.
 */
import { expect, test } from "bun:test";
import {
  FIRST_USE_WORKSPACE_DIR_NAME,
  FIRST_USE_WORKSPACE_PARENT,
  documentsDirectory,
  firstUseWorkspaceDeclined,
  firstUseWorkspaceDeclinedPath,
  firstUseWorkspacePath,
} from "../src/first-use-workspace";

test("the first-use workspace is <Documents>/Natalia/default-workspace", () => {
  const path = firstUseWorkspacePath({
    os: "win32",
    env: { USERPROFILE: "C:\\Users\\demo" },
    exists: (candidate) => candidate === "C:\\Users\\demo\\Documents",
  });
  expect(path).toBe(
    `C:\\Users\\demo\\Documents\\${FIRST_USE_WORKSPACE_PARENT}\\${FIRST_USE_WORKSPACE_DIR_NAME}`,
  );
  // A POSIX host joins the same segments with its own separator.
  const posix = firstUseWorkspacePath({
    os: "linux",
    env: { HOME: "/home/demo" },
    exists: (candidate) => candidate === "/home/demo/Documents",
  });
  expect(posix).toBe("/home/demo/Documents/Natalia/default-workspace");
});

test("a redirected profile resolves through the OS answer, not the guess", () => {
  // OneDrive-redirected: the conventional path is absent and the OS knows the
  // real one. Adopting the guess would put the workspace where the user will
  // not find it.
  const redirected = documentsDirectory({
    os: "win32",
    env: { USERPROFILE: "C:\\Users\\demo" },
    exists: (candidate) => candidate === "C:\\Users\\demo\\OneDrive\\Documents",
    readSystemDocuments: () => "C:\\Users\\demo\\OneDrive\\Documents",
  });
  expect(redirected).toBe("C:\\Users\\demo\\OneDrive\\Documents");
});

test("a host with no Documents directory offers no path rather than cwd", () => {
  expect(
    firstUseWorkspacePath({ os: "linux", env: { HOME: "/home/demo" } }),
  ).toBeUndefined();
});

test("the refusal record is the home's own file", () => {
  const input = { os: "linux" as const, env: { HOME: "/home/demo" } };
  const marker = firstUseWorkspaceDeclinedPath(input);
  expect(marker.endsWith("first-use-workspace-declined")).toBe(true);
  expect(firstUseWorkspaceDeclined(input)).toBe(false);
  expect(
    firstUseWorkspaceDeclined({
      ...input,
      exists: (candidate) => candidate === marker,
    }),
  ).toBe(true);
});
