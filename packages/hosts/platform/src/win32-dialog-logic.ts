/**
 * The Win32 folder dialog's COM conversation, as pure sequencing over
 * injectable bindings.
 *
 * The COM surface used here — `IModalWindow` / `IFileDialog` /
 * `IFileOpenDialog` and `IShellItem` vtable order, the GUIDs, the `FOS_*` flags
 * and `SIGDN_FILESYSPATH` — is frozen Windows ABI since Vista, so the slots are
 * offsets into the vtable at the object's first pointer. The koffi-backed
 * bindings live in `win32-dialog-bindings.ts`, which only a Windows process
 * ever loads; this module loads everywhere and is testable on any platform.
 *
 * The shape is the reference harness's, deliberately: the sequencing is the
 * part with the failure modes (an HRESULT that must be checked, a COM
 * reference that must be released on every path, an apartment that must be
 * uninitialized exactly once), and it is the part worth testing without a
 * Windows host.
 */

/** `HRESULT_FROM_WIN32(ERROR_CANCELLED)`: the human dismissed the dialog. */
export const HRESULT_CANCELLED = 0x800704c7 | 0;

/** `FOS_PICKFOLDERS`: the dialog selects directories, not files. */
export const FOS_PICKFOLDERS = 0x20;
/** `FOS_FORCEFILESYSTEM`: only results carrying a filesystem path. */
export const FOS_FORCEFILESYSTEM = 0x40;
/** `FOS_NOCHANGEDIR`: never mutate the process working directory. */
export const FOS_NOCHANGEDIR = 0x8;

/**
 * What the dialog selects. A directory picker sets `FOS_PICKFOLDERS`; a file
 * picker leaves it clear and the human chooses a file. Everything else in the
 * conversation is the same, so the kind is the one difference the sequencing
 * needs to know about.
 */
export type Win32DialogKind = "directory" | "file";

/** One created folder dialog: the vtable calls the sequencing needs. */
export interface Win32FolderDialog {
  /** `IFileDialog::SetOptions`. @returns the call's HRESULT. */
  setOptions(options: number): number;
  /** `IFileDialog::SetTitle`. @returns the call's HRESULT. */
  setTitle(title: string): number;
  /**
   * `IModalWindow::Show` with no owner window; blocks the calling thread until
   * the human selects or dismisses.
   * @returns the call's HRESULT (`HRESULT_CANCELLED` on dismissal).
   */
  show(): number;
  /**
   * `IFileDialog::GetResult` plus `IShellItem::GetDisplayName` with
   * `SIGDN_FILESYSPATH`, releasing the shell item and freeing the COM string.
   * @returns the chain's HRESULT and, on success, the selected path.
   */
  resultPath(): { hr: number; path?: string };
  /** Release the dialog's COM reference. */
  release(): void;
}

/** The thread-level native surface the sequencing runs against. */
export interface Win32DialogBindings {
  /**
   * Opt the calling thread into the best supported DPI awareness
   * (per-monitor-v2, then per-monitor, then system-aware). Best-effort on
   * purpose: a host accepting none of them still shows the modern dialog,
   * possibly blurry above 100 % scaling, because a cosmetic degradation must
   * not cost the tier.
   */
  setThreadDpiAwareness(): void;
  /**
   * `CoInitializeEx(COINIT_APARTMENTTHREADED)` on the calling thread.
   * @returns the call's HRESULT (`S_FALSE` re-entry is still a success).
   */
  coInitializeSta(): number;
  /**
   * `CoUninitialize` — COM requires one pairing call for every successful
   * (including `S_FALSE`) `CoInitializeEx`, even on a thread that exits right
   * after the conversation.
   */
  coUninitialize(): void;
  /**
   * `CoCreateInstance(CLSID_FileOpenDialog)`.
   * @returns the created dialog surface; throws when creation fails.
   */
  createFolderDialog(): Win32FolderDialog;
  /**
   * `GetCurrentThreadId` — the native id a driver needs to close this thread's
   * windows from outside.
   * @returns the calling thread's native id.
   */
  currentThreadId(): number;
  /**
   * Let the dialog `Show` is about to create take the foreground. Windows
   * grants activation only to the foreground process, to a process it started,
   * or to one that received recent input; a worker spawned by a background host
   * qualifies for none, so the dialog would open behind every other window.
   * Synthesizing one Alt press counts this process as the most recent input
   * owner. Call immediately before `Show`.
   */
  pressAltForForeground(): void;
}

/**
 * Throw when an HRESULT signals failure.
 * @param hr - the HRESULT to check.
 * @param what - the failing call's name for the error message.
 * @returns the (successful) HRESULT unchanged.
 */
function check(hr: number, what: string): number {
  if (hr < 0)
    throw new Error(`${what} failed: HRESULT 0x${(hr >>> 0).toString(16)}`);
  return hr;
}

/**
 * Run one modal folder-picker conversation on the calling thread: DPI opt-in,
 * STA init, dialog creation, `Show`, and result extraction, releasing the
 * dialog on every path.
 * @param bindings - the native surface (koffi-backed in production, fakes in tests).
 * @param title - the dialog title text.
 * @param onShowing - called with the native thread id immediately before the
 *   blocking `Show`, so a driver on another thread can close the dialog.
 * @returns the selected filesystem path, or null when the human cancels.
 */
export function runFolderDialog(
  bindings: Win32DialogBindings,
  title: string,
  onShowing: (threadId: number) => void,
  kind: Win32DialogKind = "directory",
): string | null {
  bindings.setThreadDpiAwareness();
  check(bindings.coInitializeSta(), "CoInitializeEx");
  // From here the apartment is initialized (S_OK or S_FALSE) and must be
  // uninitialized exactly once on every path.
  try {
    const dialog = bindings.createFolderDialog();
    try {
      check(
        dialog.setOptions(
          // `FOS_PICKFOLDERS` is the whole difference between the two kinds:
          // set, the dialog browses directories; clear, it chooses a file.
          (kind === "directory" ? FOS_PICKFOLDERS : 0) |
            FOS_FORCEFILESYSTEM |
            FOS_NOCHANGEDIR,
        ),
        "SetOptions",
      );
      check(dialog.setTitle(title), "SetTitle");
      onShowing(bindings.currentThreadId());
      bindings.pressAltForForeground();
      const shown = dialog.show();
      if (shown === HRESULT_CANCELLED) return null;
      check(shown, "Show");
      const result = dialog.resultPath();
      check(result.hr, "GetResult");
      return result.path ?? null;
    } finally {
      dialog.release();
    }
  } finally {
    bindings.coUninitialize();
  }
}
