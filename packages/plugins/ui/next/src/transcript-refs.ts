/**
 * Shared transcript handles. The main and chat panes assign their
 * `Transcript` handles through ref callbacks, and the shell's
 * jump-to-bottom helpers read them. Both sides import this holder so the
 * controller can own the panes without the shell losing the handles.
 */
import type { TranscriptHandle } from "@natalia/ui-kit";

export const transcriptRefs: {
  main: TranscriptHandle | undefined;
  chat: TranscriptHandle | undefined;
} = {
  main: undefined,
  chat: undefined,
};
