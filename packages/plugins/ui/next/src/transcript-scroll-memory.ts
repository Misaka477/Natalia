/**
 * The shell's transcript scroll memory. The controller that owns the
 * panes writes the anchors as the reader scrolls and reads them back
 * when a session's history lands; the shell clears the memory when a
 * session goes away. Both sides import this holder so the controller can
 * own the behaviour without the shell losing the memory.
 */
import { TranscriptScrollMemory } from "./controllers/scroll-memory";

export const transcriptScrollMemory = new TranscriptScrollMemory();
