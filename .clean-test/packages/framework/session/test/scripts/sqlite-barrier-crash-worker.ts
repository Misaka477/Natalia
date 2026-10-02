import type { SessionID } from "@anthelia/contracts";
import { SqliteSessionStore } from "../../src";

const [path, id] = process.argv.slice(2);
if (!path || !id) throw new Error("expected database path and session id");
const sessionID = id as SessionID;
const store = new SqliteSessionStore(path);
store.create(sessionID, "barrier crash worker");
store.enqueueEvent(sessionID, {
  type: "turn.submitted",
  id: "turn_crash_barrier",
  text: "persist before crash",
  byteLength: 20,
  lineCount: 1,
  sha256: "fixture",
});
store.enqueueEvent(sessionID, {
  type: "turn.finished",
  id: "turn_crash_barrier",
  stopReason: "done",
});
await store.flushPendingWrites(sessionID);
// Deliberately omit close(): this is an ungraceful process termination after
// the confirmed settlement barrier, not a clean WAL shutdown.
process.exit(91);
