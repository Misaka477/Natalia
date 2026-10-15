/**
 * The first-use workspace: where it is, and whether the user has refused one.
 *
 * The shell used to seed `process.cwd()` as the default workspace, which for a
 * Start Menu launch is the INSTALL directory — so the install tree became a
 * workspace and its `<workspace>/.natalia` (object store, checkpoints, session
 * records) sat inside the tree the uninstaller deletes. The reference
 * implementation settles this with a fixed path under the OS Documents
 * directory (`packages/api/workspace-controller/src/default-directory.ts`:
 * `<Documents>/deepseek-harness/default-workspace`), resolved from the OS
 * rather than from the working directory. This is the same rule for Natalia:
 * `<Documents>/Natalia/default-workspace`, one installation, one path, whatever
 * the process was started from.
 *
 * Documents is asked for in order of what can be VERIFIED, not assumed:
 * `%USERPROFILE%\Documents` on Windows is the usual answer but a redirected
 * (OneDrive) profile does not have it, and the OS API knows the difference.
 * `xdg-user-dir DOCUMENTS` is the POSIX answer, absent on machines without
 * xdg-user-dirs. Only when a candidate EXISTS is it used; otherwise the next
 * one is asked, and the last resort is `<user home>/Documents`, created by the
 * caller. Never the working directory — that is the whole point.
 */
import {
  nataliaHomeJoin,
  nataliaUserHome,
  type NataliaHomeInput,
} from "./home-paths";

/** The directory the first-use workspace lives under, inside Documents. */
export const FIRST_USE_WORKSPACE_PARENT = "Natalia";

/** The fixed leaf name of the first-use workspace. */
export const FIRST_USE_WORKSPACE_DIR_NAME = "default-workspace";

/**
 * The file that records "the user deleted the first-use workspace".
 *
 * The rule the user set: deleting it disables automatic creation from then on.
 * A flag file in the one home is the whole record — no registry entry, no
 * config key, and nothing a later launch can re-derive into "they probably
 * want one".
 */
export const FIRST_USE_WORKSPACE_DECLINED_FILE = "first-use-workspace-declined";

export type DocumentsDirectoryInput = NataliaHomeInput & {
  /** An explicit Documents directory; no lookup at all when it is given. */
  override?: string;
  /** Whether a candidate directory exists. Injectable so both branches test. */
  exists?: (path: string) => boolean;
  /** Runs `xdg-user-dir DOCUMENTS`; injectable for the same reason. */
  readXdgDocuments?: () => string | undefined;
  /** Reads the OS Documents folder (the Windows answer, redirect-aware). */
  readSystemDocuments?: () => string | undefined;
};

/** Path separator and joining for the platform being asked about. */
function joinFor(input: NataliaHomeInput, ...segments: string[]): string {
  return (input.os ?? process.platform) === "win32"
    ? [segments[0], ...segments.slice(1)].join("\\")
    : segments.join("/");
}

function clean(value: string | undefined): string | undefined {
  const text = value?.trim().replace(/[\r\n]+$/u, "");
  return text ? text : undefined;
}

/**
 * The OS Documents directory, or undefined when no candidate exists.
 *
 * Every candidate is verified before it is returned: a redirected Windows
 * profile has no `%USERPROFILE%\Documents`, and XDG reports the HOME directory
 * when the user directory is disabled — adopting either would put the
 * first-use workspace somewhere the user will not find it.
 */
export function documentsDirectory(
  input: DocumentsDirectoryInput = {},
): string | undefined {
  const platform = input.os ?? process.platform;
  const override = clean(input.override);
  if (override) return override;
  const exists = input.exists ?? (() => false);
  const home = nataliaUserHome(input);
  const conventional = joinFor(input, home, "Documents");
  if (exists(conventional)) return conventional;
  const xdg =
    platform === "win32"
      ? undefined
      : clean(input.readXdgDocuments?.() ?? undefined);
  if (xdg && xdg !== home && exists(xdg)) return xdg;
  const system =
    platform === "win32"
      ? clean(input.readSystemDocuments?.() ?? undefined)
      : undefined;
  if (system && exists(system)) return system;
  return undefined;
}

/** `<Documents>/Natalia/default-workspace`, or undefined with no Documents. */
export function firstUseWorkspacePath(
  input: DocumentsDirectoryInput = {},
): string | undefined {
  const documents = documentsDirectory(input);
  if (!documents) return undefined;
  // Joined with the platform ASKED ABOUT, not the host running the question:
  // the same rule the home's own joiner states, and the one a test catches by
  // asking about Linux from Windows.
  return joinFor(
    input,
    documents,
    FIRST_USE_WORKSPACE_PARENT,
    FIRST_USE_WORKSPACE_DIR_NAME,
  );
}

/** Whether the user has deleted the first-use workspace. */
export function firstUseWorkspaceDeclined(
  input: NataliaHomeInput & { exists?: (path: string) => boolean } = {},
): boolean {
  return (input.exists ?? (() => false))(
    nataliaHomeJoin(input, FIRST_USE_WORKSPACE_DECLINED_FILE),
  );
}

/** The path of the flag file, for the code that writes or reports it. */
export function firstUseWorkspaceDeclinedPath(
  input: NataliaHomeInput = {},
): string {
  return nataliaHomeJoin(input, FIRST_USE_WORKSPACE_DECLINED_FILE);
}
