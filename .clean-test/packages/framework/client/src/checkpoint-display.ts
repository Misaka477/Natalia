import type { RuntimeEvent } from "@anthelia/contracts";

export function checkpointDisplayLine(event: RuntimeEvent) {
  switch (event.type) {
    case "checkpoint.created":
      return `checkpoint ${event.id} created (${event.files} files, ${event.changes} changes, ${event.complete ? "complete" : "incomplete"})`;
    case "checkpoint.failed":
      return `checkpoint failed: ${event.message}`;
    case "checkpoint.unavailable":
      return `checkpoint unavailable: ${event.reason}. ${event.suggestion}`;
    case "rollback.previewed":
      return `rollback preview ${event.preview.checkpointID}: ${event.preview.changes.length} file changes, truncate ${event.preview.context.truncateMessages} context messages`;
    case "rollback.begin":
      return `rollback ${event.checkpointID} begin (safety ${event.safetyCheckpointID})`;
    case "rollback.end":
      return `rollback ${event.checkpointID} complete (${event.restoredFiles} restored, ${event.deletedFiles} deleted, step ${event.step})`;
    case "rollback.failed":
      return `rollback ${event.checkpointID} failed: ${event.message} (${event.recovered ? "safety restored" : "safety restore failed"})`;
    default:
      return undefined;
  }
}
