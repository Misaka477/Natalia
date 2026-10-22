import type { OperationRecord } from "@anthelia/contracts";

/**
 * The operation log's display rows (T3/T4): the telemetry zone's records,
 * read through the runtime's `operationRecords` face — the same records
 * the CLI's debug bundle reads and the query primitives filter.
 *
 * Pure shape so the row's wording is testable without a DOM. The level
 * badge is styled as a badge above; the line below carries the component
 * (the bracket-token family the operator greps for) and the message, and
 * the correlation ids ride the title — the record's own facts, nothing
 * invented.
 */

/** One row's view from a record. */
export function operationRecordLine(record: OperationRecord): {
  level: string;
  component: string;
  message: string;
  at: string;
  title: string;
} {
  const corr = record.corr ?? {};
  const corrText = Object.entries(corr)
    .map(([key, value]) => `${key}: ${value}`)
    .join(" · ");
  return {
    level: record.level,
    component: record.component,
    message: record.message,
    at: record.at,
    title: corrText
      ? `${record.component} @ ${record.at}\n${corrText}`
      : `${record.component} @ ${record.at}`,
  };
}

/**
 * The newest-N tail in display order (newest first — a telemetry panel
 * reads top-down from "just now"). The service already bounds the file;
 * this bounds the pane.
 */
export function newestOperationRecords(
  records: readonly OperationRecord[],
  limit = 60,
): OperationRecord[] {
  return records.slice(-limit).reverse();
}
